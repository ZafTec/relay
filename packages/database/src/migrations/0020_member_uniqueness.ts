import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * `auth.member` (Better Auth's own table, 0001_better_auth_core.ts) had no
 * constraint preventing two membership rows for the same
 * (organization, user) pair -- only a synthetic `id` primary key. That
 * gap let `ensurePersonalWorkspace`'s membership-healing check
 * (packages/auth/src/workspaces.ts) create duplicate rows under real
 * concurrency: a plain "select, then insert if missing" is a
 * check-then-act race, and five concurrent session-create calls for a
 * brand-new user really did produce five membership rows in the live
 * test suite. A unique constraint plus `ON CONFLICT DO NOTHING` (see that
 * file's rewritten `ensureMembership`) is the actual fix; this migration
 * is what makes that possible, and stands on its own as a correct
 * invariant regardless -- one user should never have two membership rows
 * in the same organization.
 */
const CANONICAL_SQL = `
alter table auth.member
  add constraint member_organization_id_user_id_key unique ("organizationId", "userId");
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0020_member_uniqueness",
  checksumSha256:
    "0f262eb30cb1955d520729f6a9c0f2e8f554f9a767f31f387b43fa0d0c7e95ac",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
