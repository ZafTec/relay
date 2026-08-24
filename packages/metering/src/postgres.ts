import {
  assertMeteringTransaction,
  type MeteringTransaction,
} from "./transaction.ts";

/** Transaction-scoped and released automatically by PostgreSQL at commit/rollback. */
export async function lockIdempotencyKey(
  transaction: MeteringTransaction,
  workspaceId: string,
  operation: string,
  keyHash: string,
): Promise<void> {
  assertMeteringTransaction(transaction);
  await transaction.query(
    `select pg_advisory_xact_lock(
       pg_catalog.hashtext($1),
       pg_catalog.hashtext($2)
     )`,
    [workspaceId, `${operation}:${keyHash}`],
  );
}
