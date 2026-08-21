import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * Better Auth's database-backed rate-limit table, discovered missing from
 * 0001_better_auth_core by running the integration tests in
 * packages/auth/src/auth_test.ts against a database migrated with only
 * that migration applied: `rateLimit: { storage: "database" }` in
 * packages/auth/src/auth.ts queries this table on every request, and
 * 0001 was generated before that config existed. Added as a new migration
 * rather than editing 0001 -- once a migration is committed its checksum
 * is immutable, per docs/implementation-handoff/02-runtime-database.md
 * "Migration requirements".
 */
const CANONICAL_SQL = `
create table auth."rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0004_better_auth_rate_limit",
  checksumSha256:
    "14d0a9c124ac4a56cfbd045aa92edce79490e5b54463073da848c3eb20cadded",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
