import { assertEquals, assertExists } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { type AdmitRunInput, admitToolRun } from "./admission.ts";
import {
  type AdmissibleFixture,
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
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

function unique(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

function baseInput(
  f: AdmissibleFixture,
  overrides: Partial<AdmitRunInput> = {},
): AdmitRunInput {
  return {
    workspaceId: f.workspaceId,
    toolVersionId: f.toolVersionId,
    createdBy: f.createdBy,
    input: { prompt: "a cat" },
    idempotencyKey: unique("idem"),
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
          capacity_pool_id: number;
        }
      >(
        "select status, run_id, scheduling_class, capacity_pool_id from relay.execution_jobs where id = $1",
        [result.jobId],
      );
      assertEquals(job.rows[0].status, "queued");
      assertEquals(job.rows[0].run_id, result.runId);
      assertEquals(job.rows[0].scheduling_class, "standard");
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
  name: "a full global-tool queue is rejected without mutating any counter",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmissibleFixture | undefined;
    try {
      f = await createAdmissibleFixture(pool);
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
      const limits = { globalTool: 100, workspaceTotal: 100, workspaceTool: 1 };

      const first = await admitToolRun(pool, baseInput(f, { limits }));
      assertEquals(first.kind, "admitted");

      const second = await admitToolRun(pool, baseInput(f, { limits }));
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
        { payload: { domainJobId: string; runId: string } }
      >(
        "select payload from relay.outbox_events where aggregate_id = $1",
        [result.jobId],
      );
      assertExists(rows[0]);
      assertEquals(rows[0].payload.domainJobId, result.jobId);
      assertEquals(rows[0].payload.runId, result.runId);
    } finally {
      if (f) await cleanupAdmissibleFixture(pool, f);
      await pool.end();
    }
  },
});
