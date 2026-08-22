import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * relay.routing_decisions from
 * docs/implementation-handoff/05-domain-storage-metering.md "Tool
 * registry schema": "Every run references an immutable routing-decision
 * record ... The decision owns the one-to-one relationship through
 * unique `tool_run_id`; the run does not store a redundant reverse ID."
 * Not written by anything yet -- routing selection is Wave 3B
 * integration/Wave 5's, once a real provider exists to route to.
 */
const CANONICAL_SQL = `
create table relay.routing_decisions (
  id bigint generated always as identity primary key,
  tool_run_id text not null unique references relay.tool_runs ("id"),
  routing_policy_id bigint references relay.routing_policies ("id"),
  routing_policy_revision integer,
  selected_binding_id bigint not null references relay.tool_provider_bindings ("id"),
  provider_id bigint not null references relay.providers ("id"),
  provider_model_id bigint not null references relay.provider_models ("id"),
  requested_model_version text,
  fallback_used boolean not null default false,
  fallback_reason text,
  selected_at timestamptz not null default now()
);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0017_routing_decisions",
  checksumSha256:
    "8fafd8528ade776920196e1ea6dbcc63368878be8a1d4a4b6673c3835f220d9e",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
