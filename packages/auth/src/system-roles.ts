import type { DatabasePool } from "@relay/database";

export interface SystemRoleGrant {
  readonly id: string;
  readonly userId: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

/**
 * Never derived from email or provider profile -- callers must supply an
 * explicit `grantedBy` operator identity. Durable audit persistence is
 * Wave 2B's; until that lane merges and Wave 2 integration wires it in,
 * `onAudited` is the seam a caller can pass to record grant/revoke events
 * itself rather than this module reaching for an audit port that doesn't
 * exist yet.
 */
export interface SystemRoleAuditSink {
  onGrant?(grant: { userId: string; grantedBy: string }): Promise<void>;
  onRevoke?(revoke: { userId: string; revokedBy: string }): Promise<void>;
}

export async function grantSuperadmin(
  pool: DatabasePool,
  userId: string,
  grantedBy: string,
  audit: SystemRoleAuditSink = {},
): Promise<void> {
  await pool.query(
    `insert into relay.system_role_assignments (user_id, role, granted_by)
     values ($1, 'superadmin', $2)`,
    [userId, grantedBy],
  );
  await audit.onGrant?.({ userId, grantedBy });
}

export async function revokeSuperadmin(
  pool: DatabasePool,
  userId: string,
  revokedBy: string,
  audit: SystemRoleAuditSink = {},
): Promise<void> {
  await pool.query(
    `update relay.system_role_assignments
     set revoked_by = $2, revoked_at = now()
     where user_id = $1 and revoked_at is null`,
    [userId, revokedBy],
  );
  await audit.onRevoke?.({ userId, revokedBy });
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
