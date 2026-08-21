import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * relay.capacity_pools / relay.capacity_policies from
 * docs/implementation-handoff/04-queue-capacity-scheduling.md "Suggested
 * durable fields". `provider_model_id` has no FK yet -- the provider
 * catalog is Wave 3B's, a parallel lane; per
 * docs/implementation-handoff/01-execution-waves.md "Wave 3.0", identity
 * tables may be created without that FK until the catalog lands. Policies
 * are versioned by `revision` rather than updated in place so a running
 * job can keep referencing the exact policy it was admitted under.
 */
const CANONICAL_SQL = `
create table relay.capacity_pools (
  id bigint generated always as identity primary key,
  key text not null unique,
  provider_model_id text,
  region text,
  execution_class text not null,
  enabled boolean not null default true
);
create table relay.capacity_policies (
  id bigint generated always as identity primary key,
  scope_type text not null,
  scope_id text not null,
  revision integer not null,
  configuration jsonb not null,
  effective_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (scope_type, scope_id, revision)
);
create index capacity_policies_scope_idx on relay.capacity_policies (scope_type, scope_id, effective_at);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0006_capacity_pools_and_policies",
  checksumSha256:
    "03395db4de0544431277e7c02f2aec78b5b2b6a6f45126eac1e36c1b71cb786c",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
