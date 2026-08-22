import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * relay.routing_policies from
 * docs/implementation-handoff/05-domain-storage-metering.md "Tool
 * registry schema": "operational routing may change only through a
 * versioned routing policy." Revisions are immutable and globally
 * numbered (the doc lists no scope column here, unlike
 * `relay.capacity_policies`'s `scope_type`/`scope_id`) -- Relay has one
 * routing policy lineage, not one per tool/provider.
 */
const CANONICAL_SQL = `
create table relay.routing_policies (
  id bigint generated always as identity primary key,
  revision integer not null unique,
  policy jsonb not null,
  effective_at timestamptz not null default now(),
  immutable_hash text not null
);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0015_routing_policies",
  checksumSha256:
    "794214e413fcfad14be663ff14612ea4afe21a45f9ff0ca4c5ee8d081e94cb2a",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
