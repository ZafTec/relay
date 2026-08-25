import {
  type BackoffOptions,
  DEFAULT_OUTBOX_BACKOFF,
  jitteredBackoffMs,
  sanitizeError,
} from "./safety.ts";

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
  readonly leaseOwner: string;
}

interface OutboxEventDbRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string;
  event_type: string;
  payload: unknown;
  attempt_count: number;
  lease_owner: string;
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
    leaseOwner: row.lease_owner,
  };
}

export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 8;

/**
 * Finalizes claims that reached the attempt ceiling and then disappeared before
 * they could publish or record their failure. Without this recovery pass, the
 * strict `< maxAttempts` claim predicate would strand such rows forever.
 */
export async function finalizeExpiredOutboxAttempts(
  queryable: Queryable,
  maxAttempts = DEFAULT_OUTBOX_MAX_ATTEMPTS,
  eventTypes: readonly string[] | null = null,
): Promise<number> {
  const { rows } = await queryable.query<{ count: number }>(
    `with finalized as (
       update relay.outbox_events
          set failed_at = now(),
              lease_owner = null,
              lease_expires_at = null,
              last_error = coalesce(
                last_error,
                'Outbox claim expired after reaching the attempt ceiling'
              )
        where published_at is null
          and failed_at is null
          and attempt_count >= $1
          and (lease_expires_at is null or lease_expires_at < now())
          and ($2::text[] is null or event_type = any($2::text[]))
        returning 1
     )
     select count(*)::integer as count from finalized`,
    [maxAttempts, eventTypes === null ? null : [...eventTypes]],
  );
  return rows[0]?.count ?? 0;
}

/**
 * Claims a committed batch before doing any Redis I/O. Exhausted/terminal rows
 * are excluded, and each returned row carries both parts of its finalization
 * fence: lease owner and monotonically increasing attempt count.
 */
export async function claimOutboxBatch(
  queryable: Queryable,
  leaseOwner: string,
  leaseDurationMs: number,
  batchSize: number,
  maxAttempts = DEFAULT_OUTBOX_MAX_ATTEMPTS,
  eventTypes: readonly string[] | null = null,
): Promise<readonly OutboxEventRow[]> {
  const { rows } = await queryable.query<OutboxEventDbRow>(
    `update relay.outbox_events
       set lease_owner = $1,
           lease_expires_at = now() + ($2 || ' milliseconds')::interval,
           attempt_count = attempt_count + 1
     where id in (
       select id from relay.outbox_events
       where published_at is null
         and failed_at is null
         and attempt_count < $4
         and eligible_at <= now()
         and (lease_expires_at is null or lease_expires_at < now())
         and ($5::text[] is null or event_type = any($5::text[]))
       order by eligible_at, id
       limit $3
       for update skip locked
     )
     returning id, aggregate_type, aggregate_id, aggregate_version,
               event_type, payload, attempt_count, lease_owner`,
    [
      leaseOwner,
      leaseDurationMs,
      batchSize,
      maxAttempts,
      eventTypes === null ? null : [...eventTypes],
    ],
  );

  return rows.map(toOutboxEventRow);
}

export interface OutboxFinalizationResult {
  readonly finalized: boolean;
  readonly exhausted: boolean;
  readonly retryDelayMs?: number;
}

/**
 * Publication acknowledgment is conditional on the exact claim attempt. A
 * slow publisher cannot acknowledge a row after its lease expired and another
 * relay reclaimed it, even when the same process-level owner ID is reused.
 */
export async function markOutboxPublished(
  queryable: Queryable,
  event: Pick<OutboxEventRow, "id" | "leaseOwner" | "attemptCount">,
): Promise<boolean> {
  const { rows } = await queryable.query<{ id: string }>(
    `update relay.outbox_events
       set published_at = now(),
           lease_owner = null,
           lease_expires_at = null,
           last_error = null
     where id = $1
       and lease_owner = $2
       and attempt_count = $3
       and published_at is null
       and failed_at is null
     returning id`,
    [event.id, event.leaseOwner, event.attemptCount],
  );
  return rows.length === 1;
}

export interface MarkOutboxFailedOptions extends BackoffOptions {
  readonly maxAttempts: number;
  readonly random?: () => number;
}

const DEFAULT_FAILURE_OPTIONS: MarkOutboxFailedOptions = {
  ...DEFAULT_OUTBOX_BACKOFF,
  maxAttempts: DEFAULT_OUTBOX_MAX_ATTEMPTS,
};

/**
 * Records only sanitized bounded text. Retry eligibility uses exponential
 * backoff with bounded jitter; once the ceiling is reached, `failed_at` makes
 * the poison event permanently ineligible until an operator/reconciler
 * deliberately re-arms it.
 */
