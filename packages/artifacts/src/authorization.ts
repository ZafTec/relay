import type { ArtifactQueryable } from "./database.ts";

export async function hasWorkspaceMembership(
  queryable: ArtifactQueryable,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await queryable.query<{ present: boolean }>(
    `select exists (
       select 1
       from auth.member
       where "organizationId" = $1 and "userId" = $2
     ) as present`,
    [workspaceId, userId],
  );
  return rows[0]?.present === true;
}
