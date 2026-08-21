import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * Application-owned mapping from a Better Auth user to their one personal
 * workspace (Better Auth organization), per
 * docs/implementation-handoff/03-auth-workspaces.md "Personal workspace
 * provisioning". `user_id` as primary key is the concurrency-safety
 * mechanism: `ensurePersonalWorkspace` does
 * `insert ... on conflict (user_id) do nothing returning organization_id`,
 * so concurrent provisioning attempts for the same user always converge on
 * exactly one row, with exactly one of them actually creating the
 * organization/member rows.
 */
const CANONICAL_SQL = `
create table relay.personal_workspaces (
  user_id text primary key references auth."user" ("id") on delete cascade,
  organization_id text not null unique references auth."organization" ("id") on delete cascade,
  created_at timestamptz not null default now()
);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0002_personal_workspaces",
  checksumSha256:
    "1fb4ec1945c4f6b88fe852a2a5d8068719666e2df5dfa93a640a98732f4bdfef",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
