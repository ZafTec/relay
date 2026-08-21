import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * System-level superadmin grants, separate from workspace roles per
 * docs/implementation-handoff/03-auth-workspaces.md "System superadmin".
 * A partial index over unrevoked rows keeps "does this user currently hold
 * a grant" queries cheap without a separate boolean/status column drifting
 * out of sync with the revoked_at timestamp.
 */
const CANONICAL_SQL = `
create table relay.system_role_assignments (
  id bigint generated always as identity primary key,
  user_id text not null references auth."user" ("id") on delete cascade,
  role text not null check (role = 'superadmin'),
  granted_by text not null references auth."user" ("id"),
  granted_at timestamptz not null default now(),
  revoked_by text references auth."user" ("id"),
  revoked_at timestamptz
);
create index system_role_assignments_active_idx
  on relay.system_role_assignments (user_id)
  where revoked_at is null;
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0003_system_role_assignments",
  checksumSha256:
    "fca53878c23ba1d705c2eeba8158967d531841961bb3fd23d935959748f28de5",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