export async function markOutboxFailed(
  queryable: Queryable,
  event: Pick<OutboxEventRow, "id" | "leaseOwner" | "attemptCount">,
  error: unknown,
  options: MarkOutboxFailedOptions = DEFAULT_FAILURE_OPTIONS,
): Promise<OutboxFinalizationResult> {
  const exhausted = event.attemptCount >= options.maxAttempts;
  const retryDelayMs = exhausted
    ? undefined
    : jitteredBackoffMs(event.attemptCount, options, options.random);
  const sanitizedError = sanitizeError(error);
  const { rows } = exhausted
    ? await queryable.query<{ id: string }>(
      `update relay.outbox_events
          set failed_at = now(),
              lease_owner = null,
              lease_expires_at = null,
              last_error = $4
        where id = $1
          and lease_owner = $2
          and attempt_count = $3
          and published_at is null
          and failed_at is null
        returning id`,
      [event.id, event.leaseOwner, event.attemptCount, sanitizedError],
    )
    : await queryable.query<{ id: string }>(
      `update relay.outbox_events
          set eligible_at = now() + ($5 || ' milliseconds')::interval,
              lease_owner = null,
              lease_expires_at = null,
              last_error = $4
        where id = $1
          and lease_owner = $2
          and attempt_count = $3
          and published_at is null
          and failed_at is null
        returning id`,
      [
        event.id,
        event.leaseOwner,
        event.attemptCount,
        sanitizedError,
        retryDelayMs,
      ],
    );

  return {
    finalized: rows.length === 1,
    exhausted,
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
  };
}

export interface RelayOutboxBatchResult {
  readonly claimed: number;
  /** Successfully published and durably acknowledged under the claim fence. */
  readonly published: number;
  readonly failed: number;
  readonly exhausted: number;
  readonly lostLease: number;
}

export interface RelayOutboxOptions {
  readonly leaseOwner: string;
  readonly leaseDurationMs?: number;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly eventTypes?: readonly string[];
  readonly random?: () => number;
}

export const DEFAULT_RELAY_OUTBOX_OPTIONS: Required<
  Pick<
    RelayOutboxOptions,
    | "leaseDurationMs"
    | "batchSize"
    | "maxAttempts"
    | "baseDelayMs"
    | "maxDelayMs"
    | "jitterRatio"
  >
> = {
  leaseDurationMs: 30_000,
  batchSize: 50,
  maxAttempts: DEFAULT_OUTBOX_MAX_ATTEMPTS,
  ...DEFAULT_OUTBOX_BACKOFF,
};

/**
 * Publishes at least once. Deterministic BullMQ IDs absorb the common
 * publish-before-ack crash; PostgreSQL generation/epoch fencing absorbs every
 * remaining duplicate delivery.
 */
export async function relayOutboxBatch(
  queryable: Queryable,
  publish: (event: OutboxEventRow) => Promise<void>,
  options: RelayOutboxOptions,
): Promise<RelayOutboxBatchResult> {
  const maxAttempts = options.maxAttempts ??
    DEFAULT_RELAY_OUTBOX_OPTIONS.maxAttempts;
  const recoveredExhausted = await finalizeExpiredOutboxAttempts(
    queryable,
    maxAttempts,
    options.eventTypes ?? null,
  );
  const batch = await claimOutboxBatch(
    queryable,
    options.leaseOwner,
    options.leaseDurationMs ?? DEFAULT_RELAY_OUTBOX_OPTIONS.leaseDurationMs,
    options.batchSize ?? DEFAULT_RELAY_OUTBOX_OPTIONS.batchSize,
    maxAttempts,
    options.eventTypes ?? null,
  );

  let published = 0;
  let failed = 0;
  let exhausted = recoveredExhausted;
  let lostLease = 0;

  for (const event of batch) {
    try {
      await publish(event);
      if (await markOutboxPublished(queryable, event)) published += 1;
      else lostLease += 1;
    } catch (error) {
      const result = await markOutboxFailed(queryable, event, error, {
        baseDelayMs: options.baseDelayMs ??
          DEFAULT_RELAY_OUTBOX_OPTIONS.baseDelayMs,
        maxDelayMs: options.maxDelayMs ??
          DEFAULT_RELAY_OUTBOX_OPTIONS.maxDelayMs,
        jitterRatio: options.jitterRatio ??
          DEFAULT_RELAY_OUTBOX_OPTIONS.jitterRatio,
        maxAttempts: options.maxAttempts ??
          DEFAULT_RELAY_OUTBOX_OPTIONS.maxAttempts,
        random: options.random,
      });
      if (!result.finalized) lostLease += 1;
      else {
        failed += 1;
        if (result.exhausted) exhausted += 1;
      }
    }
  }

  return { claimed: batch.length, published, failed, exhausted, lostLease };
}
