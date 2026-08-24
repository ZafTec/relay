import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import {
  loadSchedulingClassProfiles,
  schedulerKeys,
  WeightedFairScheduler,
} from "@relay/scheduler";
import { Redis } from "ioredis";
import { type AdmitRunInput, admitToolRun } from "./admission.ts";
import { ExecutionQueueRegistry } from "./bullmq.ts";
import { requestJobCancellation } from "./dispatch.ts";
import { relayOutboxBatch } from "./outbox-relay.ts";
import { reconcileRedisReset, RedisDispatchGate } from "./reconciliation.ts";
import {
  ExecutionSchedulerBridge,
  loadScheduledExecution,
} from "./scheduler-bridge.ts";
import {
  type AdmissibleFixture,
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
  setQueueLimits,
  TEST_USAGE_PORT,
} from "./test_support.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const redisUrl = Deno.env.get("REDIS_URL");
const hasInfra = databaseUrl !== undefined && redisUrl !== undefined;

function testPool(): DatabasePool {
  return createDatabasePool(
    {
      url: new URL(databaseUrl!),
      poolMax: 8,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
    },
    "relay-worker",
  );
}

async function admit(
  pool: DatabasePool,
  fixture: AdmissibleFixture,
  label: string,
) {
  const input: AdmitRunInput = {
    workspaceId: fixture.workspaceId,
    toolVersionId: fixture.toolVersionId,
    createdBy: fixture.createdBy,
    input: { label },
    idempotencyKey: `${label}-${crypto.randomUUID()}`,
    admissionDeadlineMs: 60_000,
    runDeadlineMs: 300_000,
  };
  const result = await admitToolRun(pool, input, {
    handlers: fixture.handlers,
    usage: TEST_USAGE_PORT,
  });
  if (result.kind !== "admitted") throw new Error("fixture admission failed");
  return result;
}

async function setupBridge(
  pool: DatabasePool,
  waitingLimit: number,
  dispatchBatchSize = 20,
) {
  const environment = `scheduler-bridge-${crypto.randomUUID()}`;
  const producer = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  const schedulerRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  const queues = new ExecutionQueueRegistry(
    producer,
    `relay:${environment}:bullmq`,
  );
  const scheduler = new WeightedFairScheduler(schedulerRedis, {
    env: environment,
    dispatchLeaseDurationMs: 5_000,
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
      maxBullmqWaitingPerPool: waitingLimit,
      maxDispatchesPerIteration: dispatchBatchSize,
      bufferRetryDelayMs: 50,
      poolBufferLockDurationMs: 5_000,
    },
  );
  return { environment, producer, schedulerRedis, queues, scheduler, bridge };
}

async function cleanupBridge(
  environment: string,
  producer: Redis,
  schedulerRedis: Redis,
  queues: ExecutionQueueRegistry,
): Promise<void> {
  await queues.close();
  const keys = await producer.keys(`relay:${environment}:*`);
  if (keys.length > 0) await producer.del(...keys);
  await producer.quit();
  await schedulerRedis.quit();
}

