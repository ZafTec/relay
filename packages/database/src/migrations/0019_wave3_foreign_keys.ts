import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * Foreign keys that were skippable when their tables were created --
 * `job_attempts`/`tool_runs`/`execution_jobs` all predate the Wave 3B
 * catalog they reference, so 0009_execution_jobs_and_attempts.ts and
 * 0007_tool_runs.ts left `tool_version_id` (and 0009 left
 * `routing_decision_id`) as bare `text` with no FK, matching the
 * "identity tables may be created without that FK until the catalog
 * lands" allowance in docs/implementation-handoff/01-execution-waves.md
 * "Wave 3.0" -- but not left dangling forever.
 * `tool_provider_bindings.tool_version_id` (0016_tool_provider_bindings.ts)
 * doesn't need this: it was created after the catalog existed and
 * already references `tool_versions` inline.
 *
 * `job_attempts.routing_decision_id` also needed a type fix, not just a
 * missing constraint: it was `text`, but `relay.routing_decisions.id`
 * (0017_routing_decisions.ts) is `bigint generated always as identity`,
 * so no FK could reference it without changing one side. Safe to alter
 * in place -- nothing in the codebase writes this column yet (routing
 * selection is Wave 3B integration/Wave 5's), so every existing row has
 * it `null`.
 */
const CANONICAL_SQL = `
alter table relay.job_attempts
  alter column routing_decision_id type bigint using routing_decision_id::bigint;

alter table relay.job_attempts
  add constraint job_attempts_routing_decision_id_fkey
  foreign key (routing_decision_id) references relay.routing_decisions ("id");

alter table relay.tool_runs
  add constraint tool_runs_tool_version_id_fkey
  foreign key (tool_version_id) references relay.tool_versions ("id");

alter table relay.execution_jobs
  add constraint execution_jobs_tool_version_id_fkey
  foreign key (tool_version_id) references relay.tool_versions ("id");
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0019_wave3_foreign_keys",
  checksumSha256:
    "6768a419c6033267de8b8a145183acd5d37bbf8af75a273cb5b4241039687683",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
