import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import type { CapacityCoordinator, RateLimitCheck } from "@relay/capacity";
import type { RuntimeConfig } from "@relay/config";
import {
  createDatabasePool,
  type DatabasePool,
  MIGRATIONS,
} from "@relay/database";
import {
  admitToolRun,
  type ClaimedJob,
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
  acquireReadyConsumer,
  ArtifactMaintenanceOwner,
  checkWorkerReadiness,
  type ClosableWorker,
  CoordinatorAdapter,
  createExecutionHandlerRegistry,
  gracefullyCloseWorkers,
  restoreDurableRedisLease,
  startWorker,
} from "./worker.ts";

const WORKER_CONFIG: RuntimeConfig = {
  appName: "Relay Worker Test",
  deploymentEnvironment: "test",
  port: 8_000,
  build: { version: "test", revision: "test" },
  database: {
    url: new URL("postgres://relay:test@localhost:5432/relay"),
    poolMax: 2,
    connectTimeoutMs: 100,
    statementTimeoutMs: 100,
  },
  redis: {
    url: new URL("redis://localhost:6379"),
    connectTimeoutMs: 100,
  },
};

function claimedJob(
  providerPerMinute: number | null,
  toolPerMinute: number | null,
): ClaimedJob {
  return {
    jobId: "job-1",
    runId: "run-1",
    leaseEpoch: 1,
    dispatchGeneration: 0,
    workspaceId: "workspace-1",
    toolVersionId: "tool-version-1",
    toolId: "tool-1",
    toolKey: "image.generate",
    providerModelId: "provider-model-1",
    capacityPoolId: "pool-1",
    capacityPoolKey: "pool-key-1",
    capacityUnits: 1,
    policyVersion: 1,
    capacityPolicyRevision: 7,
    capacityLimits: {
      globalTool: 1,
      pool: 1,
      workspaceTotal: 1,
      workspaceTool: 1,
    },
    submissionRatePolicy: {
      providerPerMinute,
      toolPerMinute,
      capacityPoolRevision: 7,
      toolRevision: toolPerMinute === null ? null : 3,
    },
    previousRetryClassification: null,
    previousProviderOperationId: null,
  };
}

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

Deno.test("coordinator adapter constructs configured GCRA checks", async () => {
  const calls: Array<{
    readonly poolId: string;
    readonly checks: readonly RateLimitCheck[];
  }> = [];
  const coordinator = {
    rateKeys: {
      provider: (providerModelId: string) => `provider:${providerModelId}`,
      tool: (toolKey: string) => `tool:${toolKey}`,
    },
    acquireSubmissionPermit(
      poolId: string,
      checks: readonly RateLimitCheck[],
    ) {
      calls.push({ poolId, checks });
      return Promise.resolve({ ok: true });
    },
  } as unknown as CapacityCoordinator;
  const adapter = new CoordinatorAdapter(
    coordinator,
    1_000,
    "worker-rate-test",
  );

  assertEquals(
    await adapter.acquireSubmissionPermit(claimedJob(12, 4)),
    { kind: "acquired" },
  );
  assertEquals(
    await adapter.acquireSubmissionPermit(claimedJob(4, null)),
    { kind: "acquired" },
  );
  assertEquals(
    await adapter.acquireSubmissionPermit(claimedJob(50, null)),
    { kind: "acquired" },
  );
  assertEquals(calls, [
    {
      poolId: "pool-1",
      checks: [
        {
          key: "provider:provider-model-1",
          emissionIntervalMs: 5_000,
          burstMs: 0,
          cost: 1,
        },
        {
          key: "tool:image.generate",
          emissionIntervalMs: 15_000,
          burstMs: 0,
          cost: 1,
        },
      ],
    },
    {
      poolId: "pool-1",
      checks: [{
        key: "provider:provider-model-1",
        emissionIntervalMs: 15_000,
        burstMs: 0,
        cost: 1,
      }],
    },
    {
      poolId: "pool-1",
      checks: [{
        key: "provider:provider-model-1",
        emissionIntervalMs: 1_200,
        burstMs: 0,
        cost: 1,
      }],
    },
  ]);
});

