/** Satisfied by both `pg.Pool` and a checked-out `pg.PoolClient`. */
export interface Queryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface OutboxEventRow {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly attemptCount: number;
}

interface OutboxEventDbRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string;
  event_type: string;
  payload: unknown;
  attempt_count: number;
}

function toOutboxEventRow(row: OutboxEventDbRow): OutboxEventRow {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    eventType: row.event_type,
    payload: row.payload,
    attemptCount: row.attempt_count,
  };
}

/**
 * Claims a batch of unpublished, eligible outbox rows for this relay
 * instance and marks them leased in the same statement, per
 * "Transactional outbox": `FOR UPDATE SKIP LOCKED`, commit the claim,
 * then perform Redis/BullMQ I/O outside the transaction. A single
 * `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` does the claim
 * and lease atomically without a separate multi-statement transaction.
 */
export async function claimOutboxBatch(
  queryable: Queryable,
  leaseOwner: string,
  leaseDurationMs: number,
  batchSize: number,
): Promise<readonly OutboxEventRow[]> {
  const { rows } = await queryable.query<OutboxEventDbRow>(
    `update relay.outbox_events
       set lease_owner = $1,
           lease_expires_at = now() + ($2 || ' milliseconds')::interval,
           attempt_count = attempt_count + 1
     where id in (
       select id from relay.outbox_events
       where published_at is null
         and eligible_at <= now()
         and (lease_expires_at is null or lease_expires_at < now())
       order by eligible_at
       limit $3
       for update skip locked
     )
     returning id, aggregate_type, aggregate_id, aggregate_version,
               event_type, payload, attempt_count`,
    [leaseOwner, leaseDurationMs, batchSize],
  );

  return rows.map(toOutboxEventRow);
}

export async function markOutboxPublished(
  queryable: Queryable,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;

  await queryable.query(
    `update relay.outbox_events
       set published_at = now(), lease_owner = null, lease_expires_at = null
     where id = any($1::bigint[])`,
    [ids],
  );
}

/**
 * A publish failure releases the lease (rather than clearing it to null,
 * which would make it immediately eligible for another relay's claim
 * during a hot failure loop) and records the sanitized error for
 * observability; the row stays unpublished so the next eligible claim
 * retries it.
 */
export async function markOutboxFailed(
  queryable: Queryable,
  id: string,
  sanitizedError: string,
): Promise<void> {
  await queryable.query(
    `update relay.outbox_events
       set lease_expires_at = now(), last_error = $2
     where id = $1`,
    [id, sanitizedError],
  );
}

export interface RelayOutboxBatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/**
 * Claims and publishes one batch. Publication is at least once by
 * design (the doc's own "Publication is at least once" -- a crash
 * between a successful `publish` and `markOutboxPublished` redelivers),
 * so `publish` must be idempotent at the BullMQ layer (deterministic
 * ticket IDs handle this) and downstream consumers must be fenced.
 */
export async function relayOutboxBatch(
  queryable: Queryable,
  publish: (event: OutboxEventRow) => Promise<void>,
  options: { leaseOwner: string; leaseDurationMs: number; batchSize: number },
): Promise<RelayOutboxBatchResult> {
  const batch = await claimOutboxBatch(
    queryable,
    options.leaseOwner,
    options.leaseDurationMs,
    options.batchSize,
  );

  const publishedIds: string[] = [];
  let failed = 0;

  for (const event of batch) {
    try {
      await publish(event);
      publishedIds.push(event.id);
    } catch (error) {
      failed += 1;
      await markOutboxFailed(
        queryable,
        event.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  await markOutboxPublished(queryable, publishedIds);

  return { claimed: batch.length, published: publishedIds.length, failed };
}
