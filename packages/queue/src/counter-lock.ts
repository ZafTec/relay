import type pg from "pg";

const QUEUE_COUNTER_LOCK_KEY = "relay.queue-counter-reconciliation";

/**
 * Normal queue transitions share this lock. Reconciliation takes the exclusive
 * form, preventing an aggregate snapshot from overwriting a concurrent delta.
 */
export async function lockQueueCounterMutation(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(
    "select pg_advisory_xact_lock_shared(hashtext($1))",
    [QUEUE_COUNTER_LOCK_KEY],
  );
}

export async function lockQueueCounterReconciliation(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(
    "select pg_advisory_xact_lock(hashtext($1))",
    [QUEUE_COUNTER_LOCK_KEY],
  );
}
