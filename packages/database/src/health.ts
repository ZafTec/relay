import type { ReadinessCheck } from "@relay/contracts";
import type { DatabasePool } from "./pool.ts";

/**
 * Proves only that the pool can reach PostgreSQL and run a trivial query.
 * Never includes connection strings or raw driver errors in the result --
 * those may contain host/credential detail.
 */
export async function checkDatabaseHealth(
  pool: DatabasePool,
): Promise<ReadinessCheck> {
  try {
    await pool.query("select 1");
    return { name: "database", status: "ok" };
  } catch {
    return {
      name: "database",
      status: "error",
      message: "unreachable",
    };
  }
}
