import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { Redis } from "ioredis";
import {
  loadSchedulingClassProfiles,
  WeightedFairScheduler,
} from "@relay/scheduler";
import {
  createExecutionHandlerRegistry,
  createRegistryBackedExecutionHandler,
} from "../../../apps/worker/src/handlers.ts";
import { type AdmitRunInput, admitToolRun } from "./admission.ts";
import { relayOutboxBatch } from "./outbox-relay.ts";
import { createExecutionWorker, ExecutionQueueRegistry } from "./bullmq.ts";
import { ExecutionProcessor } from "./processor.ts";
import { ExecutionSchedulerBridge } from "./scheduler-bridge.ts";
import {
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
  TEST_USAGE_PORT,
} from "./test_support.ts";

/**
 * The full write path in one test: an admission creates a durable
 * run/job/outbox row (admission.ts, now also authorizing against a real
 * workspace membership and a real published catalog tool version), the
 * outbox relay claims and publishes it (outbox-relay.ts) as a real
 * scheduler entry, bounded BullMQ ticket, and real ExecutionProcessor claim.
 * The registry-backed handler revalidates the immutable route before execution.
 */
const databaseUrl = Deno.env.get("DATABASE_URL");
const redisUrl = Deno.env.get("REDIS_URL");
const hasInfra = databaseUrl !== undefined && redisUrl !== undefined;

function testPool(): DatabasePool {
  return createDatabasePool(
    {
      url: new URL(databaseUrl!),
      poolMax: 5,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
    },
    "relay-worker",
  );
}

function unique(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

Deno.test({
  name:
    "admission -> outbox -> BullMQ -> processor completes one attempt end to end",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);

    const input: AdmitRunInput = {
      workspaceId: fixture.workspaceId,
      toolVersionId: fixture.toolVersionId,
      createdBy: fixture.createdBy,
      input: { prompt: "a cat wearing a hat" },
      idempotencyKey: unique("idem"),
      admissionDeadlineMs: 60_000,
      runDeadlineMs: 300_000,
    };

    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const schedulerRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const capacityPool = await pool.query<{ key: string }>(
      "select key from relay.capacity_pools where id = $1",
      [fixture.capacityPoolId],
    );
    const capacityPoolKey = capacityPool.rows[0].key;
    const environment = unique("pipeline");
    const prefix = `relay:${environment}:bullmq`;
    const queues = new ExecutionQueueRegistry(connection, prefix);
    const scheduler = new WeightedFairScheduler(schedulerRedis, {
      env: environment,
      dispatchLeaseDurationMs: 30_000,
      maxCostUnits: 100,
    });
    await scheduler.configureProfiles(await loadSchedulingClassProfiles(pool));
    const bridge = new ExecutionSchedulerBridge(
      pool,
      schedulerRedis,
      scheduler,
      queues,
      {
        environment,
        maxBullmqWaitingPerPool: 2,
        maxDispatchesPerIteration: 2,
        bufferRetryDelayMs: 50,
        poolBufferLockDurationMs: 5_000,
      },
    );

    let handlerCalls = 0;
    let releasedLeases = 0;
    const executionHandlers = createExecutionHandlerRegistry([{
      key: fixture.handlerKey,
      inputSchemaVersion: 1,
      handlerVersion: "1",
      execute: () => {
        handlerCalls += 1;
        return Promise.resolve({ kind: "succeeded" });
      },
    }]);
    const executionProcessor = new ExecutionProcessor(
      pool,
      {
        acquire: (job) =>
          Promise.resolve({
            kind: "acquired" as const,
            lease: {
              leaseId: crypto.randomUUID(),
              scopeKeys: [unique("scope")],
              expiresAt: new Date(Date.now() + 30_000),
              ownerId: "pipeline-worker",
              jobId: job.jobId,
              leaseEpoch: job.leaseEpoch,
              units: job.capacityUnits,
              jobKey: `job-${job.jobId}`,
            },
          }),
        acquireSubmissionPermit: () =>
          Promise.resolve({ kind: "acquired" as const }),
        setProviderCooldown: () => Promise.resolve(),
        renew: () =>
          Promise.resolve({
            ok: true,
            expiresAt: new Date(Date.now() + 30_000),
          }),
        release: () => {
          releasedLeases += 1;
          return Promise.resolve();
        },
      },
      {
        isReady: () => Promise.resolve(true),
        readyToken: () => Promise.resolve("ready:pipeline"),
      },
      createRegistryBackedExecutionHandler(pool, executionHandlers),
      {
        leaseOwner: "pipeline-worker",
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 10_000,
        coordinationRetryMs: 100,
        maxDeferralJitterMs: 0,
      },
    );
    const workerConnection = new Redis(redisUrl!, {
      maxRetriesPerRequest: null,
    });
    const worker = createExecutionWorker(
      workerConnection,
      capacityPoolKey,
      prefix,
      executionProcessor.processor,
    );

    let admitted: Awaited<ReturnType<typeof admitToolRun>> | undefined;
    try {
      const ready = new Promise<void>((resolve) =>
        worker.once("ready", resolve)
      );
      worker.run();
      await ready;

      admitted = await admitToolRun(pool, input, {
        handlers: executionHandlers.catalogHandlers,
        usage: TEST_USAGE_PORT,
      });
      assertEquals(admitted.kind, "admitted");
      if (admitted.kind !== "admitted") throw new Error("unreachable");
      const jobId = admitted.jobId;

      const relayResult = await relayOutboxBatch(
        pool,
        (event) => bridge.handleOutboxEvent(event),
        {
          leaseOwner: "test-pipeline",
          leaseDurationMs: 30_000,
          batchSize: 10,
          eventTypes: ["job.ready", "job.deferred"],
        },
      );
      assertEquals(
        relayResult.published >= 1,
        true,
        "the outbox relay must publish at least the row this admission created",
      );

      assertEquals(await queues.waitingCount(capacityPoolKey), 0);
      const dispatch = await bridge.dispatchBatch("pipeline-scheduler");
      assertEquals(dispatch.published, 1);

      const deadline = Date.now() + 10_000;
      let state: { status: string; attempt_count: number } | undefined;
      while (Date.now() < deadline) {
        const result = await pool.query<{
          status: string;
          attempt_count: number;
        }>(
          "select status, attempt_count from relay.execution_jobs where id = $1",
          [jobId],
        );
        state = result.rows[0];
        if (state?.status === "succeeded" && releasedLeases === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assertEquals(state, { status: "succeeded", attempt_count: 1 });
      assertEquals(handlerCalls, 1);
      assertEquals(releasedLeases, 1);
    } finally {
      await worker.close();
      await queues.close();
      await connection.quit();
      await workerConnection.quit();
      const schedulerKeys = await schedulerRedis.keys(`relay:${environment}:*`);
      if (schedulerKeys.length > 0) await schedulerRedis.del(...schedulerKeys);
      await schedulerRedis.quit();
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});
