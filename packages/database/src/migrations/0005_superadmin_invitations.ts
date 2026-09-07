import { sql } from "kysely";
import type { Migration } from "./types.ts";

export const CANONICAL_SQL = `
CREATE TABLE relay.superadmin_invitations (
  id text PRIMARY KEY CHECK (id ~ '^sinv_[0-9a-f]{32}$'),
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  invited_by text NOT NULL REFERENCES auth."user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_by text REFERENCES auth."user"(id),
  accepted_at timestamptz,
  revoked_by text REFERENCES auth."user"(id),
  revoked_at timestamptz,
  CHECK ((accepted_at IS NULL) = (accepted_by IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX superadmin_invitations_email ON relay.superadmin_invitations(email, created_at DESC);
REVOKE ALL ON relay.superadmin_invitations FROM PUBLIC, relay_app;

CREATE FUNCTION relay.list_superadmin_access(p_session text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
BEGIN
  PERFORM relay.require_fresh_superadmin_session(p_session);
  RETURN jsonb_build_object(
    'admins', (SELECT coalesce(jsonb_agg(jsonb_build_object('userId',u.id,'name',u.name,'email',u.email,'grantedAt',r.granted_at) ORDER BY r.granted_at), '[]') FROM relay.system_role_assignments r JOIN auth."user" u ON u.id=r.user_id WHERE r.revoked_at IS NULL),
    'invitations', (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.created_at DESC), '[]') FROM (SELECT id,email,created_at AS "createdAt",expires_at AS "expiresAt",accepted_at AS "acceptedAt",revoked_at AS "revokedAt" FROM relay.superadmin_invitations ORDER BY created_at DESC LIMIT 100) i)
  );
END;
$body$;

CREATE FUNCTION relay.create_superadmin_invitation(p_session text, p_id text, p_email text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE actor text; invite relay.superadmin_invitations%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('relay.system-role:mutations',0));
  actor := relay.require_fresh_superadmin_session(p_session);
  IF p_id IS NULL OR p_id !~ '^sinv_[0-9a-f]{32}$' OR p_email IS NULL OR p_email <> lower(btrim(p_email)) OR length(p_email) NOT BETWEEN 3 AND 254 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
    RAISE EXCEPTION 'invalid invitation' USING ERRCODE='22023';
  END IF;
  SELECT * INTO invite FROM relay.superadmin_invitations WHERE id=p_id;
  IF FOUND THEN
    IF invite.email <> p_email OR invite.invited_by <> actor THEN RAISE EXCEPTION 'idempotency conflict' USING ERRCODE='RG001'; END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM auth."user" u JOIN relay.system_role_assignments r ON r.user_id=u.id AND r.revoked_at IS NULL WHERE lower(u.email)=p_email) THEN
      RAISE EXCEPTION 'already a superadmin' USING ERRCODE='RA409';
    END IF;
    SELECT * INTO invite FROM relay.superadmin_invitations WHERE email=p_email AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>statement_timestamp() ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN
      INSERT INTO relay.superadmin_invitations(id,email,invited_by) VALUES(p_id,p_email,actor) RETURNING * INTO invite;
      INSERT INTO relay.audit_events(actor_type,actor_user_id,action,target_type,target_id,outcome)
      VALUES('user',actor,'system_role.invitation.create','superadmin_invitation',invite.id,'success');
    END IF;
  END IF;
  RETURN jsonb_build_object('id',invite.id,'email',invite.email,'expiresAt',invite.expires_at,'acceptedAt',invite.accepted_at,'revokedAt',invite.revoked_at);
END;
$body$;

CREATE FUNCTION relay.revoke_superadmin_invitation(p_session text, p_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE actor text; invite relay.superadmin_invitations%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('relay.system-role:mutations',0));
  actor := relay.require_fresh_superadmin_session(p_session);
  SELECT * INTO invite FROM relay.superadmin_invitations WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation unavailable' USING ERRCODE='RA404'; END IF;
  IF invite.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'invitation already accepted' USING ERRCODE='RA409'; END IF;
  IF invite.revoked_at IS NOT NULL THEN RETURN 'replayed'; END IF;
  UPDATE relay.superadmin_invitations SET revoked_at=statement_timestamp(),revoked_by=actor WHERE id=p_id;
  INSERT INTO relay.audit_events(actor_type,actor_user_id,action,target_type,target_id,outcome)
  VALUES('user',actor,'system_role.invitation.revoke','superadmin_invitation',p_id,'success');
  RETURN 'revoked';
END;
$body$;

CREATE FUNCTION relay.accept_superadmin_invitation(p_session text, p_id text, p_accept boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE actor text; actor_email text; created timestamptz; invite relay.superadmin_invitations%ROWTYPE; changed_id bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('relay.system-role:mutations',0));
  SELECT u.id,lower(u.email),s."createdAt" INTO actor,actor_email,created
    FROM auth."session" s JOIN auth."user" u ON u.id=s."userId"
    WHERE s.id=p_session AND s."expiresAt">statement_timestamp() AND u."emailVerified"=true FOR SHARE OF s,u;
  IF NOT FOUND THEN RAISE EXCEPTION 'verified session required' USING ERRCODE='28000'; END IF;
  IF p_accept AND (created < statement_timestamp()-interval '15 minutes' OR created>statement_timestamp()+interval '1 minute') THEN
    RAISE EXCEPTION 'fresh session required' USING ERRCODE='55000';
  END IF;
  SELECT * INTO invite FROM relay.superadmin_invitations WHERE id=p_id AND email=actor_email FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation unavailable' USING ERRCODE='RA404'; END IF;
  IF invite.accepted_by=actor THEN RETURN jsonb_build_object('id',invite.id,'email',invite.email,'accepted',true); END IF;
  IF invite.revoked_at IS NOT NULL OR invite.expires_at<=statement_timestamp() THEN RAISE EXCEPTION 'invitation unavailable' USING ERRCODE='RA404'; END IF;
  PERFORM 1 FROM relay.system_role_assignments WHERE user_id=invite.invited_by AND revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation unavailable' USING ERRCODE='RA404'; END IF;
  IF p_accept THEN
    INSERT INTO relay.system_role_assignments(user_id,role,granted_by) VALUES(actor,'superadmin',invite.invited_by)
      ON CONFLICT (user_id) WHERE revoked_at IS NULL DO NOTHING RETURNING id INTO changed_id;
    UPDATE relay.superadmin_invitations SET accepted_by=actor,accepted_at=statement_timestamp() WHERE id=p_id;
    INSERT INTO relay.audit_events(actor_type,actor_user_id,action,target_type,target_id,outcome,reason_code)
    VALUES('user',actor,'system_role.invitation.accept','superadmin_invitation',p_id,'success','verified_email');
    IF changed_id IS NOT NULL THEN
      INSERT INTO relay.audit_events(actor_type,actor_user_id,action,target_type,target_id,outcome,reason_code,after_snapshot)
      VALUES('user',invite.invited_by,'system_role.superadmin.grant','user',actor,'success','invitation_accepted',jsonb_build_object('role','superadmin','active',true,'invitationId',p_id));
    END IF;
  END IF;
  RETURN jsonb_build_object('id',invite.id,'email',invite.email,'expiresAt',invite.expires_at,'accepted',p_accept);
END;
$body$;
REVOKE ALL ON FUNCTION relay.list_superadmin_access(text), relay.create_superadmin_invitation(text,text,text), relay.revoke_superadmin_invitation(text,text), relay.accept_superadmin_invitation(text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay.list_superadmin_access(text), relay.create_superadmin_invitation(text,text,text), relay.revoke_superadmin_invitation(text,text), relay.accept_superadmin_invitation(text,text,boolean) TO relay_app;
`;

export const migration: Migration = {
  id: "0005_superadmin_invitations",
  checksumSha256:
    "1deaa185a9fe5a27645742f1fc5f99a64d43ee42aee8a3036cee26d197406c9f",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
