import { assertEquals } from "@std/assert";
import { Redis } from "ioredis";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { type AdmitRunInput, admitToolRun } from "./admission.ts";
import { armSchedulerTicket, claimJobForDispatch } from "./dispatch.ts";
import {
  loadCapacityRehydrationPlan,
  reconcileLostTickets,
  reconcileRedisReset,
  RedisDispatchGate,
} from "./reconciliation.ts";
import {
  type AdmissibleFixture,
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
  TEST_USAGE_PORT,
} from "./test_support.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const redisUrl = Deno.env.get("REDIS_URL");

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

async function admitJob(
  pool: DatabasePool,
): Promise<{
  fixture: AdmissibleFixture;
  jobId: string;
  policyVersion: number;
  schedulerToken: string;
}> {
  const fixture = await createAdmissibleFixture(pool);
  const input: AdmitRunInput = {
    workspaceId: fixture.workspaceId,
    toolVersionId: fixture.toolVersionId,
    createdBy: fixture.createdBy,
    input: { prompt: "reconcile me" },
    idempotencyKey: unique("idem"),
    admissionDeadlineMs: 60_000,
    runDeadlineMs: 300_000,
  };
  const result = await admitToolRun(pool, input, {
    handlers: fixture.handlers,
    usage: TEST_USAGE_PORT,
  });
  if (result.kind !== "admitted") throw new Error("fixture admission failed");
  const job = await pool.query<{ scheduling_policy_version: number }>(
    "select scheduling_policy_version from relay.execution_jobs where id = $1",
    [result.jobId],
  );
  const schedulerToken = `reconciliation-scheduler.${result.jobId}`;
  await armSchedulerTicket(pool, result.jobId, 0, schedulerToken);
  return {
    fixture,
    jobId: result.jobId,
    policyVersion: job.rows[0].scheduling_policy_version,
    schedulerToken,
  };
}

Deno.test({
  name: "dispatch readiness token changes after every reconciliation",
  ignore: redisUrl === undefined,
  fn: async () => {
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const gate = new RedisDispatchGate(redis, unique("token-gate"));
    try {
      assertEquals(await gate.tryBegin("owner-a", 5_000), true);
      assertEquals(await gate.finish("owner-a"), true);
      const first = await gate.readyToken();
      assertEquals(first !== null, true);

      await gate.invalidate();
      assertEquals(await gate.tryBegin("owner-b", 5_000), true);
      assertEquals(await gate.finish("owner-b"), true);
      const second = await gate.readyToken();
      assertEquals(second !== null, true);
      assertEquals(second === first, false);
    } finally {
      await gate.invalidate();
      await redis.quit();
    }
  },
});

Deno.test({
  name: "lost-ticket reconciliation re-arms the exact durable generation",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    let admitted: Awaited<ReturnType<typeof admitJob>> | undefined;
    try {
      admitted = await admitJob(pool);
      await pool.query(
        "update relay.outbox_events set published_at = now() where aggregate_id = $1",
        [admitted.jobId],
      );
      const result = await reconcileLostTickets(
        pool,
        () => Promise.resolve(false),
      );
      assertEquals(result.rearmed >= 1, true);
      const { rows } = await pool.query<{
        published_at: Date | null;
        payload: { dispatchGeneration: number; policyVersion: number };
      }>(
        "select published_at, payload from relay.outbox_events where aggregate_id = $1",
        [admitted.jobId],
      );
      assertEquals(rows[0].published_at, null);
      assertEquals(rows[0].payload.dispatchGeneration, 0);
      assertEquals(rows[0].payload.policyVersion, admitted.policyVersion);
    } finally {
      if (admitted) {
        await cleanupAdmissibleFixture(pool, admitted.fixture);
      }
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "capacity rehydration fails closed when an active attempt lacks durable lease facts",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    let admitted: Awaited<ReturnType<typeof admitJob>> | undefined;
    try {
      admitted = await admitJob(pool);
      const claim = await claimJobForDispatch(
        pool,
        {
          domainJobId: admitted.jobId,
          dispatchGeneration: 0,
          policyVersion: admitted.policyVersion,
          schedulerToken: admitted.schedulerToken,
        },
        "crashed-worker",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("fixture claim failed");
      await pool.query(
        "update relay.execution_jobs set attempt_count = 1 where id = $1",
        [admitted.jobId],
      );
      const plan = await loadCapacityRehydrationPlan(pool);
      assertEquals(plan.unsafeJobIds.includes(admitted.jobId), true);
    } finally {
      if (admitted) {
        await cleanupAdmissibleFixture(pool, admitted.fixture);
      }
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "Redis-reset reconciliation keeps dispatch closed until scheduler rebuild",
  ignore: databaseUrl === undefined || redisUrl === undefined,
  fn: async () => {
    const pool = testPool();
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const gate = new RedisDispatchGate(redis, unique("reset-gate"));
    let admitted: Awaited<ReturnType<typeof admitJob>> | undefined;
    try {
      admitted = await admitJob(pool);
      await pool.query(
        "update relay.outbox_events set published_at = now() where aggregate_id = $1",
        [admitted.jobId],
      );
      assertEquals(await gate.isReady(), false);
      const result = await reconcileRedisReset(
        pool,
        gate,
        {
          restoreCapacityLease: () => Promise.resolve(),
          releaseCapacityLease: () => Promise.resolve(),
          rebuildScheduler: () => Promise.resolve({ enqueued: 1, rearmed: 0 }),
        },
        {
          owner: unique("reconciler"),
          lockDurationMs: 5_000,
          conservativeDelayMs: 0,
        },
      );
      assertEquals(result.kind, "reconciled");
      if (result.kind === "reconciled") {
        assertEquals(result.rebuiltSchedulerJobs, 1);
        assertEquals(result.rearmedSchedulerJobs, 0);
      }
      assertEquals(await gate.isReady(), true);
    } finally {
      await gate.invalidate();
      if (admitted) {
        await cleanupAdmissibleFixture(pool, admitted.fixture);
      }
      await redis.quit();
      await pool.end();
    }
  },
});

Deno.test({
  name: "Redis-reset reconciliation renews ownership through a long rebuild",
  ignore: databaseUrl === undefined || redisUrl === undefined,
  fn: async () => {
    const pool = testPool();
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const gate = new RedisDispatchGate(redis, unique("renewing-reset-gate"));
    let intruderAcquired = false;
    try {
      const result = await reconcileRedisReset(
        pool,
        gate,
        {
          restoreCapacityLease: () => Promise.resolve(),
          releaseCapacityLease: () => Promise.resolve(),
          rebuildScheduler: async () => {
            for (let batch = 0; batch < 3; batch++) {
              await new Promise((resolve) => setTimeout(resolve, 150));
              if (batch === 1) {
                intruderAcquired = await gate.tryBegin("intruder", 200);
              }
            }
            return { enqueued: 0, rearmed: 0 };
          },
        },
        {
          owner: unique("renewing-reconciler"),
          lockDurationMs: 200,
          conservativeDelayMs: 0,
        },
      );
      assertEquals(result.kind, "reconciled");
      assertEquals(intruderAcquired, false);
      assertEquals(await gate.isReady(), true);
    } finally {
      await gate.invalidate();
      await redis.quit();
      await pool.end();
    }
  },
});
