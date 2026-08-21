import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * relay.execution_capacity_leases from
 * docs/implementation-handoff/04-queue-capacity-scheduling.md "Suggested
 * durable fields" -- the durable record behind
 * `acquireExecutionLease`/`releaseExecutionLease` in that doc's "Capacity
 * coordinator" section. Redis holds the live lease state for fast checks;
 * this table is the durable source of truth reconciliation reads from.
 */
const CANONICAL_SQL = `
create table relay.execution_capacity_leases (
  id bigint generated always as identity primary key,
  job_id bigint not null references relay.execution_jobs ("id"),
  lease_epoch bigint not null,
  tool_id text not null,
  workspace_id text not null references auth.organization ("id"),
  capacity_pool_id bigint references relay.capacity_pools ("id"),
  units numeric not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  policy_revision integer
);
create index execution_capacity_leases_job_id_idx on relay.execution_capacity_leases (job_id);
create index execution_capacity_leases_active_idx
  on relay.execution_capacity_leases (capacity_pool_id)
  where released_at is null;
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0011_execution_capacity_leases",
  checksumSha256:
    "d6a8dfb49a3552cd5b773b9bdd776608d0c9c331c8c9be80a85ef459a81c4c84",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
