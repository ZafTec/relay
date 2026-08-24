import type { MeteringQueryExecutor } from "./types.ts";

const METERING_TRANSACTION: unique symbol = Symbol(
  "relay.metering.transaction",
);

/**
 * A query executor proven to be inside an explicit PostgreSQL transaction.
 * The brand prevents transaction-only APIs from accepting a pool or an
 * unverified client through normal TypeScript calls.
 */
export interface MeteringTransaction extends MeteringQueryExecutor {
  readonly [METERING_TRANSACTION]: true;
}

/**
 * Verifies that `queryable` is the caller's already-open transaction and then
 * exposes it through a branded callback. This function never begins, commits,
 * or rolls back the caller's transaction, so queue admission can compose
 * reservation, run, job, and outbox writes atomically.
 *
 * PostgreSQL rejects SAVEPOINT outside an explicit transaction with 25P01.
 * A unique probe name also makes nested metering scopes safe.
 */
export async function withMeteringTransaction<T>(
  queryable: MeteringQueryExecutor,
  operation: (transaction: MeteringTransaction) => Promise<T>,
): Promise<T> {
  const savepoint = `relay_metering_probe_${
    crypto.randomUUID().replaceAll("-", "")
  }`;
  await queryable.query(`savepoint ${savepoint}`);
  await queryable.query(`release savepoint ${savepoint}`);
  const transaction: MeteringTransaction = {
    [METERING_TRANSACTION]: true,
    query<Row>(text: string, params?: unknown[]) {
      return queryable.query<Row>(text, params);
    },
  };
  return await operation(transaction);
}

export function assertMeteringTransaction(
  transaction: MeteringTransaction,
): void {
  if (transaction[METERING_TRANSACTION] !== true) {
    throw new TypeError(
      "Metering mutations require withMeteringTransaction inside an open PostgreSQL transaction",
    );
  }
}
