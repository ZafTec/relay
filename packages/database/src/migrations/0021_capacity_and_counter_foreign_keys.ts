import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * More Wave 3 foreign keys left unconstrained by creation order or type
 * mismatch, in the same vein as 0019_wave3_foreign_keys.ts:
 *
 * - `capacity_pools.provider_model_id` was `text` (0006_capacity_pools_and_policies.ts,
 *   written before the Wave 3B catalog existed -- its own comment already
 *   flagged this: "has no FK yet -- the provider catalog is Wave 3B's").
 *   `relay.provider_models.id` (0014_provider_registry.ts) is
 *   `bigint generated always as identity`, so no FK could reference it
 *   without a type change. Every existing row has this column `null`
 *   (nothing writes it yet), so the type change is safe.
 * - `execution_jobs.capacity_lease_id` (bigint) and
 *   `relay.execution_capacity_leases.id` (bigint) already agree in type
 *   but were never actually constrained to each other.
 * - `tool_queue_counters.tool_id` and `workspace_tool_queue_counters.tool_id`
 *   (both `text`, predating the catalog like 0019's tool_version_id
 *   columns) now have a real `relay.tools.id` (`text`) to reference.
 */
const CANONICAL_SQL = `
alter table relay.capacity_pools
  alter column provider_model_id type bigint using provider_model_id::bigint;

alter table relay.capacity_pools
  add constraint capacity_pools_provider_model_id_fkey
  foreign key (provider_model_id) references relay.provider_models ("id");

alter table relay.execution_jobs
  add constraint execution_jobs_capacity_lease_id_fkey
  foreign key (capacity_lease_id) references relay.execution_capacity_leases ("id");

alter table relay.tool_queue_counters
  add constraint tool_queue_counters_tool_id_fkey
  foreign key (tool_id) references relay.tools ("id");

alter table relay.workspace_tool_queue_counters
  add constraint workspace_tool_queue_counters_tool_id_fkey
  foreign key (tool_id) references relay.tools ("id");
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0021_capacity_and_counter_foreign_keys",
  checksumSha256:
    "f29ef2fa5d79fd96667622e0dc5a405eb8785cf2c6212181691a921a619828cf",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
