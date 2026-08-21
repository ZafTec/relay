import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * Durable audit log per
 * docs/implementation-handoff/07-observability-audit.md "Durable audit
 * events". Two things enforce "normal app role cannot update/delete audit
 * history" (that section's Wave 2B test requirement) at the database
 * level, not just in application code:
 *
 * - No default UPDATE/DELETE privilege carries over: relay_app's default
 *   privileges (scripts/dev/postgres-init/001-roles-and-schemas.sql) grant
 *   SELECT/INSERT/UPDATE/DELETE on tables relay_owner creates, so this
 *   migration explicitly revokes UPDATE/DELETE afterwards, leaving
 *   relay_app with INSERT/SELECT only.
 * - `idempotency_key` is UNIQUE (nullable -- Postgres allows multiple
 *   NULLs), so a retried governed action reusing the same key can
 *   `on conflict (idempotency_key) do nothing` instead of double-recording.
 *
 * `actor_user_id` uses `on delete set null`, not cascade -- the audit
 * trail outlives the account that produced it.
 */
const CANONICAL_SQL = `
create table relay.audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_type text not null,
  actor_user_id text references auth."user" ("id") on delete set null,
  oauth_client_id text,
  workspace_id text,
  action text not null,
  target_type text not null,
  target_id text,
  outcome text not null,
  reason_code text,
  before_snapshot jsonb,
  after_snapshot jsonb,
  request_id text,
  trace_id text,
  ip_hash_or_policy_value text,
  user_agent_summary text,
  idempotency_key text unique
);
create index audit_events_occurred_at_idx on relay.audit_events (occurred_at);
create index audit_events_actor_user_id_idx on relay.audit_events (actor_user_id);
create index audit_events_workspace_id_idx on relay.audit_events (workspace_id);
create index audit_events_action_idx on relay.audit_events (action);
revoke update, delete on relay.audit_events from relay_app;
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0005_audit_events",
  checksumSha256:
    "0cb83caa0afb4066058f9d24bc2cae4f7f3e8ad7ba071fd8302199a10cac3d1f",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
