import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * relay.providers / relay.provider_models from
 * docs/implementation-handoff/05-domain-storage-metering.md "Tool
 * registry schema". Neither carries a public-ID prefix in that doc's
 * "IDs and terminology" list (unlike `tool_*`/`tver_*`) -- these are
 * operator-only catalog records, never embedded in a public URL, so
 * plain bigint identity primary keys, matching `relay.capacity_pools`.
 */
const CANONICAL_SQL = `
create table relay.providers (
  id bigint generated always as identity primary key,
  key text not null unique,
  name text not null,
  lifecycle text not null check (lifecycle in ('draft', 'internal', 'published', 'deprecated', 'retired', 'disabled')),
  configuration_reference text,
  created_at timestamptz not null default now()
);

create table relay.provider_models (
  id bigint generated always as identity primary key,
  provider_id bigint not null references relay.providers ("id"),
  key text not null,
  display_name text not null,
  capability_schema jsonb,
  pricing_policy_id text,
  lifecycle text not null check (lifecycle in ('draft', 'internal', 'published', 'deprecated', 'retired', 'disabled')),
  region_constraints jsonb,
  created_at timestamptz not null default now(),
  unique (provider_id, key)
);
create index provider_models_provider_id_idx on relay.provider_models (provider_id);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0014_provider_registry",
  checksumSha256:
    "8fef922009af6ace0a3455f339718791fb1c4802e55f93f9f338d4ba017695a1",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
