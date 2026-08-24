import { assertEquals, assertExists } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import type { TracePropagationApi } from "@relay/observability";
import pg from "pg";
import {
  type AdmitRunInput,
  admitToolRun as admitToolRunWithDependencies,
} from "./admission.ts";
import { loadScheduledExecution } from "./scheduler-bridge.ts";
import {
  type AdmissibleFixture,
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
  setQueueLimits,
  TEST_USAGE_PORT,
} from "./test_support.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const hasDatabase = databaseUrl !== undefined;

function testPool(): DatabasePool {
  return createDatabasePool(
    {
      url: new URL(databaseUrl!),
      poolMax: 5,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
    },
    "relay-api",
  );
}

/**
 * Matches production's admission pool (`poolMax: 1`, per
 * docs/implementation-handoff/04-queue-capacity-scheduling.md). A
 * membership check that reached back into the pool instead of using the
 * transaction's own connection would starve here: the transaction holds
 * the pool's one connection, so a second `pool.query()` would wait for a
 * connection that can never free up until the transaction finishes -- and
 * the transaction can't finish until that query returns. `connectTimeoutMs`
 * below turns that deadlock into a clear timeout error instead of hanging
 * the test suite forever if this regresses.
 */
function singleConnectionPool(): DatabasePool {
  return createDatabasePool(
    {
      url: new URL(databaseUrl!),
      poolMax: 1,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
    },
    "relay-api",
  );
}

