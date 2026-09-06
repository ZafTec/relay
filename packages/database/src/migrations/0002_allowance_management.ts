import { sql } from "kysely";
import type { Migration } from "./types.ts";

/** Audited manual grants. The application never receives direct grant writes. */
export const CANONICAL_SQL = String.raw`
REVOKE INSERT ON relay.entitlement_grants FROM relay_app;

CREATE TABLE relay.allowance_operation_idempotency (
  operator_user_id text NOT NULL REFERENCES auth."user"(id),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_user_id, key_hash)
);
CREATE TRIGGER allowance_operation_idempotency_immutable
BEFORE UPDATE OR DELETE ON relay.allowance_operation_idempotency
FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_governance_row();
REVOKE ALL ON relay.allowance_operation_idempotency FROM PUBLIC, relay_app;

CREATE FUNCTION relay.manage_workspace_allowance(
  p_session_id text, p_workspace_id text, p_operation text,
  p_input jsonb, p_key_hash text, p_request_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog AS $body$
DECLARE
  v_actor text;
  v_fingerprint text;
  v_existing relay.allowance_operation_idempotency%rowtype;
  v_grant relay.entitlement_grants%rowtype;
  v_before jsonb;
  v_response jsonb;
  v_now timestamptz;
  v_effective timestamptz;
  v_expires timestamptz;
  v_key text;
  v_mode text;
  v_reason text;
BEGIN
  -- The same role lock is held by privileged role changes. Check authorization
  -- before replay or workspace lookup; a revoked operator cannot replay writes.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('relay.system-role:mutations', 0));
  v_actor := relay.require_fresh_superadmin_session(p_session_id);
  IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 256
    OR p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$'
    OR p_operation IS NULL OR p_operation NOT IN ('grant', 'revoke')
    OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 1 AND 128
  THEN RAISE EXCEPTION 'invalid allowance request' USING errcode = '22023'; END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'workspaceId', p_workspace_id, 'operation', p_operation, 'input', p_input
  )::text, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('relay.allowance:request:' || v_actor || ':' || p_key_hash, 0));
  SELECT * INTO v_existing FROM relay.allowance_operation_idempotency
    WHERE operator_user_id = v_actor AND key_hash = p_key_hash;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'allowance idempotency conflict' USING errcode = 'RG001';
    END IF;
    RETURN v_existing.response || jsonb_build_object('replayed', true);
  END IF;

  -- Admission takes the shared form of this lock through reservation commit.
  PERFORM pg_advisory_xact_lock(hashtextextended('relay.allowance:workspace:' || p_workspace_id, 0));
  PERFORM 1 FROM auth.organization WHERE id = p_workspace_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace not found' USING errcode = 'RA404'; END IF;
  v_now := clock_timestamp();
  v_reason := p_input ->> 'reason';
  IF jsonb_typeof(p_input -> 'reason') IS DISTINCT FROM 'string'
    OR length(btrim(v_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'a reason is required' USING errcode = '22023';
  END IF;

  IF p_operation = 'grant' THEN
    IF NOT p_input ?& ARRAY['key', 'mode', 'amount', 'effectiveAt', 'expiresAt', 'reason']
      OR p_input - ARRAY['key', 'mode', 'amount', 'effectiveAt', 'expiresAt', 'reason'] <> '{}'::jsonb
      OR jsonb_typeof(p_input -> 'key') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_input -> 'mode') IS DISTINCT FROM 'string'
    THEN RAISE EXCEPTION 'invalid grant fields' USING errcode = '22023'; END IF;
    v_key := p_input ->> 'key';
    v_mode := p_input ->> 'mode';
    IF v_key NOT IN ('tools.execute', 'images.generated', 'ocr.requests')
      OR (v_key = 'tools.execute' AND (v_mode <> 'enabled' OR p_input -> 'amount' <> 'null'::jsonb))
      OR (v_key <> 'tools.execute' AND v_mode NOT IN ('finite', 'unlimited'))
      OR (v_mode = 'unlimited' AND p_input -> 'amount' <> 'null'::jsonb)
      OR (v_mode = 'finite' AND (
        jsonb_typeof(p_input -> 'amount') IS DISTINCT FROM 'string'
        OR (p_input ->> 'amount') !~ '^(0|[1-9][0-9]{0,28})$'
      ))
    THEN RAISE EXCEPTION 'explicit allowance required' USING errcode = '22023'; END IF;
    IF (p_input -> 'effectiveAt' <> 'null'::jsonb AND (
        jsonb_typeof(p_input -> 'effectiveAt') IS DISTINCT FROM 'string'
        OR (p_input ->> 'effectiveAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$'
      )) OR (p_input -> 'expiresAt' <> 'null'::jsonb AND (
        jsonb_typeof(p_input -> 'expiresAt') IS DISTINCT FROM 'string'
        OR (p_input ->> 'expiresAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$'
      ))
    THEN RAISE EXCEPTION 'invalid allowance window' USING errcode = '22023'; END IF;
    v_effective := coalesce((p_input ->> 'effectiveAt')::timestamptz, v_now);
    v_expires := (p_input ->> 'expiresAt')::timestamptz;
    IF NOT isfinite(v_effective) OR (v_expires IS NOT NULL AND (
      NOT isfinite(v_expires) OR v_expires <= v_effective OR v_expires <= v_now
    )) THEN RAISE EXCEPTION 'invalid allowance window' USING errcode = '22023'; END IF;
    INSERT INTO relay.entitlement_grants (
      id, workspace_id, entitlement_key, grant_kind, capability_enabled,
      limit_amount, unit, period, source_kind, source_reference,
      effective_at, expires_at, metadata, created_at
    ) VALUES (
      'grant_' || replace(gen_random_uuid()::text, '-', ''), p_workspace_id, v_key,
      CASE WHEN v_key = 'tools.execute' THEN 'capability' ELSE 'limit' END,
      CASE WHEN v_key = 'tools.execute' THEN true ELSE NULL END,
      CASE WHEN v_mode = 'finite' THEN (p_input ->> 'amount')::numeric ELSE NULL END,
      CASE v_key WHEN 'images.generated' THEN 'image' WHEN 'ocr.requests' THEN 'request' END,
      CASE WHEN v_key <> 'tools.execute' THEN 'calendar_month' END,
      'manual', 'relay.admin.allowances', v_effective, v_expires,
      jsonb_build_object('operatorUserId', v_actor, 'reason', btrim(v_reason)), v_now
    ) RETURNING * INTO v_grant;
  ELSE
    IF NOT p_input ?& ARRAY['grantId', 'reason']
      OR p_input - ARRAY['grantId', 'reason'] <> '{}'::jsonb
      OR jsonb_typeof(p_input -> 'grantId') IS DISTINCT FROM 'string'
      OR length(p_input ->> 'grantId') NOT BETWEEN 1 AND 256
    THEN RAISE EXCEPTION 'invalid revocation fields' USING errcode = '22023'; END IF;
    SELECT * INTO v_grant FROM relay.entitlement_grants
      WHERE id = p_input ->> 'grantId' AND workspace_id = p_workspace_id
        AND entitlement_key IN ('tools.execute', 'images.generated', 'ocr.requests') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'grant not found' USING errcode = 'RA404'; END IF;
    IF v_grant.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'grant already revoked' USING errcode = 'RA409';
    END IF;
    v_before := to_jsonb(v_grant);
    UPDATE relay.entitlement_grants SET revoked_at = v_now WHERE id = v_grant.id
      RETURNING * INTO v_grant;
  END IF;

  v_response := jsonb_build_object('grantId', v_grant.id, 'operation', p_operation);
  INSERT INTO relay.audit_events (
    actor_type, actor_user_id, workspace_id, action, target_type, target_id,
    outcome, reason_code, before_snapshot, after_snapshot, request_id
  ) VALUES (
    'user', v_actor, p_workspace_id, 'allowance.' || p_operation, 'entitlement_grant',
    v_grant.id, 'success', 'operator_request', v_before,
    to_jsonb(v_grant) || jsonb_build_object('reason', btrim(v_reason)), p_request_id
  );
  INSERT INTO relay.allowance_operation_idempotency (operator_user_id, key_hash, fingerprint, response)
    VALUES (v_actor, p_key_hash, v_fingerprint, v_response);
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$body$;
REVOKE ALL ON FUNCTION relay.manage_workspace_allowance(text, text, text, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay.manage_workspace_allowance(text, text, text, jsonb, text, text) TO relay_app;
CREATE INDEX allowance_audit_workspace_idx ON relay.audit_events (workspace_id, id DESC)
  WHERE action IN ('allowance.grant', 'allowance.revoke');
`;

export const migration: Migration = {
  id: "0002_allowance_management",
  checksumSha256:
    "1d0b60d129abb841f293e01c05d2422e38ba6924b902e7b0a80dca7ac738f56b",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
