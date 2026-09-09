import type { DatabasePool } from "@relay/database";
import { recordAuditEvent } from "@relay/audit";
import { withWorkspaceSession } from "./workspace-management.ts";

export interface McpConnection {
  id: string;
  clientId: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  scopes: string[];
  connectedAt: string;
}

export function listMcpConnections(
  pool: DatabasePool,
  sessionId: string,
): Promise<McpConnection[]> {
  return withWorkspaceSession(pool, sessionId, async (db, userId) => {
    const { rows } = await db.query<
      Omit<McpConnection, "connectedAt"> & { connectedAt: Date }
    >(
      `select consent.id, client."clientId", coalesce(client.name, 'Connected app') as name,
        o.id as "workspaceId", o.name as "workspaceName", consent.scopes, consent."createdAt" as "connectedAt"
       from auth."oauthConsent" consent
       join auth."oauthClient" client on client."clientId"=consent."clientId" and client.disabled is not true
       join auth.organization o on o.id=consent."referenceId"
       join auth.member m on m."organizationId"=o.id and m."userId"=$1
       where consent."userId"=$1 order by consent."createdAt" desc,consent.id limit 500`,
      [userId],
    );
    return rows.map((
      row: Omit<McpConnection, "connectedAt"> & { connectedAt: Date },
    ) => ({
      ...row,
      connectedAt: row.connectedAt.toISOString(),
    }));
  });
}

export function revokeMcpConnection(
  pool: DatabasePool,
  sessionId: string,
  connectionId: string,
): Promise<void> {
  return withWorkspaceSession(pool, sessionId, async (db, userId) => {
    const { rows } = await db.query<{ clientId: string; referenceId: string }>(
      `delete from auth."oauthConsent" where id=$1 and "userId"=$2 returning "clientId","referenceId"`,
      [connectionId, userId],
    );
    // An exact retry is safe; foreign IDs reveal no connection details.
    if (!rows[0]) return;
    for (const table of ["oauthAccessToken", "oauthRefreshToken"]) {
      await db.query(
        `update auth."${table}" set revoked=coalesce(revoked,now()) where "clientId"=$1 and "userId"=$2 and "referenceId" is not distinct from $3`,
        [rows[0].clientId, userId, rows[0].referenceId],
      );
    }
    await recordAuditEvent(db, {
      actorType: "user",
      actorUserId: userId,
      workspaceId: rows[0].referenceId,
      action: "mcp.connection.revoke",
      targetType: "oauth_consent",
      targetId: connectionId,
      outcome: "success",
    });
  });
}
