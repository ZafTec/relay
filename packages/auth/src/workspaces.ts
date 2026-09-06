import { withTransaction } from "@relay/database";
import type { DatabasePool } from "@relay/database";

const PERSONAL_WORKSPACE_LOCK_NAMESPACE = 0x524c5957;
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
 * missing membership or restoring a downgraded membership to `owner`.
 * Execution capabilities and usage allowances require explicit grants.
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
      return organizationId;
    }

    const organizationId = crypto.randomUUID();
    await client.query(
      `insert into auth.organization (id, name, slug, "createdAt", metadata)
       values ($1, 'Personal', $2, now(), null)`,
      [organizationId, slug],
    );
    await ensureOwnerMembership(client, organizationId, userId);
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
