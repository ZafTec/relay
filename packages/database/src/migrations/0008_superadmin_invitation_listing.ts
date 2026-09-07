import { sql } from "kysely";
import type { Migration } from "./types.ts";

// The invitation subquery exposes camelCase response fields. Its aggregate
// must order by that exposed alias, not the underlying table's column name.
export const CANONICAL_SQL = `
CREATE OR REPLACE FUNCTION relay.list_superadmin_access(p_session text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
BEGIN
  PERFORM relay.require_fresh_superadmin_session(p_session);
  RETURN jsonb_build_object(
    'admins', (SELECT coalesce(jsonb_agg(jsonb_build_object('userId',u.id,'name',u.name,'email',u.email,'grantedAt',r.granted_at) ORDER BY r.granted_at), '[]') FROM relay.system_role_assignments r JOIN auth."user" u ON u.id=r.user_id WHERE r.revoked_at IS NULL),
    'invitations', (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i."createdAt" DESC), '[]') FROM (SELECT id,email,created_at AS "createdAt",expires_at AS "expiresAt",accepted_at AS "acceptedAt",revoked_at AS "revokedAt" FROM relay.superadmin_invitations ORDER BY created_at DESC LIMIT 100) i)
  );
END;
$body$;
`;

export const migration: Migration = {
  id: "0008_superadmin_invitation_listing",
  checksumSha256:
    "4b6c34639a81a6100c1fba8e1b4d231e8052727171eebed787cc69944907b986",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
