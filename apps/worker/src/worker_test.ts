import { assert, assertEquals } from "@std/assert";
import type { RuntimeConfig } from "@relay/config";
import { createDatabasePool } from "@relay/database";
import {
  admitToolRun,
  type DurableCapacityLease,
  ExecutionQueueRegistry,
} from "@relay/queue";
import { schedulerKeys } from "@relay/scheduler";
import { Redis } from "ioredis";
import {
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
  TEST_USAGE_PORT,
} from "../../../packages/queue/src/test_support.ts";
import {
  type ClosableWorker,
  createExecutionHandlerRegistry,
  gracefullyCloseWorkers,
  restoreDurableRedisLease,
  startWorker,
} from "./worker.ts";

class FakeWorker implements ClosableWorker {
  paused = false;
  closeForce: boolean | undefined;

  pause(doNotWaitActive?: boolean): Promise<void> {
    this.paused = doNotWaitActive === true;
    return Promise.resolve();
  }

  close(force?: boolean): Promise<void> {
    this.closeForce = force;
    return Promise.resolve();
  }
}

Deno.test("graceful shutdown pauses intake and drains before non-forced close", async () => {
  const worker = new FakeWorker();
  let aborted = false;
  const result = await gracefullyCloseWorkers(
    [worker],
    () => Promise.resolve(),
    () => {
      aborted = true;
    },
    100,
  );
  assertEquals(result, { forced: false });
  assertEquals(worker.paused, true);
  assertEquals(worker.closeForce, false);
  assertEquals(aborted, false);
});

Deno.test("shutdown aborts active handlers and force-closes after its deadline", async () => {
  const worker = new FakeWorker();
  let aborted = false;
  const result = await gracefullyCloseWorkers(
    [worker],
    () => new Promise<void>(() => {}),
    () => {
      aborted = true;
    },
    5,
  );
  assertEquals(result, { forced: true });
  assertEquals(worker.paused, true);
  assertEquals(worker.closeForce, true);
  assertEquals(aborted, true);
});

Deno.test("shutdown budget includes a stuck pause operation", async () => {
  class StuckPauseWorker extends FakeWorker {
    override pause(): Promise<void> {
      return new Promise<void>(() => {});
    }
  }

  const worker = new StuckPauseWorker();
  let aborted = false;
  const startedAt = Date.now();
  const result = await gracefullyCloseWorkers(
    [worker],
    () => new Promise<void>(() => {}),
    () => {
      aborted = true;
    },
    20,
  );
  assertEquals(result, { forced: true });
  assertEquals(aborted, true);
  assert(Date.now() - startedAt < 500);
});

const redisUrl = Deno.env.get("REDIS_URL");

Deno.test({
  name: "capacity rehydration keeps a shared scope alive for its latest lease",
  ignore: redisUrl === undefined,
  fn: async () => {
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const environment = `worker-restore-${crypto.randomUUID()}`;
    const scopeKey = `relay:${environment}:{capacity}:active:tool:test`;
    const [seconds, microseconds] = await redis.time();
    const now = Number(seconds) * 1_000 +
      Math.floor(Number(microseconds) / 1_000);
    const lease = (
      jobId: string,
      redisLeaseId: string,
      expiresAt: number,
    ): DurableCapacityLease => ({
      databaseLeaseId: crypto.randomUUID(),
      redisLeaseId,
      redisScopeKeys: [scopeKey],
      expiresAt: new Date(expiresAt),
      ownerId: "worker-restore",
      jobId,
      leaseEpoch: 1,
      units: 1,
    });

    try {
      await restoreDurableRedisLease(
        redis,
        environment,
        lease("job-long", "lease-long", now + 10_000),
      );
      await restoreDurableRedisLease(
        redis,
        environment,
        lease("job-short", "lease-short", now + 5_000),
      );

      assert((await redis.pttl(scopeKey)) > 7_000);
      assertEquals(await redis.zcard(scopeKey), 2);
    } finally {
      const keys = await redis.keys(`relay:${environment}:*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    }
  },
});

Deno.test("worker handler registry may start empty without installing fake work", () => {
  const handlers = createExecutionHandlerRegistry();
  assertEquals(handlers.keys.size, 0);
  assertEquals(handlers.catalogHandlers.keys.size, 0);
});

const databaseUrl = Deno.env.get("DATABASE_URL");

Deno.test({
  name:
    "empty handler worker rebuilds scheduler backlog without dispatching it",
  ignore: databaseUrl === undefined || redisUrl === undefined,
  fn: async () => {
    const pool = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 5,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-worker",
    );
    const fixture = await createAdmissibleFixture(pool);
    const environment = `empty-registry-${crypto.randomUUID()}`;
    const queuePrefix = `relay:${environment}:bullmq`;
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const queues = new ExecutionQueueRegistry(redis, queuePrefix);
    const abort = new AbortController();
    const config: RuntimeConfig = {
      appName: "Relay Test",
      port: 8_000,
      build: { version: "test", revision: "test" },
      database: {
        url: new URL(databaseUrl!),
        poolMax: 5,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      redis: {
        url: new URL(redisUrl!),
        connectTimeoutMs: 5_000,
      },
    };
    let started: (() => void) | undefined;
    const workerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let workerPromise: Promise<void> | undefined;
    let workerError: unknown;
    try {
      const admitted = await admitToolRun(
        pool,
        {
          workspaceId: fixture.workspaceId,
          toolVersionId: fixture.toolVersionId,
          createdBy: fixture.createdBy,
          input: { prompt: "hold without handlers" },
          idempotencyKey: `empty-worker-${crypto.randomUUID()}`,
          admissionDeadlineMs: 60_000,
          runDeadlineMs: 300_000,
        },
        { handlers: fixture.handlers, usage: TEST_USAGE_PORT },
      );
      if (admitted.kind !== "admitted") {
        throw new Error("fixture admission failed");
      }
      const capacityPool = await pool.query<{ key: string }>(
        "select key from relay.capacity_pools where id = $1",
        [fixture.capacityPoolId],
      );

      workerPromise = startWorker(config, {
        handlerRegistry: createExecutionHandlerRegistry(),
        signal: abort.signal,
        installSignalHandlers: false,
        instanceId: `empty-worker-${crypto.randomUUID()}`,
        environment,
        queuePrefix,
        relayPollIntervalMs: 20,
        schedulerPollIntervalMs: 10,
        maintenanceIntervalMs: 10_000,
        reconciliationLockMs: 500,
        redisResetCooldownMs: 0,
        shutdownDeadlineMs: 2_000,
        log: (record) => {
          if (record.message === "Worker started") started?.();
        },
      });
      let startupTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          workerStarted,
          new Promise<never>((_, reject) => {
            startupTimeout = setTimeout(
              () => reject(new Error("worker startup timed out")),
              5_000,
            );
          }),
        ]);
      } finally {
        if (startupTimeout !== undefined) clearTimeout(startupTimeout);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));

      assertEquals(
        await redis.hexists(
          schedulerKeys(environment).jobs,
          admitted.jobId,
        ),
        1,
      );
      assertEquals(
        await queues.waitingCount(capacityPool.rows[0].key),
        0,
      );
      const job = await pool.query<{ status: string }>(
        "select status from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      assertEquals(job.rows[0].status, "queued");
    } finally {
      abort.abort();
      if (workerPromise !== undefined) {
        try {
          await workerPromise;
        } catch (error) {
          workerError = error;
        }
      }
      await queues.close();
      const keys = await redis.keys(`relay:${environment}:*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
    if (workerError !== undefined) throw workerError;
  },
});
