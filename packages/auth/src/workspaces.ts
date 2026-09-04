import { withTransaction } from "@relay/database";
import type { DatabasePool } from "@relay/database";

const PERSONAL_WORKSPACE_LOCK_NAMESPACE = 0x524c5957;
const PERSONAL_WORKSPACE_GRANT_ID_NAMESPACE = "relay:mvp-entitlement:v1";
const PERSONAL_WORKSPACE_GRANT_SOURCE_KIND = "system";
const PERSONAL_WORKSPACE_GRANT_SOURCE_REFERENCE = "relay.mvp.defaults.v1";

interface PersonalWorkspaceGrantDefinition {
  readonly entitlementKey: string;
  readonly grantKind: "capability" | "limit";
  readonly capabilityEnabled: boolean | null;
  readonly limitAmount: number | null;
  readonly unit: string | null;
  readonly period: string | null;
}

const PERSONAL_WORKSPACE_GRANTS: readonly PersonalWorkspaceGrantDefinition[] = [
  {
    entitlementKey: "tools.execute",
    grantKind: "capability",
    capabilityEnabled: true,
    limitAmount: null,
    unit: null,
    period: null,
  },
  {
    entitlementKey: "images.generated",
    grantKind: "limit",
    capabilityEnabled: null,
    limitAmount: null,
    unit: "image",
    period: "calendar_month",
  },
  {
    entitlementKey: "ocr.requests",
    grantKind: "limit",
    capabilityEnabled: null,
    limitAmount: null,
    unit: "request",
    period: "calendar_month",
  },
];

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Stable, opaque, and independent of mutable profile data such as email/name.
 * The first 128 SHA-256 bits are ample for the unique slug namespace while
 * keeping the generated value short enough to use in URLs later.
 */
export async function personalWorkspaceSlug(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`relay-personal-workspace:${userId}`),
  );
  return `personal-${bytesToHex(new Uint8Array(digest)).slice(0, 32)}`;
}

/**
 * Creates or repairs a user's personal workspace as one PostgreSQL transaction.
 * The transaction-scoped advisory lock serializes every provisioning attempt
 * for the same user before any state is inspected, so no losing caller can
 * create an orphan organization. Existing mappings are healed by inserting a
 * missing membership, restoring a downgraded membership to `owner`, and
 * inserting any missing bootstrap entitlement grants without mutating existing
 * grants.
 */
export async function ensurePersonalWorkspace(
  pool: DatabasePool,
  userId: string,
): Promise<string> {
  const slug = await personalWorkspaceSlug(userId);

  return await withTransaction(pool, async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, $2::bigint))",
      [userId, PERSONAL_WORKSPACE_LOCK_NAMESPACE],
    );

    const existing = await client.query<{ organization_id: string }>(
      "select organization_id from relay.personal_workspaces where user_id = $1",
      [userId],
    );

    if (existing.rows[0]) {
      const organizationId = existing.rows[0].organization_id;
      await ensureOwnerMembership(client, organizationId, userId);
      await ensureBootstrapEntitlementGrants(client, organizationId);
      return organizationId;
    }

    const organizationId = crypto.randomUUID();
    await client.query(
      `insert into auth.organization (id, name, slug, "createdAt", metadata)
       values ($1, 'Personal', $2, now(), null)`,
      [organizationId, slug],
    );
    await ensureOwnerMembership(client, organizationId, userId);
    await ensureBootstrapEntitlementGrants(client, organizationId);
    await client.query(
      `insert into relay.personal_workspaces (user_id, organization_id)
       values ($1, $2)`,
      [userId, organizationId],
    );

    return organizationId;
  });
}

interface Queryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

async function personalWorkspaceGrantId(
  workspaceId: string,
  definition: PersonalWorkspaceGrantDefinition,
): Promise<string> {
  const identity =
    `${PERSONAL_WORKSPACE_GRANT_ID_NAMESPACE}:${workspaceId}:${definition.entitlementKey}:${definition.grantKind}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  return `grant_${bytesToHex(new Uint8Array(digest))}`;
}

async function ensureBootstrapEntitlementGrants(
  queryable: Queryable,
  workspaceId: string,
): Promise<void> {
  const grants = await Promise.all(
    PERSONAL_WORKSPACE_GRANTS.map(async (definition) => ({
      id: await personalWorkspaceGrantId(workspaceId, definition),
      entitlement_key: definition.entitlementKey,
      grant_kind: definition.grantKind,
      capability_enabled: definition.capabilityEnabled,
      limit_amount: definition.limitAmount,
      unit: definition.unit,
      period: definition.period,
    })),
  );

  await queryable.query(
    `insert into relay.entitlement_grants (
       id, workspace_id, entitlement_key, grant_kind, capability_enabled,
       limit_amount, unit, period, source_kind, source_reference,
       subscription_snapshot_id, effective_at, expires_at, revoked_at,
       metadata, created_at
     )
     select required_grant.id, $1, required_grant.entitlement_key,
            required_grant.grant_kind, required_grant.capability_enabled,
            required_grant.limit_amount, required_grant.unit,
            required_grant.period, $3::text, $4::text, null,
            pg_catalog.transaction_timestamp(), null, null,
            pg_catalog.jsonb_build_object('seed', $4::text),
            pg_catalog.transaction_timestamp()
       from pg_catalog.jsonb_to_recordset($2::jsonb) as required_grant(
         id text,
         entitlement_key text,
         grant_kind text,
         capability_enabled boolean,
         limit_amount numeric,
         unit text,
         period text
       )
      where not exists (
        select 1
          from relay.entitlement_grants as existing_grant
         where existing_grant.workspace_id = $1
           and existing_grant.entitlement_key = required_grant.entitlement_key
           and existing_grant.grant_kind = required_grant.grant_kind
           and existing_grant.source_kind = $3
           and existing_grant.source_reference = $4
      )
     on conflict (id) do nothing`,
    [
      workspaceId,
      JSON.stringify(grants),
      PERSONAL_WORKSPACE_GRANT_SOURCE_KIND,
      PERSONAL_WORKSPACE_GRANT_SOURCE_REFERENCE,
    ],
  );
}

async function ensureOwnerMembership(
  queryable: Queryable,
  organizationId: string,
  userId: string,
): Promise<void> {
  await queryable.query(
    `insert into auth.member as existing
       (id, "organizationId", "userId", role, "createdAt")
     values (gen_random_uuid()::text, $1, $2, 'owner', now())
     on conflict ("organizationId", "userId") do update
       set role = excluded.role
       where existing.role is distinct from excluded.role`,
    [organizationId, userId],
  );
}