function unique(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

async function setSchedulingProfileAsOwner(
  workspaceId: string,
  classKey: string,
): Promise<void> {
  const ownerUrl = new URL(databaseUrl!);
  ownerUrl.username = "relay_migrator";
  ownerUrl.password = "relay_dev_only";
  const client = new pg.Client({ connectionString: ownerUrl.toString() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local role relay_owner");
    await client.query(
      `update relay.workspace_scheduling_profiles profile
          set class_key = classes.class_key,
              policy_version = classes.policy_version,
              granted_at = now(),
              expires_at = null
         from relay.scheduler_classes classes
        where profile.workspace_id = $1 and classes.class_key = $2`,
      [workspaceId, classKey],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

const handlersByInput = new WeakMap<
  AdmitRunInput,
  AdmissibleFixture["handlers"]
>();

function baseInput(
  f: AdmissibleFixture,
  overrides: Partial<AdmitRunInput> = {},
): AdmitRunInput {
  const input: AdmitRunInput = {
    workspaceId: f.workspaceId,
    toolVersionId: f.toolVersionId,
    createdBy: f.createdBy,
    input: { prompt: "a cat" },
    idempotencyKey: unique("idem"),
    admissionDeadlineMs: 60_000,
    runDeadlineMs: 300_000,
    ...overrides,
  };
  handlersByInput.set(input, f.handlers);
  return input;
}

function admitToolRun(
  pool: DatabasePool,
  input: AdmitRunInput,
) {
  const handlers = handlersByInput.get(input);
  if (handlers === undefined) {
    throw new Error("fixture handler registry missing");
  }
  return admitToolRunWithDependencies(pool, input, {
    handlers,
    usage: TEST_USAGE_PORT,
  });
}

Deno.test({
  name: "admitToolRun refuses a creator who isn't a workspace member",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      const outsiderId = f.catalogActorIds[0]; // superadmin, but never added as a member
      const result = await admitToolRun(
        pool,
        baseInput(f, { createdBy: outsiderId }),
      );
      assertEquals(result.kind, "not_a_member");
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "admitToolRun refuses an unpublished or nonexistent tool version",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      const result = await admitToolRun(
        pool,
        baseInput(f, { toolVersionId: unique("tver_nonexistent") }),
      );
      assertEquals(result.kind, "tool_version_unavailable");
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "admitToolRun refuses to route through a disabled provider",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      await pool.query(
        "update relay.providers set lifecycle = 'disabled' where id = $1",
        [f.providerId],
      );

      const result = await admitToolRun(pool, baseInput(f));
      assertEquals(result.kind, "no_provider_binding");
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "admitToolRun refuses to route through a disabled provider model",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      await pool.query(
        "update relay.provider_models set lifecycle = 'retired' where id = $1",
        [f.providerModelId],
      );

      const result = await admitToolRun(pool, baseInput(f));
      assertEquals(result.kind, "no_provider_binding");
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "admitToolRun refuses to route through a disabled capacity pool",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      await pool.query(
        "update relay.capacity_pools set enabled = false where id = $1",
        [f.capacityPoolId],
      );

      const result = await admitToolRun(pool, baseInput(f));
      assertEquals(result.kind, "no_provider_binding");
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "admitToolRun creates a run, job, counters, and an outbox job.ready event",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      const input = baseInput(f);

      const result = await admitToolRun(pool, input);
      assertEquals(result.kind, "admitted");
      if (result.kind !== "admitted") throw new Error("unreachable");

      const run = await pool.query<
        { status: string; workspace_id: string; input: unknown }
      >(
        "select status, workspace_id, input from relay.tool_runs where id = $1",
        [result.runId],
      );
      assertEquals(run.rows[0].status, "queued");
      assertEquals(run.rows[0].workspace_id, f.workspaceId);
      assertEquals(run.rows[0].input, { prompt: "a cat" });

      const job = await pool.query<
        {
          status: string;
          run_id: string;
          scheduling_class: string;
          scheduling_policy_version: number;
          estimated_cost_units: string | number;
          fifo_sequence: string | number;
          capacity_pool_id: number;
        }
      >(
        `select status, run_id, scheduling_class,
                scheduling_policy_version, estimated_cost_units, fifo_sequence,
                capacity_pool_id
           from relay.execution_jobs where id = $1`,
        [result.jobId],
      );
      assertEquals(job.rows[0].status, "queued");
      assertEquals(job.rows[0].run_id, result.runId);
      assertEquals(job.rows[0].scheduling_class, "standard");
      assertEquals(job.rows[0].scheduling_policy_version, 1);
      assertEquals(Number(job.rows[0].estimated_cost_units), 1);
      assertEquals(Number(job.rows[0].fifo_sequence) > 0, true);
      assertEquals(Number(job.rows[0].capacity_pool_id), f.capacityPoolId);

      const counters = await pool.query<{ queued_count: number }>(
        "select queued_count from relay.tool_queue_counters where tool_id = $1",
        [f.toolId],
      );
      assertEquals(counters.rows[0].queued_count, 1);

      const outbox = await pool.query<
        { event_type: string; aggregate_id: string }
      >(
        "select event_type, aggregate_id from relay.outbox_events where aggregate_id = $1",
        [result.jobId],
      );
      assertEquals(outbox.rows.length, 1);
      assertEquals(outbox.rows[0].event_type, "job.ready");

      const routingDecision = await pool.query<
        {
          tool_id: string;
          tool_version_id: string;
          tool_version_immutable_hash: string;
          handler_key: string;
          input_schema_version: number;
          handler_version: string;
          provider_id: number;
          provider_model_id: number;
          capacity_pool_id: number;
          routing_order: number;
          routing_policy_id: number | null;
          routing_policy_revision: number | null;
          routing_policy_immutable_hash: string | null;
          fallback_used: boolean;
          fallback_reason: string | null;
        }
      >(
        `select tool_id, tool_version_id, tool_version_immutable_hash,
                handler_key, input_schema_version, handler_version,
                provider_id, provider_model_id, capacity_pool_id, routing_order,
                routing_policy_id, routing_policy_revision,
                routing_policy_immutable_hash, fallback_used, fallback_reason
           from relay.routing_decisions where tool_run_id = $1`,
        [result.runId],
      );
      assertEquals(routingDecision.rows.length, 1);
      assertEquals(routingDecision.rows[0].tool_id, f.toolId);
      assertEquals(routingDecision.rows[0].tool_version_id, f.toolVersionId);
      assertEquals(
        routingDecision.rows[0].tool_version_immutable_hash.length,
        64,
      );
      assertEquals(routingDecision.rows[0].handler_key, f.handlerKey);
      assertEquals(routingDecision.rows[0].input_schema_version, 1);
      assertEquals(routingDecision.rows[0].handler_version, "1");
      assertEquals(Number(routingDecision.rows[0].provider_id), f.providerId);
      assertEquals(
        Number(routingDecision.rows[0].provider_model_id),
        f.providerModelId,
      );
      assertEquals(
        Number(routingDecision.rows[0].capacity_pool_id),
        f.capacityPoolId,
      );
      assertEquals(routingDecision.rows[0].routing_order, 1);
      assertEquals(routingDecision.rows[0].routing_policy_id, null);
      assertEquals(routingDecision.rows[0].routing_policy_revision, null);
      assertEquals(routingDecision.rows[0].routing_policy_immutable_hash, null);
      assertEquals(routingDecision.rows[0].fallback_used, false);
      assertEquals(routingDecision.rows[0].fallback_reason, null);
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "a replayed idempotency key returns the original run without creating a second one",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      const input = baseInput(f);

      const first = await admitToolRun(pool, input);
      assertEquals(first.kind, "admitted");
      const second = await admitToolRun(pool, input);
      assertEquals(second.kind, "replayed");
      if (second.kind !== "replayed" || first.kind !== "admitted") {
        throw new Error("unreachable");
      }
      assertEquals(second.runId, first.runId);

      const runs = await pool.query(
        "select id from relay.tool_runs where workspace_id = $1",
        [f.workspaceId],
      );
      assertEquals(runs.rows.length, 1, "replay must not create a second run");

      const counters = await pool.query<{ queued_count: number }>(
        "select queued_count from relay.tool_queue_counters where tool_id = $1",
        [f.toolId],
      );
      assertEquals(
        counters.rows[0].queued_count,
        1,
        "replay must not double-count",
      );
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "the same idempotency key with a different payload is a conflict, not a replay",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      const key = unique("idem");

      const first = await admitToolRun(
        pool,
        baseInput(f, { idempotencyKey: key }),
      );
      assertEquals(first.kind, "admitted");

      const second = await admitToolRun(
        pool,
        baseInput(f, {
          idempotencyKey: key,
          input: { prompt: "a different cat" },
        }),
      );
      assertEquals(second.kind, "idempotency_conflict");
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "the same idempotency key and payload from a different actor is a conflict, not a replay",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    let secondActorId: string | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      const key = unique("idem");
      const payload = { prompt: "a cat" };

      const first = await admitToolRun(
        pool,
        baseInput(f, { idempotencyKey: key, input: payload }),
      );
      assertEquals(first.kind, "admitted");

      const { rows } = await pool.query<{ id: string }>(
        `insert into auth."user" (id, name, email, "emailVerified")
         values (gen_random_uuid()::text, 'Second Actor', $1, true)
         returning id`,
        [`${unique("second-actor")}@example.com`],
      );
      secondActorId = rows[0].id;
      await pool.query(
        `insert into auth.member (id, "organizationId", "userId", role, "createdAt")
         values (gen_random_uuid()::text, $1, $2, 'member', now())`,
        [f.workspaceId, secondActorId],
      );

      // Same workspace, same idempotency key, same payload -- but a
      // different actor. The durable idempotency scope must include the
      // actor, or this second actor would silently receive the first
      // actor's run.
      const second = await admitToolRun(
        pool,
        baseInput(f, {
          idempotencyKey: key,
          input: payload,
          createdBy: secondActorId,
        }),
      );
      assertEquals(second.kind, "idempotency_conflict");
    } finally {
      if (secondActorId) {
        await pool.query('delete from auth.member where "userId" = $1', [
          secondActorId,
        ]);
        await pool.query('delete from auth."user" where id = $1', [
          secondActorId,
        ]);
      }
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "the same idempotency key and payload for a different tool version is a conflict, not a replay",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    let g: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      g = await createAdmissibleFixture(pool);
      const key = unique("idem");
      const payload = { prompt: "a cat" };

      const first = await admitToolRun(
        pool,
        baseInput(f, { idempotencyKey: key, input: payload }),
      );
      assertEquals(first.kind, "admitted");

      // Same workspace, actor, idempotency key, and payload -- but a
      // different tool version. Register the second deployed handler so route
      // validation succeeds and idempotency comparison owns the outcome.
      f.handlers.register(g.handlerKey);
      const second = await admitToolRun(
        pool,
        baseInput(f, {
          idempotencyKey: key,
          input: payload,
          toolVersionId: g.toolVersionId,
        }),
      );
      assertEquals(second.kind, "idempotency_conflict");
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      if (g) await cleanupAdmissibleFixture(pool, g);
      await pool.end();
    }
  },
});

Deno.test({
  name: "a full global-tool queue is rejected without mutating any counter",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      await setQueueLimits(pool, f.toolId, {
        globalTool: 0,
        workspaceTotal: 100,
        workspaceTool: 100,
      });
      const input = baseInput(f);

      const result = await admitToolRun(pool, input);
      assertEquals(result.kind, "queue_full");
      if (result.kind !== "queue_full") throw new Error("unreachable");
      assertEquals(result.scope, "global_tool");

      const counters = await pool.query<{ queued_count: number }>(
        "select queued_count from relay.tool_queue_counters where tool_id = $1",
        [f.toolId],
      );
      assertEquals(counters.rows[0].queued_count, 0);

      const runs = await pool.query(
        "select id from relay.tool_runs where workspace_id = $1",
        [f.workspaceId],
      );
      assertEquals(
        runs.rows.length,
        0,
        "a rejected admission must not create a run",
      );
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "a workspace-tool limit of 1 admits the first run and rejects the second",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      await setQueueLimits(pool, f.toolId, {
        globalTool: 100,
        workspaceTotal: 100,
        workspaceTool: 1,
      });

      const first = await admitToolRun(pool, baseInput(f));
      assertEquals(first.kind, "admitted");

      const second = await admitToolRun(pool, baseInput(f));
      assertEquals(second.kind, "queue_full");
      if (second.kind !== "queue_full") throw new Error("unreachable");
      assertEquals(second.scope, "workspace_tool");
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "admitToolRun completes on a poolMax: 1 pool without deadlocking",
  ignore: !hasDatabase,
  fn: async () => {
    const fixturePool = testPool();
    const admissionPool = singleConnectionPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(fixturePool);
      const result = await admitToolRun(admissionPool, baseInput(f));
      assertEquals(result.kind, "admitted");
    } finally {
      if (f) await cleanupAdmissibleFixture(fixturePool, f);
      await fixturePool.end();
      await admissionPool.end();
    }
  },
});

Deno.test({
  name:
    "two concurrent admissions with the same idempotency key never throw and converge on one run",
  ignore: !hasDatabase,
  fn: async () => {
    const poolA = testPool();
    const poolB = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(poolA);
      const input = baseInput(f);

      // Two separate pools/connections racing the same idempotency key --
      // both see no existing idempotency_records row (their SELECTs run
      // before either commits), so both attempt the run/job/counter
      // writes. Before the ON CONFLICT DO NOTHING fix, the loser's final
      // INSERT into idempotency_records would throw a raw unique-violation
      // error instead of resolving to "replayed".
      const [resultA, resultB] = await Promise.all([
        admitToolRun(poolA, input),
        admitToolRun(poolB, input),
      ]);

      const kinds = [resultA.kind, resultB.kind].sort();
      assertEquals(kinds, ["admitted", "replayed"]);

      const winner = resultA.kind === "admitted" ? resultA : resultB;
      const loser = resultA.kind === "replayed" ? resultA : resultB;
      if (winner.kind !== "admitted" || loser.kind !== "replayed") {
        throw new Error("unreachable");
      }
      assertEquals(loser.runId, winner.runId);

      const runs = await poolA.query(
        "select id from relay.tool_runs where workspace_id = $1",
        [f.workspaceId],
      );
      assertEquals(runs.rows.length, 1, "the race must not create two runs");

      const counters = await poolA.query<{ queued_count: number }>(
        "select queued_count from relay.tool_queue_counters where tool_id = $1",
        [f.toolId],
      );
      assertEquals(
        counters.rows[0].queued_count,
        1,
        "the losing attempt's counter increment must be rolled back",
      );
    } finally {
      if (f) await cleanupAdmissibleFixture(poolA, f);
      await poolA.end();
      await poolB.end();
    }
  },
});

Deno.test({
  name:
    "a duplicate request racing at a full queue boundary is replayed, not queue_full",
  ignore: !hasDatabase,
  fn: async () => {
    const poolA = testPool();
    const poolB = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(poolA);
      // Tight enough that the second (duplicate) request would see the
      // queue as genuinely full if it ever reached the counter check --
      // without the advisory lock serializing same-key admissions before
      // that check, that's exactly what used to happen: the loser's own
      // idempotency-record lookup ran before the winner committed, so it
      // never discovered the duplicate and fell through to a real
      // (but wrong) queue_full instead of replaying the winner's run.
      await setQueueLimits(poolA, f.toolId, {
        globalTool: 1,
        workspaceTotal: 1,
        workspaceTool: 1,
      });
      const input = baseInput(f);

      const [resultA, resultB] = await Promise.all([
        admitToolRun(poolA, input),
        admitToolRun(poolB, input),
      ]);

      const kinds = [resultA.kind, resultB.kind].sort();
      assertEquals(
        kinds,
        ["admitted", "replayed"],
        "a duplicate of an admitted request must never come back queue_full",
      );

      const winner = resultA.kind === "admitted" ? resultA : resultB;
      const loser = resultA.kind === "replayed" ? resultA : resultB;
      if (winner.kind !== "admitted" || loser.kind !== "replayed") {
        throw new Error("unreachable");
      }
      assertEquals(loser.runId, winner.runId);
    } finally {
      if (f) await cleanupAdmissibleFixture(poolA, f);
      await poolA.end();
      await poolB.end();
    }
  },
});