Deno.test("coordinator adapter passes a relative provider cooldown duration", async () => {
  const cooldowns: Array<
    { readonly poolId: string; readonly durationMs: number }
  > = [];
  const coordinator = {
    setProviderCooldown(poolId: string, durationMs: number) {
      cooldowns.push({ poolId, durationMs });
      return Promise.resolve(true);
    },
  } as unknown as CapacityCoordinator;
  const adapter = new CoordinatorAdapter(
    coordinator,
    1_000,
    "worker-cooldown-test",
    () => 10_000,
  );
  const job = claimedJob(12, null);

  await adapter.setProviderCooldown(job, new Date(12_500));
  await adapter.setProviderCooldown(job, new Date(9_000));

  assertEquals(cooldowns, [
    { poolId: "pool-1", durationMs: 2_500 },
    { poolId: "pool-1", durationMs: 1 },
  ]);
});

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

Deno.test("consumer resources are owned before readiness can fail", async () => {
  const order: string[] = [];
  const connection = { name: "consumer-redis" };
  const consumer = {
    waitUntilReady() {
      order.push("wait");
      return Promise.reject(new Error("injected readiness failure"));
    },
  };

  await assertRejects(
    () =>
      acquireReadyConsumer(
        () => {
          order.push("create connection");
          return connection;
        },
        (ownedConnection) => {
          assertStrictEquals(ownedConnection, connection);
          order.push("own connection");
        },
        (workerConnection) => {
          assertStrictEquals(workerConnection, connection);
          order.push("create consumer");
          return consumer;
        },
        (ownedConsumer) => {
          assertStrictEquals(ownedConsumer, consumer);
          order.push("own consumer");
        },
      ),
    Error,
    "injected readiness failure",
  );

  assertEquals(order, [
    "create connection",
    "own connection",
    "create consumer",
    "own consumer",
    "wait",
  ]);
});

Deno.test("maintenance ownership stops once and waits for termination", async () => {
  let finishMaintenance: (() => void) | undefined;
  let startCount = 0;
  let stopCount = 0;
  let unexpectedStops = 0;
  const owner = new ArtifactMaintenanceOwner(
    {
      start() {
        startCount += 1;
        return new Promise<void>((resolve) => {
          finishMaintenance = resolve;
        });
      },
      stop() {
        stopCount += 1;
        return Promise.resolve();
      },
    },
    () => {
      unexpectedStops += 1;
    },
  );

  const startTask = owner.start();
  assertStrictEquals(owner.start(), startTask);
  const firstTermination = owner.terminate();
  assertStrictEquals(owner.terminate(), firstTermination);
  await Promise.resolve();

  assertEquals(startCount, 1);
  assertEquals(stopCount, 1);
  assertEquals(owner.terminated, false);

  finishMaintenance?.();
  await firstTermination;

  assertEquals(owner.terminated, true);
  assertEquals(unexpectedStops, 0);
  assertEquals(stopCount, 1);
});

