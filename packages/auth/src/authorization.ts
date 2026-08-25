export type WorkspaceRole = "owner" | "admin" | "member";

/**
 * Satisfied by both `pg.Pool` and a checked-out `pg.PoolClient`. Accepting
 * either lets callers running inside a transaction (e.g. `admitToolRun`,
 * which holds a `poolMax: 1` connection via `withTransaction`) pass their
 * transaction's own client instead of `pool.query()` reaching back into the
 * pool for a second connection -- which, with only one connection in the
 * pool, would block forever waiting on the connection the caller itself is
 * still holding.
 */
export interface Queryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * `activeOrganizationId` on a session is context, not proof -- every
 * domain action must query current membership itself
 * (docs/implementation-handoff/03-auth-workspaces.md "Organization
 * configuration"). This is that query: a client-supplied workspace ID with
 * no matching membership row returns `null`, which callers must treat as
 * "deny," not "assume the personal workspace."
 */
export async function getMembership(
  queryable: Queryable,
  organizationId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const result = await queryable.query<{ role: WorkspaceRole }>(
    `select role from auth.member
     where "organizationId" = $1 and "userId" = $2`,
    [organizationId, userId],
  );
  return result.rows[0]?.role ?? null;
}

async function countOwners(
  queryable: Queryable,
  organizationId: string,
): Promise<number> {
  const result = await queryable.query<{ count: string }>(
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
  queryable: Queryable,
  organizationId: string,
  memberRole: WorkspaceRole,
): Promise<boolean> {
  if (memberRole !== "owner") return true;
  return (await countOwners(queryable, organizationId)) > 1;
}
