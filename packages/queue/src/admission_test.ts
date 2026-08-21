import { assertEquals, assertExists } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { type AdmitRunInput, admitToolRun } from "./admission.ts";

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

function unique(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

async function createUser(pool: DatabasePool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth."user" (id, name, email, "emailVerified")
     values (gen_random_uuid()::text, 'Test', $1, true)
     returning id`,
    [`${unique("user")}@example.com`],
  );
  return rows[0].id;
}

async function createOrganization(pool: DatabasePool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth.organization (id, name, slug, "createdAt")
     values (gen_random_uuid()::text, 'Test Org', $1, now())
     returning id`,
    [unique("org")],
  );
  return rows[0].id;
}

async function createCapacityPool(pool: DatabasePool): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into relay.capacity_pools (key, execution_class)
     values ($1, 'standard')
     returning id`,
    [unique("pool")],
  );
  return Number(rows[0].id);
}

interface Fixture {
  workspaceId: string;
  createdBy: string;
  capacityPoolId: number;
  toolId: string;
}

async function fixture(pool: DatabasePool): Promise<Fixture> {
  const [workspaceId, createdBy, capacityPoolId] = await Promise.all([
    createOrganization(pool),
    createUser(pool),
    createCapacityPool(pool),
  ]);
  return { workspaceId, createdBy, capacityPoolId, toolId: unique("tool") };
}

/**
 * Every table a fixture can touch, deleted in dependency order. This
 * matters beyond tidiness: `packages/auth`'s own tests do a full
 * `delete from auth."user"` / `delete from auth.organization` reset,
 * assuming they exclusively own those tables (true before Wave 3.0 added
 * `relay.tool_runs.created_by`'s FK to `auth.user`). A fixture left
 * behind here makes that reset fail with a foreign-key violation the
 * next time both suites run in the same shared dev database -- this is
 * what actually broke when admission/dispatch tests started creating
 * real rows without cleaning them up.
 */
async function cleanupFixture(pool: DatabasePool, f: Fixture): Promise<void> {
  await pool.query(
    `delete from relay.outbox_events
     where aggregate_id in (select id::text from relay.execution_jobs where workspace_id = $1)`,
    [f.workspaceId],
  );
  await pool.query(
    `delete from relay.job_attempts
     where job_id in (select id from relay.execution_jobs where workspace_id = $1)`,
    [f.workspaceId],
  );
  await pool.query("delete from relay.execution_jobs where workspace_id = $1", [
    f.workspaceId,
  ]);
  await pool.query(
    "delete from relay.idempotency_records where workspace_id = $1",
    [f.workspaceId],
  );
  await pool.query("delete from relay.tool_runs where workspace_id = $1", [
    f.workspaceId,
  ]);
  await pool.query(
    "delete from relay.workspace_tool_queue_counters where workspace_id = $1",
    [f.workspaceId],
  );
  await pool.query(
    "delete from relay.workspace_queue_counters where workspace_id = $1",
    [f.workspaceId],
  );
  await pool.query("delete from relay.tool_queue_counters where tool_id = $1", [
    f.toolId,
  ]);
  await pool.query("delete from relay.capacity_pools where id = $1", [
    f.capacityPoolId,
  ]);
  await pool.query("delete from auth.organization where id = $1", [
    f.workspaceId,
  ]);
  await pool.query('delete from auth."user" where id = $1', [f.createdBy]);
}

function baseInput(
  f: Fixture,
  overrides: Partial<AdmitRunInput> = {},
): AdmitRunInput {
  return {
    workspaceId: f.workspaceId,
    toolId: f.toolId,
    toolVersionId: unique("tool-version"),
    createdBy: f.createdBy,
    input: { prompt: "a cat" },
    idempotencyKey: unique("idem"),
    capacityPoolId: f.capacityPoolId,
    schedulingClass: "standard",
    schedulingPolicyVersion: 1,
    estimatedCostUnits: 1,
    admissionDeadlineMs: 60_000,
    runDeadlineMs: 300_000,
    limits: { globalTool: 100, workspaceTotal: 100, workspaceTool: 100 },
    ...overrides,
  };
}

Deno.test({
  name:
    "admitToolRun creates a run, job, counters, and an outbox job.ready event",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: Fixture | undefined;
    try {
      f = await fixture(pool);
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
        { status: string; run_id: string; scheduling_class: string }
      >(
        "select status, run_id, scheduling_class from relay.execution_jobs where id = $1",
        [result.jobId],
      );
      assertEquals(job.rows[0].status, "queued");
      assertEquals(job.rows[0].run_id, result.runId);
      assertEquals(job.rows[0].scheduling_class, "standard");

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
    } finally {
      if (f) await cleanupFixture(pool, f);
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
    let f: Fixture | undefined;
    try {
      f = await fixture(pool);
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
      if (f) await cleanupFixture(pool, f);
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
    let f: Fixture | undefined;
    try {
      f = await fixture(pool);
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
      if (f) await cleanupFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "a full global-tool queue is rejected without mutating any counter",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: Fixture | undefined;
    try {
      f = await fixture(pool);
      const input = baseInput(f, {
        limits: { globalTool: 0, workspaceTotal: 100, workspaceTool: 100 },
      });

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
      if (f) await cleanupFixture(pool, f);
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
    let f: Fixture | undefined;
    try {
      f = await fixture(pool);
      const limits = { globalTool: 100, workspaceTotal: 100, workspaceTool: 1 };

      const first = await admitToolRun(pool, baseInput(f, { limits }));
      assertEquals(first.kind, "admitted");

      const second = await admitToolRun(pool, baseInput(f, { limits }));
      assertEquals(second.kind, "queue_full");
      if (second.kind !== "queue_full") throw new Error("unreachable");
      assertEquals(second.scope, "workspace_tool");
    } finally {
      if (f) await cleanupFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "the outbox event payload carries the job and run IDs the relay needs",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: Fixture | undefined;
    try {
      f = await fixture(pool);
      const result = await admitToolRun(pool, baseInput(f));
      assertEquals(result.kind, "admitted");
      if (result.kind !== "admitted") throw new Error("unreachable");

      const { rows } = await pool.query<
        { payload: { domainJobId: string; runId: string } }
      >(
        "select payload from relay.outbox_events where aggregate_id = $1",
        [result.jobId],
      );
      assertExists(rows[0]);
      assertEquals(rows[0].payload.domainJobId, result.jobId);
      assertEquals(rows[0].payload.runId, result.runId);
    } finally {
      if (f) await cleanupFixture(pool, f);
      await pool.end();
    }
  },
});
