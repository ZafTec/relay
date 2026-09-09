import { sql } from "kysely";
import type { Migration } from "./types.ts";

export const CANONICAL_SQL = `
ALTER TABLE auth."oauthConsent" ADD COLUMN "legacyTokensAllowed" boolean NOT NULL DEFAULT false;
-- Preserve existing connections during rollout. Reconnecting after a disconnect
-- creates a new consent and requires its unique identity in the signed token.
UPDATE auth."oauthConsent" SET "legacyTokensAllowed"=true;
`;

export const migration: Migration = {
  id: "0010_mcp_connection_revocation",
  checksumSha256:
    "c92a42eb882f622f509521b803c66c095f747ff26126f9488ea5a1a47f4a568a",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
