import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * relay.tools / relay.tool_versions from
 * docs/implementation-handoff/05-domain-storage-metering.md "Tool
 * registry schema". Both are public-facing (`/api/v1/tools/:toolId`,
 * MCP tool listings), so `id` is application-generated
 * (`@relay/contracts`'s `generatePublicId("tool"|"tver")`), not a DB
 * identity or raw UUID -- same convention as `relay.tool_runs`.
 *
 * `tools.active_version_id` and `tool_versions.tool_id` are mutually
 * referential, so `tool_versions` is created second and the FK from
 * `tools` back to it is added afterward in the same migration rather
 * than left dangling. "Published tool versions are immutable" is
 * enforced by the catalog service (never updating a published row), not
 * by a database constraint -- the schema alone can't express
 * "immutable after this timestamp is set."
 */
const CANONICAL_SQL = `
create table relay.tools (
  id text primary key,
  key text not null unique,
  name text not null,
  category text,
  summary text,
  lifecycle text not null check (lifecycle in ('draft', 'internal', 'published', 'deprecated', 'retired', 'disabled')),
  active_version_id text,
  visibility text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tools_lifecycle_idx on relay.tools (lifecycle);

create table relay.tool_versions (
  id text primary key,
  tool_id text not null references relay.tools ("id"),
  version integer not null,
  input_schema jsonb not null,
  output_schema jsonb not null,
  handler_key text not null,
  execution_mode text not null,
  max_duration_seconds integer not null,
  meter_policy_id text,
  entitlement_key text,
  compatibility_metadata jsonb,
  published_at timestamptz,
  deprecated_at timestamptz,
  retired_at timestamptz,
  immutable_hash text not null,
  created_at timestamptz not null default now(),
  unique (tool_id, version)
);
create index tool_versions_tool_id_idx on relay.tool_versions (tool_id);

alter table relay.tools
  add constraint tools_active_version_id_fkey
  foreign key (active_version_id) references relay.tool_versions ("id");
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0013_tool_registry",
  checksumSha256:
    "aadbcbee222387abf89bf9dc588b33ae65f2b6a6a462c7821be2bede50194fd6",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
