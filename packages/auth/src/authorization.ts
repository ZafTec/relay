import type { DatabasePool } from "@relay/database";

export type WorkspaceRole = "owner" | "admin" | "member";

/**
 * `activeOrganizationId` on a session is context, not proof -- every
 * domain action must query current membership itself
 * (docs/implementation-handoff/03-auth-workspaces.md "Organization
 * configuration"). This is that query: a client-supplied workspace ID with
 * no matching membership row returns `null`, which callers must treat as
 * "deny," not "assume the personal workspace."
 */
export async function getMembership(
  pool: DatabasePool,
  organizationId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const result = await pool.query<{ role: WorkspaceRole }>(
    `select role from auth.member
     where "organizationId" = $1 and "userId" = $2`,
    [organizationId, userId],
  );
  return result.rows[0]?.role ?? null;
}

async function countOwners(
  pool: DatabasePool,
  organizationId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `select count(*) from auth.member
     where "organizationId" = $1 and role = 'owner'`,
    [organizationId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

/**
 * The last owner of a workspace cannot be removed or leave without first
 * transferring ownership -- there is no ownership-transfer flow yet, so
 * this currently just means the last owner can never be removed.
 */
export async function canRemoveMember(
  pool: DatabasePool,
  organizationId: string,
  memberRole: WorkspaceRole,
): Promise<boolean> {
  if (memberRole !== "owner") return true;
  return (await countOwners(pool, organizationId)) > 1;
}