Deno.test({
  name: "scheduler bridge keeps the BullMQ waiting buffer shallow",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);
    const runtime = await setupBridge(pool, 1, 10);
    try {
      const admitted = await Promise.all([
        admit(pool, fixture, "shallow-a"),
        admit(pool, fixture, "shallow-b"),
        admit(pool, fixture, "shallow-c"),
      ]);
      for (const job of admitted) {
        const execution = await loadScheduledExecution(pool, job.jobId, 0);
        if (execution === null) throw new Error("scheduled execution missing");
        await runtime.bridge.enqueue(execution.payload);
      }

      const result = await runtime.bridge.dispatchBatch("scheduler-a");
      assertEquals(result.published, 1);
      for (const job of admitted) {
        const execution = await loadScheduledExecution(pool, job.jobId, 0);
        if (execution === null) throw new Error("scheduled execution missing");
        assertEquals(
          (await runtime.bridge.enqueue(execution.payload))?.kind,
          "duplicate",
        );
      }
      const capacityPool = await pool.query<{ key: string }>(
        "select key from relay.capacity_pools where id = $1",
        [fixture.capacityPoolId],
      );
      assertEquals(
        await runtime.queues.waitingCount(capacityPool.rows[0].key),
        1,
      );
    } finally {
      await cleanupBridge(
        runtime.environment,
        runtime.producer,
        runtime.schedulerRedis,
        runtime.queues,
      );
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "Redis-loss rebuild restores every durable queued scheduler entry",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);
    const runtime = await setupBridge(pool, 4, 4);
    try {
      const admitted = await admit(pool, fixture, "reset-rebuild");
      const keys = await runtime.schedulerRedis.keys(
        `relay:${runtime.environment}:*:scheduler*`,
      );
      if (keys.length > 0) await runtime.schedulerRedis.del(...keys);
      await runtime.scheduler.configureProfiles(
        await loadSchedulingClassProfiles(pool),
      );

      const rebuilt = await runtime.bridge.rebuildAll();
      assertEquals(rebuilt.enqueued, 1);
      const next = await runtime.scheduler.claimNext("scheduler-after-reset");
      assertEquals(next.kind, "leased");
      if (next.kind === "leased") {
        assertEquals(next.lease.jobId, admitted.jobId);
        await runtime.scheduler.releaseDispatchLease(next.lease);
      }
    } finally {
      await cleanupBridge(
        runtime.environment,
        runtime.producer,
        runtime.schedulerRedis,
        runtime.queues,
      );
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "multiple scheduler replicas publish each generation once",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);
    const runtime = await setupBridge(pool, 20, 20);
    await setQueueLimits(pool, fixture.toolId, {
      globalTool: 20,
      workspaceTotal: 20,
      workspaceTool: 20,
    });
    const secondRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const secondScheduler = new WeightedFairScheduler(secondRedis, {
      env: runtime.environment,
      dispatchLeaseDurationMs: 5_000,
      maxCostUnits: 100,
    });
    await secondScheduler.configureProfiles(
      await loadSchedulingClassProfiles(pool),
    );
    const second = new ExecutionSchedulerBridge(
      pool,
      secondRedis,
      secondScheduler,
      runtime.queues,
      {
        environment: runtime.environment,
        maxBullmqWaitingPerPool: 20,
        maxDispatchesPerIteration: 20,
        bufferRetryDelayMs: 50,
        poolBufferLockDurationMs: 5_000,
      },
    );
    try {
      const admitted = await Promise.all(
        Array.from(
          { length: 8 },
          (_, index) => admit(pool, fixture, `replica-${index}`),
        ),
      );
      for (const job of admitted) {
        const execution = await loadScheduledExecution(pool, job.jobId, 0);
        if (execution === null) throw new Error("scheduled execution missing");
        await runtime.bridge.enqueue(execution.payload);
      }

      let published = 0;
      for (let round = 0; round < 10 && published < 8; round++) {
        const [firstResult, secondResult] = await Promise.all([
          runtime.bridge.dispatchBatch("scheduler-a"),
          second.dispatchBatch("scheduler-b"),
        ]);
        published += firstResult.published + secondResult.published;
        if (published < 8) {
          await new Promise((resolve) => setTimeout(resolve, 75));
        }
      }
      assertEquals(published, 8);
      const capacityPool = await pool.query<{ key: string }>(
        "select key from relay.capacity_pools where id = $1",
        [fixture.capacityPoolId],
      );
      assertEquals(
        await runtime.queues.waitingCount(capacityPool.rows[0].key),
        8,
      );
    } finally {
      await secondRedis.quit();
      await cleanupBridge(
        runtime.environment,
        runtime.producer,
        runtime.schedulerRedis,
        runtime.queues,
      );
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "BullMQ publication failure releases the fenced scheduler lease",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);
    const runtime = await setupBridge(pool, 2, 2);
    const failingBridge = new ExecutionSchedulerBridge(
      pool,
      runtime.schedulerRedis,
      runtime.scheduler,
      {
        publish: () => Promise.reject(new Error("BullMQ unavailable")),
        cancel: () => Promise.resolve(),
        waitingCount: () => Promise.resolve(0),
        hasRunnableTicket: () => Promise.resolve(false),
      },
      {
        environment: runtime.environment,
        maxBullmqWaitingPerPool: 2,
        maxDispatchesPerIteration: 1,
        bufferRetryDelayMs: 50,
        poolBufferLockDurationMs: 5_000,
      },
    );
    try {
      const admitted = await admit(pool, fixture, "publish-failure");
      const execution = await loadScheduledExecution(pool, admitted.jobId, 0);
      if (execution === null) throw new Error("scheduled execution missing");
      await runtime.bridge.enqueue(execution.payload);

      const failed = await failingBridge.dispatchBatch("scheduler-failed");
      assertEquals(failed.failed, 1);
      assertEquals(failed.published, 0);
      await new Promise((resolve) => setTimeout(resolve, 75));
      const replacement = await runtime.scheduler.claimNext(
        "scheduler-replacement",
      );
      assertEquals(replacement.kind, "leased");
      if (replacement.kind === "leased") {
        assertEquals(replacement.lease.jobId, admitted.jobId);
        await runtime.scheduler.releaseDispatchLease(replacement.lease);
      }
    } finally {
      await cleanupBridge(
        runtime.environment,
        runtime.producer,
        runtime.schedulerRedis,
        runtime.queues,
      );
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "reconciliation rearms a dispatched tombstone after ticket loss",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);
    const runtime = await setupBridge(pool, 2, 2);
    try {
      const admitted = await admit(pool, fixture, "rearm");
      const execution = await loadScheduledExecution(pool, admitted.jobId, 0);
      if (execution === null) throw new Error("scheduled execution missing");
      await runtime.bridge.enqueue(execution.payload);
      assertEquals(
        (await runtime.bridge.dispatchBatch("scheduler-a")).published,
        1,
      );
      await runtime.queues.cancel(execution.payload);
      assertEquals(
        await runtime.queues.hasRunnableTicket(execution.payload),
        false,
      );

      const rebuilt = await runtime.bridge.rebuildAll();
      assertEquals(rebuilt.rearmed, 1);
      const job = await pool.query<{ dispatch_generation: number }>(
        "select dispatch_generation from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      assertEquals(job.rows[0].dispatch_generation, 1);
      const next = await runtime.scheduler.claimNext("scheduler-b");
      assertEquals(next.kind, "leased");
      if (next.kind === "leased") {
        assertEquals(next.lease.dispatchGeneration, 1);
        await runtime.scheduler.releaseDispatchLease(next.lease);
      }
    } finally {
      await cleanupBridge(
        runtime.environment,
        runtime.producer,
        runtime.schedulerRedis,
        runtime.queues,
      );
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "durable cancellation removes the scheduler entry before dispatch",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);
    const runtime = await setupBridge(pool, 2, 2);
    try {
      const admitted = await admit(pool, fixture, "cancel");
      const execution = await loadScheduledExecution(pool, admitted.jobId, 0);
      if (execution === null) throw new Error("scheduled execution missing");
      await runtime.bridge.enqueue(execution.payload);
      assertEquals(await requestJobCancellation(pool, admitted.jobId), {
        kind: "requested",
        running: false,
      });
      await relayOutboxBatch(
        pool,
        (event) => runtime.bridge.handleOutboxEvent(event),
        {
          leaseOwner: "scheduler-cancel-relay",
          eventTypes: ["job.cancelled"],
        },
      );
      assertEquals(
        (await runtime.scheduler.claimNext("scheduler-a")).kind,
        "empty",
      );
    } finally {
      await cleanupBridge(
        runtime.environment,
        runtime.producer,
        runtime.schedulerRedis,
        runtime.queues,
      );
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "scheduler rebuild repairs a same-generation job with lost indexes",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);
    const runtime = await setupBridge(pool, 2, 2);
    try {
      const admitted = await admit(pool, fixture, "partial-index-loss");
      const execution = await loadScheduledExecution(pool, admitted.jobId, 0);
      if (execution === null) throw new Error("scheduled execution missing");
      await runtime.bridge.enqueue(execution.payload);

      const keys = schedulerKeys(runtime.environment);
      const readyKey =
        `${keys.base}:ready:${execution.schedulerJob.classKey}:${execution.schedulerJob.workspaceId}`;
      await runtime.schedulerRedis.zrem(keys.due, admitted.jobId);
      await runtime.schedulerRedis.zrem(keys.dispatch, admitted.jobId);
      await runtime.schedulerRedis.zrem(readyKey, admitted.jobId);
      assertEquals(
        await runtime.schedulerRedis.hget(keys.jobs, admitted.jobId) !== null,
        true,
      );

      const rebuilt = await runtime.bridge.rebuildAll();
      assertEquals(rebuilt.repaired, 1);
      const next = await runtime.scheduler.claimNext("scheduler-index-repair");
      assertEquals(next.kind, "leased");
      if (next.kind === "leased") {
        assertEquals(next.lease.jobId, admitted.jobId);
        await runtime.scheduler.releaseDispatchLease(next.lease);
      }
    } finally {
      await cleanupBridge(
        runtime.environment,
        runtime.producer,
        runtime.schedulerRedis,
        runtime.queues,
      );
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "nonterminal dispatch recovery releases without cancellation tombstones",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);
    const runtime = await setupBridge(pool, 2, 1);
    try {
      const admitted = await admit(pool, fixture, "nonterminal-recovery");
      const execution = await loadScheduledExecution(pool, admitted.jobId, 0);
      if (execution === null) throw new Error("scheduled execution missing");
      await runtime.bridge.enqueue(execution.payload);
      await pool.query(
        "update relay.capacity_pools set enabled = false where id = $1",
        [fixture.capacityPoolId],
      );

      const held = await runtime.bridge.dispatchBatch(
        "scheduler-disabled-pool",
      );
      assertEquals(held.deferredForState, 1);
      const raw = await runtime.schedulerRedis.hget(
        schedulerKeys(runtime.environment).jobs,
        admitted.jobId,
      );
      if (raw === null) throw new Error("scheduler record missing");
      assertEquals(JSON.parse(raw).tombstone, undefined);

      await pool.query(
        "update relay.capacity_pools set enabled = true where id = $1",
        [fixture.capacityPoolId],
      );
      await new Promise((resolve) => setTimeout(resolve, 75));
      assertEquals(
        (await runtime.bridge.dispatchBatch("scheduler-recovered-pool"))
          .published,
        1,
      );
    } finally {
      await pool.query(
        "update relay.capacity_pools set enabled = true where id = $1",
        [fixture.capacityPoolId],
      );
      await cleanupBridge(
        runtime.environment,
        runtime.producer,
        runtime.schedulerRedis,
        runtime.queues,
      );
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "disabled scheduler classes are held without blocking reset readiness",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);
    const runtime = await setupBridge(pool, 2, 2);
    const gate = new RedisDispatchGate(
      runtime.schedulerRedis,
      `relay:${runtime.environment}:disabled-class-gate`,
    );
    try {
      await admit(pool, fixture, "disabled-class");
      const keys = schedulerKeys(runtime.environment);
      const raw = await runtime.schedulerRedis.hget(keys.profiles, "standard");
      if (raw === null) throw new Error("standard scheduler profile missing");
      await runtime.schedulerRedis.hset(
        keys.profiles,
        "standard",
        JSON.stringify({ ...JSON.parse(raw), enabled: false }),
      );

      let held = 0;
      const result = await reconcileRedisReset(
        pool,
        gate,
        {
          restoreCapacityLease: () => Promise.resolve(),
          releaseCapacityLease: () => Promise.resolve(),
          rebuildScheduler: async () => {
            const rebuilt = await runtime.bridge.rebuildAll();
            held = rebuilt.held;
            return rebuilt;
          },
        },
        {
          owner: "disabled-class-reconciler",
          lockDurationMs: 500,
          conservativeDelayMs: 0,
        },
      );
      assertEquals(result.kind, "reconciled");
      assertEquals(held >= 1, true);
      assertEquals(await gate.isReady(), true);
      assertEquals(
        (await runtime.scheduler.claimNext("disabled-class-dispatch")).kind,
        "empty",
      );
    } finally {
      await gate.invalidate();
      await cleanupBridge(
        runtime.environment,
        runtime.producer,
        runtime.schedulerRedis,
        runtime.queues,
      );
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "renewed pool locks preserve the shallow buffer under slow publish",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);
    const runtime = await setupBridge(pool, 1, 1);
    let waiting = 0;
    let publishCalls = 0;
    let signalPublishStarted: (() => void) | undefined;
    const publishStarted = new Promise<void>((resolve) => {
      signalPublishStarted = resolve;
    });
    const transport = {
      publish: async () => {
        publishCalls += 1;
        signalPublishStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 900));
        waiting += 1;
      },
      cancel: () => Promise.resolve(),
      waitingCount: () => Promise.resolve(waiting),
      hasRunnableTicket: () => Promise.resolve(false),
    };
    const bridgeOptions = {
      environment: runtime.environment,
      maxBullmqWaitingPerPool: 1,
      maxDispatchesPerIteration: 1,
      bufferRetryDelayMs: 50,
      poolBufferLockDurationMs: 300,
    } as const;
    const schedulerWithLostAcknowledgement = {
      enqueue: runtime.scheduler.enqueue.bind(runtime.scheduler),
      claimNext: runtime.scheduler.claimNext.bind(runtime.scheduler),
      acknowledgeDispatch: () => Promise.resolve(false),
      renewDispatchLease: runtime.scheduler.renewDispatchLease.bind(
        runtime.scheduler,
      ),
      releaseDispatchLease: runtime.scheduler.releaseDispatchLease.bind(
        runtime.scheduler,
      ),
      removeJob: runtime.scheduler.removeJob.bind(runtime.scheduler),
    };
    const firstBridge = new ExecutionSchedulerBridge(
      pool,
      runtime.schedulerRedis,
      schedulerWithLostAcknowledgement,
      transport,
      bridgeOptions,
    );
    const secondBridge = new ExecutionSchedulerBridge(
      pool,
      runtime.schedulerRedis,
      runtime.scheduler,
      transport,
      bridgeOptions,
    );
    try {
      const admitted = await Promise.all([
        admit(pool, fixture, "slow-publish-a"),
        admit(pool, fixture, "slow-publish-b"),
      ]);
      for (const job of admitted) {
        const execution = await loadScheduledExecution(pool, job.jobId, 0);
        if (execution === null) throw new Error("scheduled execution missing");
        await runtime.bridge.enqueue(execution.payload);
      }

      const first = firstBridge.dispatchBatch("slow-publisher-a");
      await publishStarted;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const second = await secondBridge.dispatchBatch("slow-publisher-b");
      const firstResult = await first;

      assertEquals(firstResult.published, 1);
      assertEquals(firstResult.lostLease, 1);
      assertEquals(second.deferredForBuffer, 1);
      assertEquals(publishCalls, 1);
      assertEquals(waiting, 1);
      assertEquals(
        await runtime.schedulerRedis.zcard(
          schedulerKeys(runtime.environment).dispatch,
        ),
        1,
        "the unacknowledged scheduler lease remains recoverable",
      );
    } finally {
      await cleanupBridge(
        runtime.environment,
        runtime.producer,
        runtime.schedulerRedis,
        runtime.queues,
      );
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});
