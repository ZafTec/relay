import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * relay.idempotency_records supports the admission transaction in
 * docs/implementation-handoff/04-queue-capacity-scheduling.md "Acceptance
 * transaction" step 1 ("Resolve idempotency and return the existing run
 * for a matching replay") and
 * docs/implementation-handoff/06-http-mcp-events.md's "A matching replay
 * returns the original result/run. Same key with a different canonical
 * payload returns conflict." Scoped to (workspace_id, idempotency_key) --
 * the same client-supplied key means nothing across workspaces.
 */
const CANONICAL_SQL = `
create table relay.idempotency_records (
  id bigint generated always as identity primary key,
  workspace_id text not null references auth.organization ("id"),
  idempotency_key text not null,
  canonical_payload_hash text not null,
  run_id text references relay.tool_runs ("id"),
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0008_idempotency_records",
  checksumSha256:
    "9199cc54a0d098f75af6401043d768146ad49369fe828c4210770e51f2d29ae2",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
