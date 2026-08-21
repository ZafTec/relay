import type { DatabasePool } from "./pool.ts";
import type pg from "pg";

/**
 * Runs `fn` inside a single PostgreSQL transaction on one checked-out
 * client. Commits on success, rolls back and rethrows on any error
 * (including one thrown by `fn` after some statements already ran).
 * Callers needing "insert this row and this audit event atomically" use
 * this instead of two independent `pool.query` calls.
 */
export async function withTransaction<T>(
  pool: DatabasePool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}
