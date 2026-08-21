import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * relay.tool_runs from
 * docs/implementation-handoff/04-queue-capacity-scheduling.md "Suggested
 * durable fields". `id` is application-generated
 * (`@relay/contracts`'s `generatePublicId("run")`), not a DB identity or
 * raw UUID -- this is Relay's one directly public-facing Wave 3.0 table
 * (`/api/v1/tool-runs/:runId`, MCP `runId`), per the owner's public-ID
 * convention. `tool_version_id` has no FK yet -- the tool/version catalog
 * is Wave 3B's, a parallel lane (same deferred-FK allowance as
 * 0006). `status` reuses the same six canonical states as
 * `@relay/contracts`'s `JOB_STATUSES` (queued/running/succeeded/failed/
 * cancel_requested/cancelled).
 */
const CANONICAL_SQL = `
create table relay.tool_runs (
  id text primary key,
  workspace_id text not null references auth.organization ("id"),
  tool_version_id text not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled')),
  result_completeness text,
  input jsonb not null,
  output_set_id text,
  reservation_id text,
  idempotency_record_id bigint,
  created_by text not null references auth."user" ("id"),
  accepted_at timestamptz not null default now(),
  started_at timestamptz,
  terminal_at timestamptz
);
create index tool_runs_workspace_id_idx on relay.tool_runs (workspace_id, accepted_at);
create index tool_runs_status_idx on relay.tool_runs (status);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0007_tool_runs",
  checksumSha256:
    "606d20d6941aa4c1b39380b563f3f9844711ebd4a76cc1e66b18763f26c1fe67",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