Deno.test({
  name: "the outbox event payload carries the job and run IDs the relay needs",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      const result = await admitToolRun(pool, baseInput(f));
      assertEquals(result.kind, "admitted");
      if (result.kind !== "admitted") throw new Error("unreachable");

      const { rows } = await pool.query<
        {
          payload: {
            domainJobId: string;
            runId: string;
            capacityPoolKey: string;
            dispatchGeneration: number;
            policyVersion: number;
            workspaceId: string;
            classKey: string;
            costUnits: number;
            fifoSequence: number;
            eligibleAtMs: number;
          };
        }
      >(
        "select payload from relay.outbox_events where aggregate_id = $1",
        [result.jobId],
      );
      assertExists(rows[0]);
      assertEquals(rows[0].payload.domainJobId, result.jobId);
      assertEquals(rows[0].payload.runId, result.runId);
      assertEquals(rows[0].payload.dispatchGeneration, 0);
      assertEquals(rows[0].payload.policyVersion, 1);
      assertEquals(rows[0].payload.workspaceId, f.workspaceId);
      assertEquals(rows[0].payload.classKey, "standard");
      assertEquals(rows[0].payload.costUnits, 1);
      assertEquals(Number.isSafeInteger(rows[0].payload.fifoSequence), true);
      assertEquals(Number.isSafeInteger(rows[0].payload.eligibleAtMs), true);
      const capacityPool = await pool.query<{ key: string }>(
        "select key from relay.capacity_pools where id = $1",
        [f.capacityPoolId],
      );
      assertEquals(rows[0].payload.capacityPoolKey, capacityPool.rows[0].key);
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "admission fails closed when the deployed handler is missing",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      f.handlers.unregister(f.handlerKey);
      const result = await admitToolRun(pool, baseInput(f));
      assertEquals(result.kind, "tool_version_unavailable");
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "database scheduling and usage ports own class, cost, and reservation",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      await setSchedulingProfileAsOwner(f.workspaceId, "paid");
      const input = baseInput(f);
      const result = await admitToolRunWithDependencies(pool, input, {
        handlers: f.handlers,
        usage: {
          quote: () =>
            Promise.resolve({
              estimatedCostUnits: 3,
              policyKey: "test-meter-policy:v1",
            }),
          reserve: () => Promise.resolve(null),
        },
      });
      assertEquals(result.kind, "admitted");
      if (result.kind !== "admitted") throw new Error("unreachable");

      const job = await pool.query<{
        scheduling_class: string;
        scheduling_policy_version: number;
        estimated_cost_units: string | number;
      }>(
        `select scheduling_class, scheduling_policy_version,
                estimated_cost_units
           from relay.execution_jobs where id = $1`,
        [result.jobId],
      );
      assertEquals(job.rows[0].scheduling_class, "paid");
      assertEquals(job.rows[0].scheduling_policy_version, 1);
      assertEquals(Number(job.rows[0].estimated_cost_units), 3);
      const run = await pool.query<{ reservation_id: string | null }>(
        "select reservation_id from relay.tool_runs where id = $1",
        [result.runId],
      );
      assertEquals(run.rows[0].reservation_id, null);
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "idempotency hash includes server usage policy without double reservation",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      const input = baseInput(f, { idempotencyKey: unique("idem-usage") });
      let policyKey = "usage-policy:v1";
      let reservations = 0;
      const usage = {
        quote: () => Promise.resolve({ estimatedCostUnits: 2, policyKey }),
        reserve: () => {
          reservations += 1;
          return Promise.resolve(null);
        },
      };
      const first = await admitToolRunWithDependencies(pool, input, {
        handlers: f.handlers,
        usage,
      });
      assertEquals(first.kind, "admitted");
      policyKey = "usage-policy:v2";
      const second = await admitToolRunWithDependencies(pool, input, {
        handlers: f.handlers,
        usage,
      });
      assertEquals(second.kind, "idempotency_conflict");
      assertEquals(reservations, 1);
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "admission persists only active W3C trace context in its outbox ticket",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    const traceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const tracePropagation: TracePropagationApi = {
      inject(_source, carrier, setter) {
        setter.set(carrier, "traceparent", traceparent);
        setter.set(carrier, "tracestate", "relay=test");
        setter.set(carrier, "baggage", "prompt=private-canary");
      },
      extract(source) {
        return source;
      },
    };

    try {
      f = await createAdmissibleFixture(pool);
      const result = await admitToolRunWithDependencies(pool, baseInput(f), {
        handlers: f.handlers,
        usage: TEST_USAGE_PORT,
        tracePropagation,
      });
      if (result.kind !== "admitted") {
        throw new Error("fixture admission failed");
      }
      const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
        "select payload from relay.outbox_events where aggregate_id = $1",
        [result.jobId],
      );

      assertEquals(rows[0].payload.traceparent, traceparent);
      assertEquals(rows[0].payload.tracestate, "relay=test");
      assertEquals("baggage" in rows[0].payload, false);

      const scheduled = await loadScheduledExecution(pool, result.jobId, 0);
      assertEquals(scheduled?.payload.traceparent, traceparent);
      assertEquals(scheduled?.payload.tracestate, "relay=test");
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "idempotency hash includes deadline and requested-model behavior",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
      const key = unique("idem-policy");
      const first = await admitToolRun(
        pool,
        baseInput(f, {
          idempotencyKey: key,
          requestedModelVersion: "model-a",
          runDeadlineMs: 300_000,
        }),
      );
      assertEquals(first.kind, "admitted");
      const changedDeadline = await admitToolRun(
        pool,
        baseInput(f, {
          idempotencyKey: key,
          requestedModelVersion: "model-a",
          runDeadlineMs: 600_000,
        }),
      );
      assertEquals(changedDeadline.kind, "idempotency_conflict");
      const changedModel = await admitToolRun(
        pool,
        baseInput(f, {
          idempotencyKey: key,
          requestedModelVersion: "model-b",
          runDeadlineMs: 300_000,
        }),
      );
      assertEquals(changedModel.kind, "idempotency_conflict");
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});
