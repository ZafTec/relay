import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * Completes the durable execution lifecycle needed by the queue worker.
 *
 * Outbox rows need a terminal failure marker so an exhausted poison event is
 * not claimed forever, plus a stable dispatch key that reconciliation can
 * re-arm after BullMQ data loss without creating duplicate durable events.
 * Capacity leases need to retain the opaque Redis lease ID and the exact scope
 * keys that were acquired; PostgreSQL can then reconstruct Redis after a reset
 * and can release an orphaned lease after worker failure.
 */
const CANONICAL_SQL = `
alter table relay.outbox_events
  add column failed_at timestamptz,
  add column deduplication_key text;

update relay.outbox_events
set last_error = left(last_error, 512)
where char_length(last_error) > 512;

alter table relay.outbox_events
  add constraint outbox_events_last_error_length_check
    check (last_error is null or char_length(last_error) <= 512),
  add constraint outbox_events_single_terminal_state_check
    check (published_at is null or failed_at is null);

create unique index outbox_events_deduplication_key_idx
  on relay.outbox_events (deduplication_key)
  where deduplication_key is not null;

create index outbox_events_retryable_idx
  on relay.outbox_events (eligible_at)
  where published_at is null and failed_at is null;

alter table relay.execution_capacity_leases
  add column redis_lease_id text,
  add column redis_scope_keys jsonb,
  add column lease_owner text;

alter table relay.execution_capacity_leases
  add constraint execution_capacity_leases_scope_keys_check
    check (redis_scope_keys is null or jsonb_typeof(redis_scope_keys) = 'array');

create unique index execution_capacity_leases_job_epoch_idx
  on relay.execution_capacity_leases (job_id, lease_epoch);

create unique index execution_capacity_leases_redis_lease_id_idx
  on relay.execution_capacity_leases (redis_lease_id)
  where redis_lease_id is not null;

create unique index job_attempts_job_epoch_idx
  on relay.job_attempts (job_id, lease_epoch);

alter table relay.outbox_events
  add constraint outbox_events_attempt_count_nonnegative_check
    check (attempt_count >= 0);

alter table relay.execution_jobs
  add constraint execution_jobs_lifecycle_counts_nonnegative_check
    check (
      dispatch_generation >= 0
      and attempt_count >= 0
      and deferral_count >= 0
    );

alter table relay.tool_queue_counters
  add constraint tool_queue_counters_nonnegative_check
    check (queued_count >= 0 and running_count >= 0);

alter table relay.workspace_queue_counters
  add constraint workspace_queue_counters_nonnegative_check
    check (queued_count >= 0 and running_count >= 0);

alter table relay.workspace_tool_queue_counters
  add constraint workspace_tool_queue_counters_nonnegative_check
    check (queued_count >= 0 and running_count >= 0);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0026_execution_lifecycle",
  checksumSha256:
    "797fcf2e0a7f3fec9cc0c2377900ab07efe89b4c19ea8e765cd140600b8e2470",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