Deno.test("bootstrap failure disposes every acquired resource exactly once", async () => {
  let signalAdds = 0;
  let signalRemoves = 0;
  let poolEnds = 0;
  let metricsDisposals = 0;
  let queueCloses = 0;
  const quitCounts = [0, 0, 0, 0];
  const disconnectCounts = [0, 0, 0, 0];
  const rejectQuits: Array<(reason?: unknown) => void> = [];
  let redisCreated = 0;
  const signal = {
    aborted: false,
    addEventListener() {
      signalAdds += 1;
    },
    removeEventListener() {
      signalRemoves += 1;
    },
  } as unknown as AbortSignal;
  const pool = {
    end() {
      poolEnds += 1;
      return Promise.resolve();
    },
  } as unknown as DatabasePool;

  await assertRejects(
    () =>
      startWorker(
        WORKER_CONFIG,
        {
          signal,
          installSignalHandlers: false,
          shutdownDeadlineMs: 5,
          telemetry: {} as never,
          log: () => undefined,
        },
        {
          createDatabasePool: () => pool,
          createWorkerRuntimeMetrics: (() => ({
            dispose() {
              metricsDisposals += 1;
            },
          })) as never,
          createRedisConnection: (() => {
            const index = redisCreated;
            redisCreated += 1;
            return {
              status: "ready",
              quit() {
                quitCounts[index] += 1;
                return new Promise<void>((_resolve, reject) => {
                  rejectQuits[index] = reject;
                });
              },
              disconnect() {
                disconnectCounts[index] += 1;
              },
            } as unknown as Redis;
          }) as never,
          createExecutionQueueRegistry: () =>
            ({
              close() {
                queueCloses += 1;
                return Promise.resolve();
              },
            }) as never,
          createRedisDispatchGate() {
            throw new Error("injected bootstrap failure");
          },
        },
      ),
    Error,
    "injected bootstrap failure",
  );

  for (const reject of rejectQuits) reject(new Error("late quit failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(signalAdds, 1);
  assertEquals(signalRemoves, 1);
  assertEquals(poolEnds, 1);
  assertEquals(metricsDisposals, 1);
  assertEquals(queueCloses, 1);
  assertEquals(quitCounts, [1, 1, 1, 1]);
  assertEquals(disconnectCounts, [1, 1, 1, 1]);
});

Deno.test("bootstrap failure preserves injected pool ownership", async () => {
  let poolCreates = 0;
  let poolEnds = 0;
  let metricsDisposals = 0;
  const pool = {
    end() {
      poolEnds += 1;
      return Promise.resolve();
    },
  } as unknown as DatabasePool;

  await assertRejects(
    () =>
      startWorker(
        WORKER_CONFIG,
        {
          pool,
          installSignalHandlers: false,
          shutdownDeadlineMs: 100,
          telemetry: {} as never,
          log: () => undefined,
        },
        {
          createDatabasePool() {
            poolCreates += 1;
            throw new Error("owned pool factory must not run");
          },
          createWorkerRuntimeMetrics: (() => ({
            dispose() {
              metricsDisposals += 1;
            },
          })) as never,
          createRedisConnection() {
            throw new Error("injected Redis construction failure");
          },
        },
      ),
    Error,
    "injected Redis construction failure",
  );

  assertEquals(poolCreates, 0);
  assertEquals(poolEnds, 0);
  assertEquals(metricsDisposals, 1);
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

Deno.test("worker readiness includes database, migrations, Redis, and storage", async () => {
  const queries: string[] = [];
  const pool = {
    query(text: string) {
      queries.push(text);
      if (text === "select 1") return Promise.resolve({ rows: [{}] });
      return Promise.resolve({
        rows: MIGRATIONS.map((migration) => ({
          id: migration.id,
          checksum_sha256: migration.checksumSha256,
        })),
      });
    },
  } as unknown as DatabasePool;
  let redisPings = 0;
  let storageChecks = 0;
  const redis = [
    {
      ping: () => {
        redisPings += 1;
        return Promise.resolve("PONG");
      },
    },
    {
      ping: () => {
        redisPings += 1;
        return Promise.resolve("PONG");
      },
    },
  ];

  assertEquals(
    await checkWorkerReadiness(pool, redis as never, [() => {
      storageChecks += 1;
      return Promise.resolve({ name: "storage", status: "ok" });
    }]),
    [
      { name: "database", status: "ok" },
      { name: "migrations", status: "ok" },
      { name: "redis", status: "ok" },
      { name: "storage", status: "ok" },
    ],
  );
  assertEquals(queries.length, 2);
  assertEquals(redisPings, 2);
  assertEquals(storageChecks, 1);
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
      deploymentEnvironment: environment,
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
