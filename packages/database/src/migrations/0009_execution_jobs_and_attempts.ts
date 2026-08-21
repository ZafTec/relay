import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * relay.execution_jobs / relay.job_attempts from
 * docs/implementation-handoff/04-queue-capacity-scheduling.md "Suggested
 * durable fields". Both are internal (never in a public URL), so plain
 * bigint identity primary keys, unlike relay.tool_runs. `lease_epoch` is
 * the fencing token from "Worker claim and fencing" -- every state
 * mutation from a worker must present the expected epoch/owner, so a
 * stale worker recovering after a lease was reassigned cannot clobber
 * newer state. `submission_state`/`outcome`/`retry_classification` are
 * left as free-text: the handoff names these columns but does not
 * enumerate their values, and inventing that enum is Wave 3A's job
 * (BullMQ/retry-classification implementation), not this schema pass's.
 */
const CANONICAL_SQL = `
create table relay.execution_jobs (
  id bigint generated always as identity primary key,
  run_id text not null references relay.tool_runs ("id"),
  workspace_id text not null references auth.organization ("id"),
  tool_version_id text not null,
  capacity_pool_id bigint references relay.capacity_pools ("id"),
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled')),
  scheduling_class text not null,
  scheduling_policy_version integer,
  estimated_cost_units numeric,
  accepted_at timestamptz not null default now(),
  eligible_at timestamptz not null default now(),
  admission_deadline_at timestamptz,
  attempt_deadline_at timestamptz,
  run_deadline_at timestamptz,
  dispatch_generation integer not null default 0,
  attempt_count integer not null default 0,
  deferral_count integer not null default 0,
  lease_epoch bigint not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  capacity_lease_id bigint,
  capacity_policy_revision integer,
  cancel_requested_at timestamptz,
  terminal_at timestamptz,
  state_version bigint not null default 0
);
create index execution_jobs_run_id_idx on relay.execution_jobs (run_id);
create index execution_jobs_status_idx on relay.execution_jobs (status);
create index execution_jobs_capacity_pool_id_idx on relay.execution_jobs (capacity_pool_id);

create table relay.job_attempts (
  id bigint generated always as identity primary key,
  job_id bigint not null references relay.execution_jobs ("id"),
  attempt_number integer not null,
  lease_epoch bigint not null,
  submission_state text not null,
  provider_idempotency_key text,
  provider_operation_id text,
  routing_decision_id text,
  actual_model_version text,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz,
  finished_at timestamptz,
  outcome text,
  retry_classification text,
  sanitized_error text,
  unique (job_id, attempt_number)
);
create index job_attempts_job_id_idx on relay.job_attempts (job_id);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0009_execution_jobs_and_attempts",
  checksumSha256:
    "cb2e9be364b7c8871ed86b7c2530eb9a7cf4ba330fa5b05ba10c9ef67a673bcf",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
