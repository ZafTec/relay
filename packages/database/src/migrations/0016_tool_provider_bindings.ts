import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * relay.tool_provider_bindings from
 * docs/implementation-handoff/05-domain-storage-metering.md "Tool
 * registry schema" -- which capacity pool and provider model serve a
 * published tool version, in what routing order. Bigint identity: an
 * operator-only catalog record, never in a public URL.
 */
const CANONICAL_SQL = `
create table relay.tool_provider_bindings (
  id bigint generated always as identity primary key,
  tool_version_id text not null references relay.tool_versions ("id"),
  provider_model_id bigint not null references relay.provider_models ("id"),
  capacity_pool_id bigint not null references relay.capacity_pools ("id"),
  routing_order integer not null,
  enabled boolean not null default true,
  routing_policy_id bigint references relay.routing_policies ("id"),
  created_at timestamptz not null default now(),
  unique (tool_version_id, provider_model_id)
);
create index tool_provider_bindings_tool_version_id_idx on relay.tool_provider_bindings (tool_version_id);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0016_tool_provider_bindings",
  checksumSha256:
    "e29f3975816184dabe5886cf6c75457036451c7ac2a5c021105af53f4482a46d",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
