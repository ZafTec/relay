import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * The three durable queue-depth counter tables from
 * docs/implementation-handoff/04-queue-capacity-scheduling.md "Suggested
 * durable fields". The admission transaction locks these three rows
 * (global-tool, workspace-total, workspace-tool) in that fixed order to
 * avoid deadlocks -- see that section's step 4. `tool_id` has no FK
 * (Wave 3B's catalog); `workspace_id` references the same
 * auth.organization Better Auth already owns.
 */
const CANONICAL_SQL = `
create table relay.tool_queue_counters (
  tool_id text primary key,
  queued_count integer not null default 0,
  running_count integer not null default 0,
  updated_at timestamptz not null default now()
);
create table relay.workspace_queue_counters (
  workspace_id text primary key references auth.organization ("id"),
  queued_count integer not null default 0,
  running_count integer not null default 0,
  updated_at timestamptz not null default now()
);
create table relay.workspace_tool_queue_counters (
  workspace_id text not null references auth.organization ("id"),
  tool_id text not null,
  queued_count integer not null default 0,
  running_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, tool_id)
);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0010_queue_counters",
  checksumSha256:
    "6c31c63adc909512af64b8ebc721ad8faffe1286003403239fc34b53ec7dd5a0",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
