import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { lockQueueCounterMutation } from "./counter-lock.ts";
import { reconcileQueueCounters } from "./dispatch.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");

function testPool(): DatabasePool {
  return createDatabasePool(
    {
      url: new URL(databaseUrl!),
      poolMax: 2,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
    },
    "relay-worker",
  );
}

Deno.test({
  name: "counter reconciliation waits for in-flight shared transition locks",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await lockQueueCounterMutation(holder);

      let reconciled = false;
      const reconciliation = reconcileQueueCounters(pool).then(() => {
        reconciled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(reconciled, false);

      await holder.query("commit");
      await reconciliation;
      assertEquals(reconciled, true);
    } finally {
      try {
        await holder.query("rollback");
      } catch {
        // The transaction was already committed.
      }
      holder.release();
      await pool.end();
    }
  },
});
