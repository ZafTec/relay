import { recordAuditEvent } from "@relay/audit";
import { withTransaction } from "@relay/database";
import type { DatabasePool } from "@relay/database";

export interface SystemRoleGrant {
  readonly id: string;
  readonly userId: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

/**
 * Grant/revoke and their audit event commit in one transaction (fail-closed:
 * an audit-insert failure rolls back the grant too) -- this is a governed,
 * security-sensitive action, per
 * docs/implementation-handoff/07-observability-audit.md "Durable audit
 * events" and "For fail-closed governed changes, insert the audit event in
 * the same PostgreSQL transaction as the change." Never derived from email
 * or provider profile -- callers must supply an explicit `grantedBy`/
 * `revokedBy` operator identity.
 */
export async function grantSuperadmin(
  pool: DatabasePool,
  userId: string,
  grantedBy: string,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `insert into relay.system_role_assignments (user_id, role, granted_by)
       values ($1, 'superadmin', $2)`,
      [userId, grantedBy],
    );
    await recordAuditEvent(client, {
      actorType: "user",
      actorUserId: grantedBy,
      action: "system_role.superadmin.grant",
      targetType: "user",
      targetId: userId,
      outcome: "success",
    });
  });
}

export async function revokeSuperadmin(
  pool: DatabasePool,
  userId: string,
  revokedBy: string,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `update relay.system_role_assignments
       set revoked_by = $2, revoked_at = now()
       where user_id = $1 and revoked_at is null`,
      [userId, revokedBy],
    );
    await recordAuditEvent(client, {
      actorType: "user",
      actorUserId: revokedBy,
      action: "system_role.superadmin.revoke",
      targetType: "user",
      targetId: userId,
      outcome: "success",
    });
  });
}

/**
 * Queries a current unrevoked grant on every call -- revocation must take
 * effect immediately, not after a session/cache window expires.
 */
export async function isSuperadmin(
  pool: DatabasePool,
  userId: string,
): Promise<boolean> {
  const result = await pool.query(
    `select 1 from relay.system_role_assignments
     where user_id = $1 and revoked_at is null
     limit 1`,
    [userId],
  );
  return (result.rowCount ?? 0) > 0;
}
