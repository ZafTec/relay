import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * The transactional outbox from
 * docs/implementation-handoff/04-queue-capacity-scheduling.md
 * "Transactional outbox": "stable event ID, aggregate/version, type,
 * bounded payload, eligibility, lease, attempt count, publication time,
 * and last sanitized error." `aggregate_type`/`aggregate_id` are
 * deliberately unconstrained (no FK) -- an outbox row can reference any
 * aggregate (a tool_run, an execution_job, later an artifact), so it
 * can't have one real foreign key. Relay claims batches with
 * `for update skip locked` against `eligible_at`/`published_at`, per
 * that section.
 */
const CANONICAL_SQL = `
create table relay.outbox_events (
  id bigint generated always as identity primary key,
  aggregate_type text not null,
  aggregate_id text not null,
  aggregate_version bigint not null,
  event_type text not null,
  payload jsonb not null,
  eligible_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  published_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index outbox_events_unpublished_idx on relay.outbox_events (eligible_at) where published_at is null;
create index outbox_events_aggregate_idx on relay.outbox_events (aggregate_type, aggregate_id);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0012_outbox_events",
  checksumSha256:
    "ba57f80c147bc813fb27a26091b42e54bf9d0df98ee362260f59b55c954c286e",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
