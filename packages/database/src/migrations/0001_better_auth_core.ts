import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * Reviewed output of `npx auth@latest generate` against Relay's pinned
 * Better Auth 1.7.1 configuration (core auth + the `organization` plugin,
 * no other plugins yet -- `jwt`/`mcp` add their own tables in a later
 * migration when Wave 4B needs them). Generated against a disposable
 * database during the Wave 2A auth spike, then hand-reviewed and
 * schema-qualified into `auth` (Better Auth's own generated SQL is
 * unqualified/public by default; Relay keeps its default model names but
 * isolates ownership in the `auth` schema per
 * docs/implementation-handoff/02-runtime-database.md). Do not regenerate
 * and blindly replace this file -- diff any future Better Auth schema
 * change and add a new migration instead.
 */
const CANONICAL_SQL = `
create table auth."user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);
create table auth."session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references auth."user" ("id") on delete cascade, "activeOrganizationId" text);
create table auth."account" ("id" text not null primary key, "issuer" text not null, "accountId" text not null, "providerId" text not null, "userId" text not null references auth."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);
create table auth."verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);
create table auth."organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" timestamptz not null, "metadata" text);
create table auth."member" ("id" text not null primary key, "organizationId" text not null references auth."organization" ("id") on delete cascade, "userId" text not null references auth."user" ("id") on delete cascade, "role" text not null, "createdAt" timestamptz not null);
create table auth."invitation" ("id" text not null primary key, "organizationId" text not null references auth."organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "inviterId" text not null references auth."user" ("id") on delete cascade);
create index "session_userId_idx" on auth."session" ("userId");
create index "account_userId_idx" on auth."account" ("userId");
create index "verification_identifier_idx" on auth."verification" ("identifier");
create index "member_organizationId_idx" on auth."member" ("organizationId");
create index "member_userId_idx" on auth."member" ("userId");
create index "invitation_organizationId_idx" on auth."invitation" ("organizationId");
create index "invitation_email_idx" on auth."invitation" ("email");
create unique index "account_issuer_accountId_uidx" on auth."account" ("issuer", "accountId");
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0001_better_auth_core",
  checksumSha256:
    "bf4093d1a75015316de580d2ae4e709298b89a9190b797ab0825a69e88076ce1",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
