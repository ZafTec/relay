import { assertEquals, assertStringIncludes } from "@std/assert";
import pg from "pg";
import { CANONICAL_SQL, migration } from "./0026_execution_lifecycle.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0026_execution_lifecycle checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});

Deno.test("0026_execution_lifecycle enforces attempt and counter invariants", () => {
  assertStringIncludes(CANONICAL_SQL, "job_attempts_job_epoch_idx");
  assertStringIncludes(CANONICAL_SQL, "tool_queue_counters_nonnegative_check");
  assertStringIncludes(
    CANONICAL_SQL,
    "workspace_queue_counters_nonnegative_check",
  );
  assertStringIncludes(
    CANONICAL_SQL,
    "workspace_tool_queue_counters_nonnegative_check",
  );
});

const databaseUrl = Deno.env.get("DATABASE_URL");

Deno.test({
  name: "0026 execution lifecycle constraints exist in PostgreSQL",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const constraints = await client.query<{ conname: string }>(
        `select conname from pg_constraint
          where conname in (
            'outbox_events_attempt_count_nonnegative_check',
            'execution_jobs_lifecycle_counts_nonnegative_check',
            'tool_queue_counters_nonnegative_check',
            'workspace_queue_counters_nonnegative_check',
            'workspace_tool_queue_counters_nonnegative_check'
          )
          order by conname`,
      );
      assertEquals(
        constraints.rows.map((row: { conname: string }) => row.conname),
        [
          "execution_jobs_lifecycle_counts_nonnegative_check",
          "outbox_events_attempt_count_nonnegative_check",
          "tool_queue_counters_nonnegative_check",
          "workspace_queue_counters_nonnegative_check",
          "workspace_tool_queue_counters_nonnegative_check",
        ],
      );

      const index = await client.query<{ indexname: string }>(
        `select indexname from pg_indexes
          where schemaname = 'relay'
            and indexname = 'job_attempts_job_epoch_idx'`,
      );
      assertEquals(index.rows.length, 1);
    } finally {
      await client.end();
    }
  },
});
