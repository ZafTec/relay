import { sql } from "kysely";
import type { Migration } from "./types.ts";

/** Fresh-install Relay schema baseline. Schemas and roles are provisioned by infrastructure. */
const CANONICAL_SQL = String.raw`SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE FUNCTION relay.accept_legal_document(p_session_id text, p_acceptance_scope text, p_workspace_id text, p_document_type text, p_version text, p_revision integer, p_content_sha256 text, p_ip_address text, p_user_agent text, p_request_id text, p_trace_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  v_user_id text;
  v_document relay.legal_documents%rowtype;
  v_scope_workspace_id text;
  v_workspace_role text;
  v_acceptance_id bigint;
  v_accepted_at timestamptz;
begin
  v_user_id := relay.require_current_user_session(p_session_id);
  if p_acceptance_scope not in ('user', 'workspace')
    or pg_catalog.char_length(coalesce(p_workspace_id, '')) > 256
    or pg_catalog.char_length(coalesce(p_ip_address, '')) > 64
    or pg_catalog.char_length(coalesce(p_user_agent, '')) > 1024
    or pg_catalog.char_length(coalesce(p_request_id, '')) > 256
    or pg_catalog.char_length(coalesce(p_trace_id, '')) > 256
  then
    raise exception 'invalid legal acceptance scope or evidence'
      using errcode = '22023';
  end if;
  if (p_acceptance_scope = 'user' and p_workspace_id is not null)
    or (
      p_acceptance_scope = 'workspace'
      and nullif(pg_catalog.btrim(p_workspace_id), '') is null
    )
  then
    raise exception 'legal acceptance subject does not match its scope'
      using errcode = '22023';
  end if;
  if p_document_type is null
    or p_document_type !~ '^[a-z][a-z0-9_.-]{0,63}$'
    or nullif(pg_catalog.btrim(p_version), '') is null
    or pg_catalog.char_length(p_version) > 128
    or p_revision is null
    or p_revision <= 0
    or p_content_sha256 is null
    or p_content_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid legal acceptance target'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'relay.legal-document-publication:' || p_document_type,
      0
    )
  );

  select document.* into v_document
  from relay.current_legal_publications() as current
  join relay.legal_documents as document on document.id = current.document_id
  where document.document_type = p_document_type
    and document.version = p_version
    and document.revision = p_revision
    and document.content_sha256 = p_content_sha256
    and document.acceptance_scope = p_acceptance_scope;
  if not found then
    return pg_catalog.jsonb_build_object(
      'kind', 'not_current',
      'replayed', false
    );
  end if;
  if not v_document.requires_acceptance then
    return pg_catalog.jsonb_build_object(
      'kind', 'not_required',
      'replayed', false
    );
  end if;

  if v_document.acceptance_scope = 'workspace' then
    select member.role into v_workspace_role
    from auth.member as member
    where member."organizationId" = p_workspace_id
      and member."userId" = v_user_id
    for share;
    if not found then
      raise exception 'user is not a current workspace member'
        using errcode = '42501';
    end if;
    if v_workspace_role not in ('owner', 'admin') then
      raise exception 'workspace legal acceptance requires owner or admin'
        using errcode = '42501';
    end if;
    v_scope_workspace_id := p_workspace_id;
  else
    v_scope_workspace_id := null;
  end if;

  insert into relay.legal_acceptances (
    accepted_by_user_id,
    workspace_id,
    acceptance_scope,
    legal_document_id,
    document_type,
    version,
    revision,
    content_sha256,
    ip_address,
    user_agent
  ) values (
    v_user_id,
    v_scope_workspace_id,
    v_document.acceptance_scope,
    v_document.id,
    v_document.document_type,
    v_document.version,
    v_document.revision,
    v_document.content_sha256,
    p_ip_address,
    p_user_agent
  )
  on conflict do nothing
  returning id, accepted_at into v_acceptance_id, v_accepted_at;

  if v_acceptance_id is null then
    select acceptance.id, acceptance.accepted_at
      into v_acceptance_id, v_accepted_at
    from relay.legal_acceptances as acceptance
    where acceptance.legal_document_id = v_document.id
      and (
        (
          v_document.acceptance_scope = 'user'
          and acceptance.acceptance_scope = 'user'
          and acceptance.accepted_by_user_id = v_user_id
        ) or (
          v_document.acceptance_scope = 'workspace'
          and acceptance.acceptance_scope = 'workspace'
          and acceptance.workspace_id = v_scope_workspace_id
        )
      );
    return pg_catalog.jsonb_build_object(
      'kind', 'accepted',
      'replayed', true,
      'acceptanceId', v_acceptance_id::text,
      'acceptedAt', v_accepted_at
    );
  end if;

  insert into relay.audit_events (
    actor_type,
    actor_user_id,
    workspace_id,
    action,
    target_type,
    target_id,
    outcome,
    reason_code,
    after_snapshot,
    request_id,
    trace_id
  ) values (
    'user',
    v_user_id,
    v_scope_workspace_id,
    'legal_document.accept',
    'legal_document',
    v_document.id::text,
    'success',
    'accepted',
    pg_catalog.jsonb_build_object(
      'documentType', v_document.document_type,
      'version', v_document.version,
      'revision', v_document.revision,
      'contentSha256', v_document.content_sha256,
      'acceptanceScope', v_document.acceptance_scope,
      'workspaceId', v_scope_workspace_id
    ),
    p_request_id,
    p_trace_id
  );

  return pg_catalog.jsonb_build_object(
    'kind', 'accepted',
    'replayed', false,
    'acceptanceId', v_acceptance_id::text,
    'acceptedAt', v_accepted_at
  );
end;
$_$;

CREATE FUNCTION relay.adjust_customer_usage(p_adjustment_id text, p_operator_session_id text, p_workspace_id text, p_usage_event_id text, p_idempotency_key_hash text, p_request_hash text, p_quantity_delta numeric, p_reason text, p_metadata jsonb, p_request_id text, p_trace_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  v_operator_user_id text;
  v_original relay.usage_events%rowtype;
  v_existing relay.usage_adjustments%rowtype;
  v_inserted relay.usage_adjustments%rowtype;
  v_bucket_consumed numeric;
  v_event_quantity_before numeric;
  v_event_quantity_after numeric;
  v_at timestamptz := pg_catalog.statement_timestamp();
begin
  if nullif(pg_catalog.btrim(p_adjustment_id), '') is null
    or nullif(pg_catalog.btrim(p_workspace_id), '') is null
    or nullif(pg_catalog.btrim(p_usage_event_id), '') is null
    or p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_quantity_delta = 0
    or nullif(pg_catalog.btrim(p_reason), '') is null
    or pg_catalog.char_length(p_reason) > 500
    or pg_catalog.jsonb_typeof(p_metadata) <> 'object'
    or (p_request_id is not null and p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    or (p_trace_id is not null and p_trace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  then
    raise exception 'invalid customer usage adjustment input'
      using errcode = '22023';
  end if;

  v_operator_user_id := relay.require_fresh_superadmin_session(
    p_operator_session_id
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_workspace_id),
    pg_catalog.hashtext('usage-adjustment:' || p_idempotency_key_hash)
  );

  select event.* into v_original
    from relay.usage_events event
   where event.workspace_id = p_workspace_id
     and event.id = p_usage_event_id;
  if not found then
    return pg_catalog.jsonb_build_object('kind', 'not_found');
  end if;

  select adjustment.* into v_existing
    from relay.usage_adjustments adjustment
   where adjustment.workspace_id = p_workspace_id
     and adjustment.adjusted_by_user_id = v_operator_user_id
     and adjustment.idempotency_key_hash = p_idempotency_key_hash;
  if found then
    if v_existing.request_hash is distinct from p_request_hash then
      return pg_catalog.jsonb_build_object('kind', 'idempotency_conflict');
    end if;
    return pg_catalog.jsonb_build_object(
      'kind', 'replayed',
      'adjustmentId', v_existing.id,
      'workspaceId', v_existing.workspace_id,
      'usageEventId', v_existing.usage_event_id,
      'adjustedByUserId', v_existing.adjusted_by_user_id,
      'metric', v_existing.metric_key,
      'unit', v_existing.unit,
      'quantityDelta', v_existing.quantity_delta::text,
      'reason', v_existing.reason,
      'occurredAt', v_existing.occurred_at
    );
  end if;

  select bucket.consumed_amount into v_bucket_consumed
    from relay.usage_buckets bucket
   where bucket.workspace_id = p_workspace_id
     and bucket.id = v_original.bucket_id
   for update;
  if not found then
    raise exception 'usage event bucket is unavailable'
      using errcode = 'XX000';
  end if;

  select v_original.quantity + coalesce(
           pg_catalog.sum(adjustment.quantity_delta),
           0
         )
    into v_event_quantity_before
    from relay.usage_adjustments adjustment
   where adjustment.workspace_id = p_workspace_id
     and adjustment.usage_event_id = p_usage_event_id;
  v_event_quantity_after := v_event_quantity_before + p_quantity_delta;

  if v_event_quantity_after < 0
    or v_bucket_consumed + p_quantity_delta < 0
  then
    insert into relay.audit_events (
      actor_type, actor_user_id, workspace_id, action, target_type,
      target_id, outcome, reason_code, before_snapshot, after_snapshot,
      request_id, trace_id, idempotency_key
    ) values (
      'user', v_operator_user_id, p_workspace_id,
      'metering.usage.adjust', 'usage_event', p_usage_event_id,
      'denied', 'would_make_usage_negative',
      pg_catalog.jsonb_build_object(
        'eventQuantity', v_original.quantity,
        'adjustedQuantity', v_event_quantity_before,
        'bucketConsumedAmount', v_bucket_consumed
      ),
      pg_catalog.jsonb_build_object('quantityDelta', p_quantity_delta),
      p_request_id, p_trace_id,
      'metering-adjust-denied:' || p_workspace_id || ':' ||
        v_operator_user_id || ':' || p_idempotency_key_hash
    ) on conflict (idempotency_key) do nothing;
    return pg_catalog.jsonb_build_object(
      'kind', 'would_make_usage_negative'
    );
  end if;

  insert into relay.usage_adjustments (
    id, workspace_id, usage_event_id, adjusted_by_user_id, bucket_id,
    metric_key, unit, quantity_delta, reason, metadata, meter_policy_id,
    meter_policy_key, meter_policy_revision, meter_policy_hash,
    meter_policy_snapshot, entitlement_snapshot, idempotency_key_hash,
    request_hash, occurred_at
  ) values (
    p_adjustment_id, p_workspace_id, p_usage_event_id, v_operator_user_id,
    v_original.bucket_id, v_original.metric_key, v_original.unit,
    p_quantity_delta, p_reason, p_metadata, v_original.meter_policy_id,
    v_original.meter_policy_key, v_original.meter_policy_revision,
    v_original.meter_policy_hash, v_original.meter_policy_snapshot,
    v_original.entitlement_snapshot, p_idempotency_key_hash, p_request_hash,
    v_at
  ) returning * into v_inserted;

  update relay.usage_buckets
     set consumed_amount = consumed_amount + p_quantity_delta,
         updated_at = v_at
   where workspace_id = p_workspace_id
     and id = v_original.bucket_id;
  if not found then
    raise exception 'usage event bucket disappeared during adjustment'
      using errcode = 'XX000';
  end if;

  insert into relay.audit_events (
    actor_type, actor_user_id, workspace_id, action, target_type,
    target_id, outcome, reason_code, before_snapshot, after_snapshot,
    request_id, trace_id, idempotency_key
  ) values (
    'user', v_operator_user_id, p_workspace_id,
    'metering.usage.adjust', 'usage_event', p_usage_event_id,
    'success', 'adjusted',
    pg_catalog.jsonb_build_object(
      'eventQuantity', v_original.quantity,
      'adjustedQuantity', v_event_quantity_before,
      'bucketConsumedAmount', v_bucket_consumed
    ),
    pg_catalog.jsonb_build_object(
      'adjustmentId', v_inserted.id,
      'quantityDelta', v_inserted.quantity_delta,
      'adjustedQuantity', v_event_quantity_after,
      'bucketConsumedAmount', v_bucket_consumed + p_quantity_delta
    ),
    p_request_id, p_trace_id,
    'metering-adjust:' || p_workspace_id || ':' ||
      v_operator_user_id || ':' || p_idempotency_key_hash
  );

  return pg_catalog.jsonb_build_object(
    'kind', 'adjusted',
    'adjustmentId', v_inserted.id,
    'workspaceId', v_inserted.workspace_id,
    'usageEventId', v_inserted.usage_event_id,
    'adjustedByUserId', v_inserted.adjusted_by_user_id,
    'metric', v_inserted.metric_key,
    'unit', v_inserted.unit,
    'quantityDelta', v_inserted.quantity_delta::text,
    'reason', v_inserted.reason,
    'occurredAt', v_inserted.occurred_at
  );
end;
$_$;

CREATE FUNCTION relay.append_changelog_revision(p_release_id bigint, p_version text, p_slug text, p_title text, p_summary text, p_git_tag text, p_commit_sha text, p_released_at timestamp with time zone, p_items jsonb, p_changed_by text) RETURNS TABLE(revision integer, content_sha256 text, snapshot jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  v_revision integer;
  v_snapshot jsonb;
  v_content_sha256 text;
begin
  v_snapshot := relay.build_changelog_snapshot(
    p_version,
    p_slug,
    p_title,
    p_summary,
    p_git_tag,
    p_commit_sha,
    p_released_at,
    p_items
  );
  select coalesce(pg_catalog.max(r.revision), 0) + 1
    into v_revision
  from relay.changelog_revisions as r
  where r.release_id = p_release_id;
  v_content_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_snapshot::text, 'UTF8')),
    'hex'
  );

  insert into relay.changelog_revisions (
    release_id,
    revision,
    version,
    slug,
    title,
    summary,
    git_tag,
    commit_sha,
    released_at,
    snapshot,
    content_sha256,
    changed_by
  ) values (
    p_release_id,
    v_revision,
    p_version,
    p_slug,
    p_title,
    p_summary,
    p_git_tag,
    p_commit_sha,
    p_released_at,
    v_snapshot,
    v_content_sha256,
    p_changed_by
  );

  insert into relay.changelog_items (
    release_id,
    revision,
    category,
    area,
    title,
    description,
    sort_order
  )
  select
    p_release_id,
    v_revision,
    item ->> 'category',
    item ->> 'area',
    item ->> 'title',
    item ->> 'description',
    (item ->> 'sortOrder')::integer
  from pg_catalog.jsonb_array_elements(v_snapshot -> 'items') as entry(item);

  return query select v_revision, v_content_sha256, v_snapshot;
end;
$$;

CREATE FUNCTION relay.append_legal_document(p_document_type text, p_version text, p_effective_at timestamp with time zone, p_canonical_url text, p_content_sha256 text, p_requires_acceptance boolean, p_acceptance_scope text, p_created_by text) RETURNS TABLE(document_id bigint, revision integer, record_sha256 text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  v_revision integer;
  v_record_sha256 text;
begin
  if p_document_type !~ '^[a-z][a-z0-9_.-]{0,63}$'
    or nullif(pg_catalog.btrim(p_version), '') is null
    or pg_catalog.char_length(p_version) > 128
    or p_canonical_url is null
    or not relay.is_safe_legal_canonical_url(p_canonical_url)
    or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or p_acceptance_scope not in ('user', 'workspace')
  then
    raise exception 'invalid legal document metadata'
      using errcode = '22023';
  end if;

  select coalesce(pg_catalog.max(document.revision), 0) + 1
    into v_revision
  from relay.legal_documents as document
  where document.document_type = p_document_type
    and document.version = p_version;
  v_record_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'documentType', p_document_type,
          'version', p_version,
          'revision', v_revision,
          'effectiveAt', p_effective_at,
          'canonicalUrl', p_canonical_url,
          'contentSha256', p_content_sha256,
          'requiresAcceptance', p_requires_acceptance,
          'acceptanceScope', p_acceptance_scope
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );

  return query
  insert into relay.legal_documents (
    document_type,
    version,
    revision,
    effective_at,
    canonical_url,
    content_sha256,
    requires_acceptance,
    acceptance_scope,
    record_sha256,
    created_by
  ) values (
    p_document_type,
    p_version,
    v_revision,
    p_effective_at,
    p_canonical_url,
    p_content_sha256,
    p_requires_acceptance,
    p_acceptance_scope,
    v_record_sha256,
    p_created_by
  ) returning id, v_revision, v_record_sha256;
end;
$_$;

CREATE FUNCTION relay.bootstrap_superadmin(p_target_user_id text, p_idempotency_key_hash text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  existing_mutation relay.privileged_operation_idempotency%rowtype;
begin
  if p_idempotency_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid privileged-operation idempotency key hash'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('relay.system-role:mutations', 0)
  );

  select * into existing_mutation
  from relay.privileged_operation_idempotency
  where operation = 'bootstrap'
  limit 1;

  if found then
    if existing_mutation.operator_user_id = p_target_user_id
      and existing_mutation.target_user_id = p_target_user_id
      and existing_mutation.idempotency_key_hash = p_idempotency_key_hash
    then
      return 'replayed';
    end if;
    raise exception 'superadmin bootstrap has already been completed'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from relay.system_role_assignments where revoked_at is null
  ) then
    raise exception 'superadmin bootstrap requires zero active superadmins'
      using errcode = '42501';
  end if;
  if not exists (select 1 from auth."user" where id = p_target_user_id) then
    raise exception 'superadmin bootstrap target does not exist'
      using errcode = '23503';
  end if;

  insert into relay.system_role_assignments (user_id, role, granted_by)
  values (p_target_user_id, 'superadmin', p_target_user_id);

  insert into relay.audit_events (
    actor_type,
    actor_user_id,
    action,
    target_type,
    target_id,
    outcome,
    reason_code,
    before_snapshot,
    after_snapshot
  ) values (
    'system',
    null,
    'system_role.superadmin.bootstrap',
    'user',
    p_target_user_id,
    'success',
    'bootstrapped',
    pg_catalog.jsonb_build_object('role', 'superadmin', 'active', false),
    pg_catalog.jsonb_build_object('role', 'superadmin', 'active', true)
  );

  insert into relay.privileged_operation_idempotency (
    operation,
    operator_user_id,
    idempotency_key_hash,
    target_user_id,
    result
  ) values (
    'bootstrap',
    p_target_user_id,
    p_idempotency_key_hash,
    p_target_user_id,
    'changed'
  );

  return 'changed';
end;
$_$;

CREATE FUNCTION relay.build_changelog_snapshot(p_version text, p_slug text, p_title text, p_summary text, p_git_tag text, p_commit_sha text, p_released_at timestamp with time zone, p_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  normalized_items jsonb;
begin
  if nullif(pg_catalog.btrim(p_version), '') is null
    or pg_catalog.char_length(p_version) > 64
    or p_slug !~ '^[a-z0-9]([a-z0-9-]{0,126}[a-z0-9])?$'
    or pg_catalog.char_length(p_slug) > 128
    or nullif(pg_catalog.btrim(p_title), '') is null
    or pg_catalog.char_length(p_title) > 200
    or pg_catalog.char_length(coalesce(p_summary, '')) > 2000
    or pg_catalog.char_length(coalesce(p_git_tag, '')) > 256
    or (
      p_commit_sha is not null
      and p_commit_sha !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    )
    or pg_catalog.jsonb_typeof(p_items) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_items) > 200
  then
    raise exception 'invalid changelog revision metadata'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as entry(item)
    where pg_catalog.jsonb_typeof(item) is distinct from 'object'
      or not (item ? 'category')
      or not (item ? 'area')
      or not (item ? 'title')
      or not (item ? 'description')
      or not (item ? 'sortOrder')
      or item - array['category', 'area', 'title', 'description', 'sortOrder']::text[] <> '{}'::jsonb
      or item ->> 'category' not in ('added', 'improved', 'fixed', 'security', 'breaking')
      or (
        item -> 'area' <> 'null'::jsonb
        and (
          pg_catalog.jsonb_typeof(item -> 'area') is distinct from 'string'
          or pg_catalog.char_length(item ->> 'area') > 100
        )
      )
      or pg_catalog.jsonb_typeof(item -> 'title') is distinct from 'string'
      or nullif(pg_catalog.btrim(item ->> 'title'), '') is null
      or pg_catalog.char_length(item ->> 'title') > 240
      or pg_catalog.jsonb_typeof(item -> 'description') is distinct from 'string'
      or nullif(pg_catalog.btrim(item ->> 'description'), '') is null
      or pg_catalog.char_length(item ->> 'description') > 8000
      or pg_catalog.jsonb_typeof(item -> 'sortOrder') is distinct from 'number'
      or item ->> 'sortOrder' !~ '^(0|[1-9][0-9]*)$'
      or pg_catalog.char_length(item ->> 'sortOrder') > 10
      or (item ->> 'sortOrder')::numeric > 2147483647
  ) then
    raise exception 'invalid changelog item'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as entry(item)
    group by (item ->> 'sortOrder')::integer
    having pg_catalog.count(*) > 1
  ) then
    raise exception 'changelog item sort orders must be unique'
      using errcode = '22023';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(item order by (item ->> 'sortOrder')::integer),
    '[]'::jsonb
  ) into normalized_items
  from pg_catalog.jsonb_array_elements(p_items) as entry(item);

  return pg_catalog.jsonb_build_object(
    'version', p_version,
    'slug', p_slug,
    'title', p_title,
    'summary', p_summary,
    'gitTag', p_git_tag,
    'commitSha', p_commit_sha,
    'releasedAt', p_released_at,
    'items', normalized_items
  );
end;
$_$;

CREATE FUNCTION relay.canonical_jsonb_text(p_value jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
  select case pg_catalog.jsonb_typeof(p_value)
    when 'object' then (
      select '{' || coalesce(
        pg_catalog.string_agg(
          pg_catalog.to_jsonb(entry.key)::text || ':' ||
            relay.canonical_jsonb_text(entry.value),
          ',' order by entry.key collate "C"
        ),
        ''
      ) || '}'
      from pg_catalog.jsonb_each(p_value) as entry(key, value)
    )
    when 'array' then (
      select '[' || coalesce(
        pg_catalog.string_agg(
          relay.canonical_jsonb_text(entry.value),
          ',' order by entry.ordinality
        ),
        ''
      ) || ']'
      from pg_catalog.jsonb_array_elements(p_value)
        with ordinality as entry(value, ordinality)
    )
    when 'number' then pg_catalog.trim_scale((p_value #>> '{}')::numeric)::text
    else p_value::text
  end
$$;

CREATE FUNCTION relay.complete_governance_mutation(p_operation text, p_operator_user_id text, p_idempotency_key_hash text, p_request_fingerprint text, p_response jsonb, p_action text, p_target_type text, p_target_id text, p_outcome text, p_reason_code text, p_before_snapshot jsonb, p_after_snapshot jsonb, p_request_id text, p_trace_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
begin
  insert into relay.governance_operation_idempotency (
    operation,
    operator_user_id,
    idempotency_key_hash,
    request_fingerprint,
    response
  ) values (
    p_operation,
    p_operator_user_id,
    p_idempotency_key_hash,
    p_request_fingerprint,
    p_response
  );

  insert into relay.audit_events (
    actor_type,
    actor_user_id,
    action,
    target_type,
    target_id,
    outcome,
    reason_code,
    before_snapshot,
    after_snapshot,
    request_id,
    trace_id
  ) values (
    'user',
    p_operator_user_id,
    p_action,
    p_target_type,
    p_target_id,
    p_outcome,
    p_reason_code,
    p_before_snapshot,
    p_after_snapshot,
    p_request_id,
    p_trace_id
  );

  return p_response || pg_catalog.jsonb_build_object('replayed', false);
end;
$$;

CREATE FUNCTION relay.compute_meter_policy_immutable_hash(p_id text, p_policy_key text, p_revision integer, p_document jsonb, p_effective_at timestamp with time zone, p_expires_at timestamp with time zone) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        relay.canonical_jsonb_text(
          pg_catalog.jsonb_build_object(
            'id', p_id,
            'policy_key', p_policy_key,
            'revision', p_revision,
            'document', p_document,
            'effective_at_epoch_microseconds',
              (extract(epoch from p_effective_at) * 1000000)::numeric,
            'expires_at_is_null', p_expires_at is null,
            'expires_at_epoch_microseconds', case
              when p_expires_at is null then null
              else (extract(epoch from p_expires_at) * 1000000)::numeric
            end
          )
        ),
        'UTF8'
      )
    ),
    'hex'
  )
$$;

CREATE FUNCTION relay.compute_pricing_policy_immutable_hash(p_id text, p_policy_key text, p_revision integer, p_document jsonb, p_effective_at timestamp with time zone, p_expires_at timestamp with time zone) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        relay.canonical_jsonb_text(
          pg_catalog.jsonb_build_object(
            'id', p_id,
            'policy_key', p_policy_key,
            'revision', p_revision,
            'document', p_document,
            'effective_at_epoch_microseconds',
              (extract(epoch from p_effective_at) * 1000000)::numeric,
            'expires_at_is_null', p_expires_at is null,
            'expires_at_epoch_microseconds', case
              when p_expires_at is null then null
              else (extract(epoch from p_expires_at) * 1000000)::numeric
            end
          )
        ),
        'UTF8'
      )
    ),
    'hex'
  )
$$;

CREATE FUNCTION relay.compute_routing_policy_immutable_hash(p_id bigint, p_revision integer, p_policy jsonb, p_effective_at timestamp with time zone) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'id', p_id,
          'revision', p_revision,
          'policy', p_policy,
          'effective_at_epoch_microseconds',
            (extract(epoch from p_effective_at) * 1000000)::numeric
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
$$;

CREATE FUNCTION relay.compute_subscription_snapshot_immutable_hash(p_id text, p_workspace_id text, p_source_key text, p_subscription_key text, p_revision integer, p_state text, p_catalog_item_key text, p_catalog_revision integer, p_snapshot jsonb, p_effective_at timestamp with time zone, p_expires_at timestamp with time zone) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        relay.canonical_jsonb_text(
          pg_catalog.jsonb_build_object(
            'id', p_id,
            'workspace_id', p_workspace_id,
            'source_key', p_source_key,
            'subscription_key', p_subscription_key,
            'revision', p_revision,
            'state', p_state,
            'catalog_item_key', p_catalog_item_key,
            'catalog_revision', p_catalog_revision,
            'snapshot', p_snapshot,
            'effective_at_epoch_microseconds',
              (extract(epoch from p_effective_at) * 1000000)::numeric,
            'expires_at_is_null', p_expires_at is null,
            'expires_at_epoch_microseconds', case
              when p_expires_at is null then null
              else (extract(epoch from p_expires_at) * 1000000)::numeric
            end
          )
        ),
        'UTF8'
      )
    ),
    'hex'
  )
$$;

CREATE FUNCTION relay.compute_tool_version_immutable_hash(p_id text, p_tool_id text, p_version integer, p_input_schema jsonb, p_output_schema jsonb, p_handler_key text, p_input_schema_version integer, p_handler_version text, p_execution_mode text, p_max_duration_seconds integer, p_meter_policy_id text, p_entitlement_key text, p_compatibility_metadata jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'id', p_id,
          'tool_id', p_tool_id,
          'version', p_version,
          'input_schema', p_input_schema,
          'output_schema', p_output_schema,
          'handler_key', p_handler_key,
          'input_schema_version', p_input_schema_version,
          'handler_version', p_handler_version,
          'execution_mode', p_execution_mode,
          'max_duration_seconds', p_max_duration_seconds,
          'meter_policy_id', p_meter_policy_id,
          'entitlement_key', p_entitlement_key,
          'compatibility_metadata_is_sql_null', p_compatibility_metadata is null,
          'compatibility_metadata', p_compatibility_metadata
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
$$;

CREATE FUNCTION relay.create_default_workspace_scheduling_profile() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
begin
  insert into relay.workspace_scheduling_profiles
    (workspace_id, class_key, policy_version, granted_by, granted_at)
  select NEW."id", standard.class_key, standard.policy_version, null, now()
    from relay.scheduler_classes standard
   where standard.class_key = 'standard' and standard.enabled = true
  on conflict (workspace_id) do nothing;

  if not found then
    raise exception 'enabled standard scheduling profile is not configured';
  end if;
  return NEW;
end;
$$;

CREATE FUNCTION relay.current_legal_publications() RETURNS TABLE(document_id bigint, document_type text, published_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  with event_windows as (
    select
      event.id as event_id,
      event.document_type,
      event.document_id,
      event.action,
      event.occurred_at,
      document.effective_at,
      pg_catalog.lag(event.action) over (
        partition by event.document_id order by event.id
      ) as previous_action,
      pg_catalog.lag(event.occurred_at) over (
        partition by event.document_id order by event.id
      ) as previous_occurred_at,
      pg_catalog.lead(event.action) over (
        partition by event.document_id order by event.id
      ) as next_action,
      pg_catalog.lead(event.occurred_at) over (
        partition by event.document_id order by event.id
      ) as next_occurred_at
    from relay.legal_document_publication_events as event
    join relay.legal_documents as document on document.id = event.document_id
  ), transitions as (
    select
      event_id,
      document_type,
      document_id,
      action,
      greatest(effective_at, occurred_at) as activates_at,
      occurred_at as published_at
    from event_windows
    where action in ('publish', 'supersede')
      and (
        next_action is distinct from 'unpublish'
        or next_occurred_at >= greatest(effective_at, occurred_at)
      )
    union all
    select
      event_id,
      document_type,
      document_id,
      action,
      occurred_at as activates_at,
      occurred_at as published_at
    from event_windows
    where action = 'unpublish'
      and previous_action in ('publish', 'supersede')
      and occurred_at >= greatest(effective_at, previous_occurred_at)
  ), current_transition as (
    select distinct on (document_type)
      document_type,
      document_id,
      action,
      published_at
    from transitions
    where activates_at <= pg_catalog.statement_timestamp()
    order by document_type, activates_at desc, event_id desc
  )
  select document_id, document_type, published_at
  from current_transition
  where action in ('publish', 'supersede')
$$;

CREATE FUNCTION relay.enforce_entitlement_grant_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'entitlement grants cannot be deleted; revoke them'
      using errcode = '55000';
  end if;
  if OLD.revoked_at is not null or NEW.revoked_at is null
    or NEW.id is distinct from OLD.id
    or NEW.workspace_id is distinct from OLD.workspace_id
    or NEW.entitlement_key is distinct from OLD.entitlement_key
    or NEW.grant_kind is distinct from OLD.grant_kind
    or NEW.capability_enabled is distinct from OLD.capability_enabled
    or NEW.limit_amount is distinct from OLD.limit_amount
    or NEW.unit is distinct from OLD.unit
    or NEW.period is distinct from OLD.period
    or NEW.source_kind is distinct from OLD.source_kind
    or NEW.source_reference is distinct from OLD.source_reference
    or NEW.subscription_snapshot_id is distinct from OLD.subscription_snapshot_id
    or NEW.effective_at is distinct from OLD.effective_at
    or NEW.expires_at is distinct from OLD.expires_at
    or NEW.metadata is distinct from OLD.metadata
    or NEW.created_at is distinct from OLD.created_at
  then
    raise exception 'entitlement grants are immutable except for first revocation'
      using errcode = '55000';
  end if;
  return NEW;
end;
$$;

CREATE FUNCTION relay.enforce_execution_job_scheduling_profile() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  selected_class text;
  selected_version integer;
begin
  if TG_OP = 'UPDATE' then
    if NEW.workspace_id is distinct from OLD.workspace_id
      or NEW.scheduling_class is distinct from OLD.scheduling_class
      or NEW.scheduling_policy_version is distinct from OLD.scheduling_policy_version
    then
      raise exception 'execution job scheduling profile is immutable after admission';
    end if;
    return NEW;
  end if;

  select classes.class_key, classes.policy_version
    into selected_class, selected_version
    from relay.workspace_scheduling_profiles profile
    join relay.scheduler_classes classes
      on classes.class_key = profile.class_key
     and classes.policy_version = profile.policy_version
   where profile.workspace_id = NEW.workspace_id
     and classes.enabled = true
     and (profile.expires_at is null or profile.expires_at > now());

  if selected_class is null then
    select class_key, policy_version into selected_class, selected_version
      from relay.scheduler_classes
     where class_key = 'standard' and enabled = true;
  end if;
  if selected_class is null then
    raise exception 'enabled standard scheduling profile is not configured';
  end if;

  NEW.scheduling_class := selected_class;
  NEW.scheduling_policy_version := selected_version;
  return NEW;
end;
$$;

CREATE FUNCTION relay.enforce_scheduler_class_revision() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'scheduler classes cannot be deleted';
  end if;
  if NEW.class_key is distinct from OLD.class_key then
    raise exception 'scheduler class keys are immutable';
  end if;
  if NEW.weight is not distinct from OLD.weight
    and NEW.max_share is not distinct from OLD.max_share
    and NEW.enabled is not distinct from OLD.enabled
    and NEW.policy_version is not distinct from OLD.policy_version
  then
    return NEW;
  end if;
  if NEW.policy_version <= OLD.policy_version then
    raise exception 'scheduler policy changes require a newer policy version';
  end if;
  return NEW;
end;
$$;

CREATE FUNCTION relay.enforce_usage_reservation_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'usage reservations cannot be deleted'
      using errcode = '55000';
  end if;
  if OLD.status <> 'active' then
    raise exception 'terminal usage reservations are immutable'
      using errcode = '55000';
  end if;
  if NEW.status = 'active'
    or NEW.id is distinct from OLD.id
    or NEW.workspace_id is distinct from OLD.workspace_id
    or NEW.bucket_id is distinct from OLD.bucket_id
    or NEW.tool_version_id is distinct from OLD.tool_version_id
    or NEW.provider_model_id is distinct from OLD.provider_model_id
    or NEW.capability_key is distinct from OLD.capability_key
    or NEW.metric_key is distinct from OLD.metric_key
    or NEW.unit is distinct from OLD.unit
    or NEW.period is distinct from OLD.period
    or NEW.period_start is distinct from OLD.period_start
    or NEW.period_end is distinct from OLD.period_end
    or NEW.estimate_measures is distinct from OLD.estimate_measures
    or NEW.estimated_minimum is distinct from OLD.estimated_minimum
    or NEW.estimated_expected is distinct from OLD.estimated_expected
    or NEW.estimated_maximum is distinct from OLD.estimated_maximum
    or NEW.reserved_amount is distinct from OLD.reserved_amount
    or NEW.meter_policy_id is distinct from OLD.meter_policy_id
    or NEW.meter_policy_key is distinct from OLD.meter_policy_key
    or NEW.meter_policy_revision is distinct from OLD.meter_policy_revision
    or NEW.meter_policy_hash is distinct from OLD.meter_policy_hash
    or NEW.meter_policy_snapshot is distinct from OLD.meter_policy_snapshot
    or NEW.entitlement_snapshot is distinct from OLD.entitlement_snapshot
    or NEW.limit_amount_snapshot is distinct from OLD.limit_amount_snapshot
    or NEW.reserve_idempotency_key_hash is distinct from OLD.reserve_idempotency_key_hash
    or NEW.reserve_request_hash is distinct from OLD.reserve_request_hash
    or NEW.expires_at is distinct from OLD.expires_at
    or NEW.created_at is distinct from OLD.created_at
  then
    raise exception 'usage reservation identity and policy snapshot are immutable'
      using errcode = '55000';
  end if;
  return NEW;
end;
$$;

CREATE FUNCTION relay.get_admin_changelog(p_operator_session_id text, p_release_id bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  v_release relay.changelog_releases%rowtype;
  v_latest jsonb;
  v_published jsonb;
begin
  perform relay.require_fresh_superadmin_session(p_operator_session_id);
  select * into v_release
  from relay.changelog_releases
  where id = p_release_id;
  if not found then
    return null;
  end if;

  select revision.snapshot || pg_catalog.jsonb_build_object(
    'contentSha256', revision.content_sha256
  ) into v_latest
  from relay.changelog_revisions as revision
  where revision.release_id = p_release_id
    and revision.revision = v_release.latest_revision;

  if v_release.published_revision is not null then
    select revision.snapshot || pg_catalog.jsonb_build_object(
      'contentSha256', revision.content_sha256
    ) into v_published
    from relay.changelog_revisions as revision
    where revision.release_id = p_release_id
      and revision.revision = v_release.published_revision;
  end if;

  return pg_catalog.jsonb_build_object(
    'releaseId', v_release.id::text,
    'status', v_release.status,
    'latestRevision', v_release.latest_revision,
    'publishedRevision', v_release.published_revision,
    'hasUnpublishedChanges',
      v_release.published_revision is distinct from v_release.latest_revision,
    'firstPublishedAt', v_release.first_published_at,
    'lastPublishedAt', v_release.last_published_at,
    'latest', v_latest,
    'published', v_published
  );
end;
$$;

CREATE FUNCTION relay.get_public_changelog(p_slug text) RETURNS TABLE(release_id text, revision integer, snapshot jsonb, published_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  select
    release.id::text,
    selected.revision,
    selected.snapshot || pg_catalog.jsonb_build_object(
      'contentSha256', selected.content_sha256
    ),
    release.last_published_at
  from relay.changelog_releases as release
  join relay.changelog_revisions as selected
    on selected.release_id = release.id
   and selected.revision = release.published_revision
  where release.status = 'published'
    and release.slug = p_slug
$$;

CREATE FUNCTION relay.governance_replay(p_operation text, p_operator_user_id text, p_idempotency_key_hash text, p_request_fingerprint text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  existing_record relay.governance_operation_idempotency%rowtype;
begin
  if p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid governance idempotency metadata'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_operation || ':' || p_operator_user_id || ':' || p_idempotency_key_hash,
      0
    )
  );

  select * into existing_record
  from relay.governance_operation_idempotency
  where operation = p_operation
    and operator_user_id = p_operator_user_id
    and idempotency_key_hash = p_idempotency_key_hash;

  if not found then
    return null;
  end if;
  if existing_record.request_fingerprint is distinct from p_request_fingerprint then
    raise exception 'governance idempotency key reused for a different mutation'
      using errcode = 'RG001';
  end if;
  return existing_record.response || pg_catalog.jsonb_build_object('replayed', true);
end;
$_$;

CREATE FUNCTION relay.grant_superadmin(p_target_user_id text, p_operator_session_id text, p_idempotency_key_hash text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  v_operator_user_id text;
  existing_mutation relay.privileged_operation_idempotency%rowtype;
  inserted_assignment_id bigint;
  mutation_result text;
begin
  if p_idempotency_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid privileged-operation idempotency key hash'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('relay.system-role:mutations', 0)
  );
  v_operator_user_id := relay.require_fresh_superadmin_session(
    p_operator_session_id
  );

  select * into existing_mutation
  from relay.privileged_operation_idempotency
  where operation = 'grant'
    and operator_user_id = v_operator_user_id
    and idempotency_key_hash = p_idempotency_key_hash;

  if found then
    if existing_mutation.target_user_id is distinct from p_target_user_id then
      raise exception 'privileged-operation idempotency key reused for a different target'
        using errcode = '22023';
    end if;
    return 'replayed';
  end if;

  if not exists (select 1 from auth."user" where id = p_target_user_id) then
    raise exception 'superadmin mutation target does not exist'
      using errcode = '23503';
  end if;

  insert into relay.system_role_assignments (user_id, role, granted_by)
  values (p_target_user_id, 'superadmin', v_operator_user_id)
  on conflict (user_id) where revoked_at is null do nothing
  returning id into inserted_assignment_id;

  mutation_result := case
    when inserted_assignment_id is null then 'unchanged'
    else 'changed'
  end;

  insert into relay.audit_events (
    actor_type,
    actor_user_id,
    action,
    target_type,
    target_id,
    outcome,
    reason_code,
    before_snapshot,
    after_snapshot
  ) values (
    'user',
    v_operator_user_id,
    'system_role.superadmin.grant',
    'user',
    p_target_user_id,
    'success',
    case when mutation_result = 'changed' then 'granted' else 'already_granted' end,
    pg_catalog.jsonb_build_object(
      'role', 'superadmin',
      'active', mutation_result = 'unchanged'
    ),
    pg_catalog.jsonb_build_object('role', 'superadmin', 'active', true)
  );

  insert into relay.privileged_operation_idempotency (
    operation,
    operator_user_id,
    idempotency_key_hash,
    target_user_id,
    result
  ) values (
    'grant',
    v_operator_user_id,
    p_idempotency_key_hash,
    p_target_user_id,
    mutation_result
  );

  return mutation_result;
end;
$_$;

CREATE FUNCTION relay.is_safe_legal_canonical_url(p_url text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  v_authority text;
  v_port text;
begin
  if pg_catalog.char_length(p_url) > 2048
    or p_url !~ '^https://[^/?#]+/[^#]*$'
    or p_url ~ '[[:space:][:cntrl:]]'
    or pg_catalog.strpos(p_url, pg_catalog.chr(92)) > 0
  then
    return false;
  end if;

  v_authority := substring(p_url from '^https://([^/?#]+)');
  if v_authority is null
    or pg_catalog.strpos(v_authority, '@') > 0
    or v_authority !~ '^([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$'
  then
    return false;
  end if;

  v_port := case
    when v_authority ~ '\]:[0-9]{1,5}$'
      then substring(v_authority from '\]:([0-9]{1,5})$')
    when v_authority !~ '^\['
      then substring(v_authority from ':([0-9]{1,5})$')
    else null
  end;
  return v_port is null or v_port::integer <= 65535;
exception
  when numeric_value_out_of_range then
    return false;
end;
$_$;

CREATE FUNCTION relay.jsonb_contains_raw_url(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
  select coalesce(value::text ~* '[a-z][a-z0-9+.-]*://', false)
$$;

CREATE FUNCTION relay.list_admin_changelog(p_operator_session_id text, p_limit integer, p_before_release_id bigint) RETURNS TABLE(release_id text, version text, slug text, status text, latest_revision integer, published_revision integer, has_unpublished_changes boolean, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
begin
  perform relay.require_fresh_superadmin_session(p_operator_session_id);
  if p_limit < 1 or p_limit > 100 then
    raise exception 'admin changelog limit must be between 1 and 100'
      using errcode = '22023';
  end if;
  return query
  select
    release.id::text,
    release.version,
    release.slug,
    release.status,
    release.latest_revision,
    release.published_revision,
    release.published_revision is distinct from release.latest_revision,
    release.updated_at
  from relay.changelog_releases as release
  where p_before_release_id is null or release.id < p_before_release_id
  order by release.id desc
  limit p_limit;
end;
$$;

CREATE FUNCTION relay.list_admin_changelog_revisions(p_operator_session_id text, p_release_id bigint) RETURNS TABLE(revision integer, snapshot jsonb, changed_by text, changed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
begin
  perform relay.require_fresh_superadmin_session(p_operator_session_id);
  return query
  select
    stored.revision,
    stored.snapshot || pg_catalog.jsonb_build_object(
      'contentSha256', stored.content_sha256
    ),
    stored.changed_by,
    stored.changed_at
  from relay.changelog_revisions as stored
  where stored.release_id = p_release_id
  order by stored.revision desc;
end;
$$;

CREATE FUNCTION relay.list_admin_legal_documents(p_operator_session_id text, p_document_type text) RETURNS TABLE(document_id text, document_type text, version text, revision integer, effective_at timestamp with time zone, canonical_url text, content_sha256 text, requires_acceptance boolean, acceptance_scope text, record_sha256 text, published_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
begin
  perform relay.require_fresh_superadmin_session(p_operator_session_id);
  if p_document_type is not null
    and p_document_type !~ '^[a-z][a-z0-9_.-]{0,63}$'
  then
    raise exception 'invalid legal document type'
      using errcode = '22023';
  end if;

  return query
  with latest_document_event as (
    select distinct on (event.document_id)
      event.document_id,
      event.action,
      event.occurred_at
    from relay.legal_document_publication_events as event
    order by event.document_id, event.id desc
  )
  select
    document.id::text,
    document.document_type,
    document.version,
    document.revision,
    document.effective_at,
    document.canonical_url,
    document.content_sha256,
    document.requires_acceptance,
    document.acceptance_scope,
    document.record_sha256,
    case
      when latest_document_event.action in ('publish', 'supersede')
      then latest_document_event.occurred_at
      else null
    end
  from relay.legal_documents as document
  left join latest_document_event
    on latest_document_event.document_id = document.id
  where p_document_type is null
    or document.document_type = p_document_type
  order by document.document_type, document.version desc, document.revision desc;
end;
$_$;

CREATE FUNCTION relay.list_pending_legal_documents(p_session_id text, p_workspace_id text) RETURNS TABLE(document_id text, document_type text, version text, revision integer, effective_at timestamp with time zone, canonical_url text, content_sha256 text, requires_acceptance boolean, acceptance_scope text, record_sha256 text, published_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  v_user_id text;
begin
  v_user_id := relay.require_current_user_session(p_session_id);
  if p_workspace_id is not null then
    perform 1
    from auth.member
    where "organizationId" = p_workspace_id
      and "userId" = v_user_id
    for share;
    if not found then
      raise exception 'user is not a current workspace member'
        using errcode = '42501';
    end if;
  end if;

  return query
  select
    document.id::text,
    document.document_type,
    document.version,
    document.revision,
    document.effective_at,
    document.canonical_url,
    document.content_sha256,
    document.requires_acceptance,
    document.acceptance_scope,
    document.record_sha256,
    current.published_at
  from relay.current_legal_publications() as current
  join relay.legal_documents as document on document.id = current.document_id
  where document.requires_acceptance
    and (
      document.acceptance_scope = 'user'
      or p_workspace_id is not null
    )
    and not exists (
      select 1
      from relay.legal_acceptances as acceptance
      where acceptance.legal_document_id = document.id
        and (
          (
            document.acceptance_scope = 'user'
            and acceptance.acceptance_scope = 'user'
            and acceptance.accepted_by_user_id = v_user_id
          ) or (
            document.acceptance_scope = 'workspace'
            and acceptance.acceptance_scope = 'workspace'
            and acceptance.workspace_id = p_workspace_id
          )
        )
    )
  order by document.document_type;
end;
$$;

CREATE FUNCTION relay.list_public_changelog(p_limit integer, p_cursor_released_at timestamp with time zone, p_cursor_release_id bigint) RETURNS TABLE(release_id text, revision integer, snapshot jsonb, published_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if p_limit < 1 or p_limit > 101 then
    raise exception 'public changelog limit must be between 1 and 101'
      using errcode = '22023';
  end if;
  if (p_cursor_released_at is null) <> (p_cursor_release_id is null) then
    raise exception 'public changelog cursor must be complete'
      using errcode = '22023';
  end if;

  return query
  select
    release.id::text,
    selected.revision,
    selected.snapshot || pg_catalog.jsonb_build_object(
      'contentSha256', selected.content_sha256
    ),
    release.last_published_at
  from relay.changelog_releases as release
  join relay.changelog_revisions as selected
    on selected.release_id = release.id
   and selected.revision = release.published_revision
  where release.status = 'published'
    and selected.released_at is not null
    and (
      p_cursor_released_at is null
      or (selected.released_at, release.id) <
        (p_cursor_released_at, p_cursor_release_id)
    )
  order by selected.released_at desc, release.id desc
  limit p_limit;
end;
$$;

CREATE FUNCTION relay.list_public_legal_documents() RETURNS TABLE(document_id text, document_type text, version text, revision integer, effective_at timestamp with time zone, canonical_url text, content_sha256 text, requires_acceptance boolean, acceptance_scope text, record_sha256 text, published_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  select
    document.id::text,
    document.document_type,
    document.version,
    document.revision,
    document.effective_at,
    document.canonical_url,
    document.content_sha256,
    document.requires_acceptance,
    document.acceptance_scope,
    document.record_sha256,
    current.published_at
  from relay.current_legal_publications() as current
  join relay.legal_documents as document on document.id = current.document_id
  order by document.document_type
$$;

CREATE FUNCTION relay.maintain_tool_version_immutable_hash() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  expected_hash text;
begin
  expected_hash := relay.compute_tool_version_immutable_hash(
    NEW.id,
    NEW.tool_id,
    NEW.version,
    NEW.input_schema,
    NEW.output_schema,
    NEW.handler_key,
    NEW.input_schema_version,
    NEW.handler_version,
    NEW.execution_mode,
    NEW.max_duration_seconds,
    NEW.meter_policy_id,
    NEW.entitlement_key,
    NEW.compatibility_metadata
  );

  if NEW.published_at is null then
    NEW.immutable_hash := expected_hash;
  elsif NEW.immutable_hash is distinct from expected_hash then
    raise exception 'relay.tool_versions "%" immutable_hash does not match its full contract', NEW.id
      using errcode = '23514';
  end if;

  return NEW;
end;
$$;

CREATE FUNCTION relay.mutate_changelog(p_operation text, p_operator_session_id text, p_idempotency_key_hash text, p_payload jsonb, p_request_id text, p_trace_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  v_operator_user_id text;
  v_operation text;
  v_request_fingerprint text;
  v_replay jsonb;
  v_response jsonb;
  v_release relay.changelog_releases%rowtype;
  v_current_revision relay.changelog_revisions%rowtype;
  v_new_revision integer;
  v_new_hash text;
  v_new_snapshot jsonb;
  v_candidate_snapshot jsonb;
  v_candidate_hash text;
  v_release_id bigint;
  v_expected_revision integer;
  v_expected_published_revision integer;
  v_version text;
  v_slug text;
  v_title text;
  v_summary text;
  v_git_tag text;
  v_commit_sha text;
  v_released_at timestamptz;
  v_items jsonb;
  v_version_conflict boolean;
  v_slug_conflict boolean;
  v_event_action text;
  v_reasons jsonb := '[]'::jsonb;
begin
  v_operator_user_id := relay.require_fresh_superadmin_session(
    p_operator_session_id
  );
  if p_operation not in ('create', 'revise', 'publish', 'unpublish')
    or pg_catalog.jsonb_typeof(p_payload) is distinct from 'object'
  then
    raise exception 'invalid changelog operation'
      using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(p_request_id, '')) > 256
    or pg_catalog.char_length(coalesce(p_trace_id, '')) > 256
  then
    raise exception 'request correlation identifier is too long'
      using errcode = '22023';
  end if;

  v_operation := 'changelog.' || p_operation;
  v_request_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'operation', v_operation,
          'payload', p_payload
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
  v_replay := relay.governance_replay(
    v_operation,
    v_operator_user_id,
    p_idempotency_key_hash,
    v_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  if p_operation in ('create', 'revise') then
    v_version := p_payload ->> 'version';
    v_slug := p_payload ->> 'slug';
    v_title := p_payload ->> 'title';
    v_summary := p_payload ->> 'summary';
    v_git_tag := p_payload ->> 'gitTag';
    v_commit_sha := p_payload ->> 'commitSha';
    v_released_at := case
      when p_payload -> 'releasedAt' = 'null'::jsonb then null
      else (p_payload ->> 'releasedAt')::timestamptz
    end;
    v_items := p_payload -> 'items';
    v_candidate_snapshot := relay.build_changelog_snapshot(
      v_version,
      v_slug,
      v_title,
      v_summary,
      v_git_tag,
      v_commit_sha,
      v_released_at,
      v_items
    );
    v_candidate_hash := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(v_candidate_snapshot::text, 'UTF8')
      ),
      'hex'
    );
  end if;

  if p_operation = 'create' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('relay.changelog:identities', 0)
    );
    select
      coalesce(pg_catalog.bool_or(version = v_version), false),
      coalesce(pg_catalog.bool_or(slug = v_slug), false)
      into v_version_conflict, v_slug_conflict
    from relay.changelog_releases
    where version = v_version or slug = v_slug;

    if v_version_conflict or v_slug_conflict then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'conflict',
        'reason', case
          when v_version_conflict and v_slug_conflict then 'version_and_slug'
          when v_version_conflict then 'version'
          else 'slug'
        end
      );
      return relay.complete_governance_mutation(
        v_operation,
        v_operator_user_id,
        p_idempotency_key_hash,
        v_request_fingerprint,
        v_response,
        'changelog.release.create',
        'changelog_release',
        null,
        'failure',
        v_response ->> 'reason',
        null,
        null,
        p_request_id,
        p_trace_id
      );
    end if;

    insert into relay.changelog_releases (
      version,
      slug,
      status,
      latest_revision
    ) values (
      v_version,
      v_slug,
      'draft',
      1
    ) returning id into v_release_id;

    select appended.revision, appended.content_sha256, appended.snapshot
      into v_new_revision, v_new_hash, v_new_snapshot
    from relay.append_changelog_revision(
      v_release_id,
      v_version,
      v_slug,
      v_title,
      v_summary,
      v_git_tag,
      v_commit_sha,
      v_released_at,
      v_items,
      v_operator_user_id
    ) as appended;

    v_response := pg_catalog.jsonb_build_object(
      'kind', 'created',
      'releaseId', v_release_id::text,
      'revision', v_new_revision
    );
    return relay.complete_governance_mutation(
      v_operation,
      v_operator_user_id,
      p_idempotency_key_hash,
      v_request_fingerprint,
      v_response,
      'changelog.release.create',
      'changelog_release',
      v_release_id::text,
      'success',
      'draft_created',
      null,
      pg_catalog.jsonb_build_object(
        'status', 'draft',
        'revision', v_new_revision,
        'contentSha256', v_new_hash
      ),
      p_request_id,
      p_trace_id
    );
  end if;

  if p_operation = 'revise' then
    if p_payload ->> 'releaseId' !~ '^[1-9][0-9]{0,18}$'
      or p_payload ->> 'expectedRevision' !~ '^[1-9][0-9]{0,9}$'
    then
      raise exception 'invalid changelog revision target'
        using errcode = '22023';
    end if;
    v_release_id := (p_payload ->> 'releaseId')::bigint;
    v_expected_revision := (p_payload ->> 'expectedRevision')::integer;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('relay.changelog:identities', 0)
    );
    select * into v_release
    from relay.changelog_releases
    where id = v_release_id
    for update;

    if not found then
      v_response := pg_catalog.jsonb_build_object('kind', 'not_found');
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'changelog.release.revise',
        'changelog_release', v_release_id::text, 'failure', 'not_found',
        null, null, p_request_id, p_trace_id
      );
    end if;
    if v_release.latest_revision <> v_expected_revision then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'revision_conflict',
        'releaseId', v_release_id::text,
        'actualRevision', v_release.latest_revision
      );
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'changelog.release.revise',
        'changelog_release', v_release_id::text, 'failure',
        'revision_conflict',
        pg_catalog.jsonb_build_object('revision', v_release.latest_revision),
        null, p_request_id, p_trace_id
      );
    end if;
    if v_release.first_published_at is not null
      and (v_release.version <> v_version or v_release.slug <> v_slug)
    then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'identity_locked',
        'releaseId', v_release_id::text,
        'revision', v_release.latest_revision
      );
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'changelog.release.revise',
        'changelog_release', v_release_id::text, 'failure', 'identity_locked',
        pg_catalog.jsonb_build_object(
          'version', v_release.version,
          'slug', v_release.slug,
          'revision', v_release.latest_revision
        ), null, p_request_id, p_trace_id
      );
    end if;

    select
      coalesce(pg_catalog.bool_or(version = v_version), false),
      coalesce(pg_catalog.bool_or(slug = v_slug), false)
      into v_version_conflict, v_slug_conflict
    from relay.changelog_releases
    where id <> v_release_id
      and (version = v_version or slug = v_slug);
    if v_version_conflict or v_slug_conflict then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'conflict',
        'releaseId', v_release_id::text,
        'reason', case
          when v_version_conflict and v_slug_conflict then 'version_and_slug'
          when v_version_conflict then 'version'
          else 'slug'
        end
      );
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'changelog.release.revise',
        'changelog_release', v_release_id::text, 'failure',
        v_response ->> 'reason', null, null, p_request_id, p_trace_id
      );
    end if;

    select * into v_current_revision
    from relay.changelog_revisions
    where release_id = v_release_id
      and revision = v_release.latest_revision;
    if v_current_revision.content_sha256 = v_candidate_hash then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'unchanged',
        'releaseId', v_release_id::text,
        'revision', v_release.latest_revision
      );
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'changelog.release.revise',
        'changelog_release', v_release_id::text, 'success', 'unchanged',
        pg_catalog.jsonb_build_object(
          'revision', v_release.latest_revision,
          'contentSha256', v_current_revision.content_sha256
        ),
        pg_catalog.jsonb_build_object(
          'revision', v_release.latest_revision,
          'contentSha256', v_current_revision.content_sha256
        ),
        p_request_id, p_trace_id
      );
    end if;

    select appended.revision, appended.content_sha256, appended.snapshot
      into v_new_revision, v_new_hash, v_new_snapshot
    from relay.append_changelog_revision(
      v_release_id,
      v_version,
      v_slug,
      v_title,
      v_summary,
      v_git_tag,
      v_commit_sha,
      v_released_at,
      v_items,
      v_operator_user_id
    ) as appended;
    update relay.changelog_releases
    set version = v_version,
        slug = v_slug,
        latest_revision = v_new_revision,
        updated_at = pg_catalog.statement_timestamp()
    where id = v_release_id;

    v_response := pg_catalog.jsonb_build_object(
      'kind', 'revised',
      'releaseId', v_release_id::text,
      'revision', v_new_revision
    );
    return relay.complete_governance_mutation(
      v_operation, v_operator_user_id, p_idempotency_key_hash,
      v_request_fingerprint, v_response, 'changelog.release.revise',
      'changelog_release', v_release_id::text, 'success', 'revision_appended',
      pg_catalog.jsonb_build_object(
        'revision', v_current_revision.revision,
        'contentSha256', v_current_revision.content_sha256
      ),
      pg_catalog.jsonb_build_object(
        'revision', v_new_revision,
        'contentSha256', v_new_hash
      ),
      p_request_id, p_trace_id
    );
  end if;

  if p_payload ->> 'releaseId' !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'invalid changelog release target'
      using errcode = '22023';
  end if;
  v_release_id := (p_payload ->> 'releaseId')::bigint;
  select * into v_release
  from relay.changelog_releases
  where id = v_release_id
  for update;
  if not found then
    v_response := pg_catalog.jsonb_build_object('kind', 'not_found');
    return relay.complete_governance_mutation(
      v_operation, v_operator_user_id, p_idempotency_key_hash,
      v_request_fingerprint, v_response,
      'changelog.release.' || p_operation,
      'changelog_release', v_release_id::text, 'failure', 'not_found',
      null, null, p_request_id, p_trace_id
    );
  end if;

  if p_operation = 'publish' then
    if p_payload ->> 'expectedRevision' !~ '^[1-9][0-9]{0,9}$' then
      raise exception 'invalid expected changelog revision'
        using errcode = '22023';
    end if;
    v_expected_revision := (p_payload ->> 'expectedRevision')::integer;
    if v_release.latest_revision <> v_expected_revision then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'revision_conflict',
        'releaseId', v_release_id::text,
        'actualRevision', v_release.latest_revision
      );
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'changelog.release.publish',
        'changelog_release', v_release_id::text, 'failure',
        'revision_conflict',
        pg_catalog.jsonb_build_object('revision', v_release.latest_revision),
        null, p_request_id, p_trace_id
      );
    end if;
    select * into v_current_revision
    from relay.changelog_revisions
    where release_id = v_release_id
      and revision = v_release.latest_revision;

    if v_current_revision.version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' then
      v_reasons := v_reasons || pg_catalog.jsonb_build_array('invalid_version');
    end if;
    if nullif(pg_catalog.btrim(v_current_revision.git_tag), '') is null then
      v_reasons := v_reasons || pg_catalog.jsonb_build_array('missing_git_tag');
    end if;
    if v_current_revision.commit_sha is null then
      v_reasons := v_reasons || pg_catalog.jsonb_build_array('missing_commit_sha');
    end if;
    if v_current_revision.released_at is null then
      v_reasons := v_reasons || pg_catalog.jsonb_build_array('missing_released_at');
    end if;
    if pg_catalog.jsonb_array_length(v_current_revision.snapshot -> 'items') = 0 then
      v_reasons := v_reasons || pg_catalog.jsonb_build_array('missing_items');
    end if;
    if pg_catalog.jsonb_array_length(v_reasons) > 0 then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'not_publishable',
        'releaseId', v_release_id::text,
        'revision', v_release.latest_revision,
        'reasons', v_reasons
      );
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'changelog.release.publish',
        'changelog_release', v_release_id::text, 'failure', 'not_publishable',
        pg_catalog.jsonb_build_object(
          'status', v_release.status,
          'revision', v_release.latest_revision
        ), null, p_request_id, p_trace_id
      );
    end if;
    if v_release.status = 'published'
      and v_release.published_revision = v_release.latest_revision
    then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'unchanged',
        'releaseId', v_release_id::text,
        'revision', v_release.latest_revision,
        'supersededRevision', null
      );
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'changelog.release.publish',
        'changelog_release', v_release_id::text, 'success',
        'already_published',
        pg_catalog.jsonb_build_object(
          'status', 'published',
          'revision', v_release.published_revision
        ),
        pg_catalog.jsonb_build_object(
          'status', 'published',
          'revision', v_release.published_revision
        ),
        p_request_id, p_trace_id
      );
    end if;

    v_event_action := case
      when v_release.published_revision is not null
        and v_release.published_revision <> v_release.latest_revision
      then 'supersede'
      else 'publish'
    end;
    update relay.changelog_releases
    set status = 'published',
        published_revision = latest_revision,
        first_published_at = coalesce(
          first_published_at,
          pg_catalog.statement_timestamp()
        ),
        last_published_at = pg_catalog.statement_timestamp(),
        updated_at = pg_catalog.statement_timestamp()
    where id = v_release_id;
    insert into relay.changelog_publication_events (
      release_id,
      revision,
      action,
      superseded_revision,
      actor_user_id,
      request_id,
      trace_id
    ) values (
      v_release_id,
      v_release.latest_revision,
      v_event_action,
      case when v_event_action = 'supersede'
        then v_release.published_revision else null end,
      v_operator_user_id,
      p_request_id,
      p_trace_id
    );

    v_response := pg_catalog.jsonb_build_object(
      'kind', case when v_event_action = 'supersede'
        then 'superseded' else 'published' end,
      'releaseId', v_release_id::text,
      'revision', v_release.latest_revision,
      'supersededRevision', case when v_event_action = 'supersede'
        then v_release.published_revision else null end
    );
    return relay.complete_governance_mutation(
      v_operation, v_operator_user_id, p_idempotency_key_hash,
      v_request_fingerprint, v_response, 'changelog.release.publish',
      'changelog_release', v_release_id::text, 'success', v_event_action,
      pg_catalog.jsonb_build_object(
        'status', v_release.status,
        'publishedRevision', v_release.published_revision
      ),
      pg_catalog.jsonb_build_object(
        'status', 'published',
        'publishedRevision', v_release.latest_revision,
        'contentSha256', v_current_revision.content_sha256
      ),
      p_request_id, p_trace_id
    );
  end if;

  if p_payload ->> 'expectedPublishedRevision' !~ '^[1-9][0-9]{0,9}$' then
    raise exception 'invalid expected published revision'
      using errcode = '22023';
  end if;
  v_expected_published_revision :=
    (p_payload ->> 'expectedPublishedRevision')::integer;
  if v_release.published_revision is not null
    and v_release.published_revision <> v_expected_published_revision
  then
    v_response := pg_catalog.jsonb_build_object(
      'kind', 'revision_conflict',
      'releaseId', v_release_id::text,
      'actualRevision', v_release.published_revision
    );
    return relay.complete_governance_mutation(
      v_operation, v_operator_user_id, p_idempotency_key_hash,
      v_request_fingerprint, v_response, 'changelog.release.unpublish',
      'changelog_release', v_release_id::text, 'failure', 'revision_conflict',
      pg_catalog.jsonb_build_object(
        'status', v_release.status,
        'publishedRevision', v_release.published_revision
      ), null, p_request_id, p_trace_id
    );
  end if;
  if v_release.status <> 'published' then
    v_response := pg_catalog.jsonb_build_object(
      'kind', 'unchanged',
      'releaseId', v_release_id::text,
      'revision', v_release.published_revision
    );
    return relay.complete_governance_mutation(
      v_operation, v_operator_user_id, p_idempotency_key_hash,
      v_request_fingerprint, v_response, 'changelog.release.unpublish',
      'changelog_release', v_release_id::text, 'success',
      'already_unpublished',
      pg_catalog.jsonb_build_object('status', v_release.status),
      pg_catalog.jsonb_build_object('status', v_release.status),
      p_request_id, p_trace_id
    );
  end if;

  update relay.changelog_releases
  set status = 'archived',
      updated_at = pg_catalog.statement_timestamp()
  where id = v_release_id;
  insert into relay.changelog_publication_events (
    release_id,
    revision,
    action,
    actor_user_id,
    request_id,
    trace_id
  ) values (
    v_release_id,
    v_release.published_revision,
    'unpublish',
    v_operator_user_id,
    p_request_id,
    p_trace_id
  );
  v_response := pg_catalog.jsonb_build_object(
    'kind', 'unpublished',
    'releaseId', v_release_id::text,
    'revision', v_release.published_revision
  );
  return relay.complete_governance_mutation(
    v_operation, v_operator_user_id, p_idempotency_key_hash,
    v_request_fingerprint, v_response, 'changelog.release.unpublish',
    'changelog_release', v_release_id::text, 'success', 'unpublished',
    pg_catalog.jsonb_build_object(
      'status', 'published',
      'publishedRevision', v_release.published_revision
    ),
    pg_catalog.jsonb_build_object(
      'status', 'archived',
      'publishedRevision', v_release.published_revision
    ),
    p_request_id, p_trace_id
  );
end;
$_$;

CREATE FUNCTION relay.mutate_legal_document(p_operation text, p_operator_session_id text, p_idempotency_key_hash text, p_payload jsonb, p_request_id text, p_trace_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  v_operator_user_id text;
  v_operation text;
  v_request_fingerprint text;
  v_replay jsonb;
  v_response jsonb;
  v_document relay.legal_documents%rowtype;
  v_current_document relay.legal_documents%rowtype;
  v_document_id bigint;
  v_current_document_id bigint;
  v_expected_document_id bigint;
  v_new_document_id bigint;
  v_revision integer;
  v_expected_revision integer;
  v_record_sha256 text;
  v_document_type text;
  v_version text;
  v_effective_at timestamptz;
  v_canonical_url text;
  v_content_sha256 text;
  v_requires_acceptance boolean;
  v_acceptance_scope text;
  v_event_action text;
  v_latest_event_action text;
  v_latest_event_occurred_at timestamptz;
  v_activation_at timestamptz;
begin
  v_operator_user_id := relay.require_fresh_superadmin_session(
    p_operator_session_id
  );
  if p_operation not in ('create', 'revise', 'publish', 'unpublish')
    or pg_catalog.jsonb_typeof(p_payload) is distinct from 'object'
  then
    raise exception 'invalid legal-document operation'
      using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(p_request_id, '')) > 256
    or pg_catalog.char_length(coalesce(p_trace_id, '')) > 256
  then
    raise exception 'request correlation identifier is too long'
      using errcode = '22023';
  end if;

  v_operation := 'legal_document.' || p_operation;
  v_request_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'operation', v_operation,
          'payload', p_payload
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
  v_replay := relay.governance_replay(
    v_operation,
    v_operator_user_id,
    p_idempotency_key_hash,
    v_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  if p_operation in ('create', 'revise') then
    v_document_type := p_payload ->> 'documentType';
    v_version := p_payload ->> 'version';
    v_effective_at := (p_payload ->> 'effectiveAt')::timestamptz;
    v_canonical_url := p_payload ->> 'canonicalUrl';
    v_content_sha256 := p_payload ->> 'contentSha256';
    if pg_catalog.jsonb_typeof(p_payload -> 'requiresAcceptance') is distinct from 'boolean' then
      raise exception 'requiresAcceptance must be a boolean'
        using errcode = '22023';
    end if;
    v_requires_acceptance := (p_payload ->> 'requiresAcceptance')::boolean;
    v_acceptance_scope := p_payload ->> 'acceptanceScope';
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'relay.legal-document:' || v_document_type || ':' || v_version,
        0
      )
    );
  end if;

  if p_operation = 'create' then
    if exists (
      select 1 from relay.legal_documents
      where document_type = v_document_type and version = v_version
    ) then
      v_response := pg_catalog.jsonb_build_object('kind', 'conflict');
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'legal_document.create',
        'legal_document', null, 'failure', 'version_exists',
        null, null, p_request_id, p_trace_id
      );
    end if;

    select appended.document_id, appended.revision, appended.record_sha256
      into v_new_document_id, v_revision, v_record_sha256
    from relay.append_legal_document(
      v_document_type,
      v_version,
      v_effective_at,
      v_canonical_url,
      v_content_sha256,
      v_requires_acceptance,
      v_acceptance_scope,
      v_operator_user_id
    ) as appended;
    v_response := pg_catalog.jsonb_build_object(
      'kind', 'created',
      'documentId', v_new_document_id::text,
      'revision', v_revision
    );
    return relay.complete_governance_mutation(
      v_operation, v_operator_user_id, p_idempotency_key_hash,
      v_request_fingerprint, v_response, 'legal_document.create',
      'legal_document', v_new_document_id::text, 'success', 'draft_created',
      null,
      pg_catalog.jsonb_build_object(
        'documentType', v_document_type,
        'version', v_version,
        'revision', v_revision,
        'contentSha256', v_content_sha256,
        'recordSha256', v_record_sha256
      ),
      p_request_id, p_trace_id
    );
  end if;

  if p_operation = 'revise' then
    if p_payload ->> 'expectedRevision' !~ '^[1-9][0-9]{0,9}$' then
      raise exception 'invalid expected legal-document revision'
        using errcode = '22023';
    end if;
    v_expected_revision := (p_payload ->> 'expectedRevision')::integer;
    select * into v_current_document
    from relay.legal_documents
    where document_type = v_document_type
      and version = v_version
    order by revision desc
    limit 1;
    if not found then
      v_response := pg_catalog.jsonb_build_object('kind', 'not_found');
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'legal_document.revise',
        'legal_document', null, 'failure', 'not_found',
        null, null, p_request_id, p_trace_id
      );
    end if;
    if v_current_document.revision <> v_expected_revision then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'revision_conflict',
        'documentId', v_current_document.id::text,
        'actualRevision', v_current_document.revision
      );
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'legal_document.revise',
        'legal_document', v_current_document.id::text, 'failure',
        'revision_conflict',
        pg_catalog.jsonb_build_object(
          'revision', v_current_document.revision,
          'recordSha256', v_current_document.record_sha256
        ), null, p_request_id, p_trace_id
      );
    end if;
    if row(
      v_current_document.effective_at,
      v_current_document.canonical_url,
      v_current_document.content_sha256,
      v_current_document.requires_acceptance,
      v_current_document.acceptance_scope
    ) is not distinct from row(
      v_effective_at,
      v_canonical_url,
      v_content_sha256,
      v_requires_acceptance,
      v_acceptance_scope
    ) then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'unchanged',
        'documentId', v_current_document.id::text,
        'revision', v_current_document.revision
      );
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'legal_document.revise',
        'legal_document', v_current_document.id::text, 'success', 'unchanged',
        pg_catalog.jsonb_build_object(
          'revision', v_current_document.revision,
          'recordSha256', v_current_document.record_sha256
        ),
        pg_catalog.jsonb_build_object(
          'revision', v_current_document.revision,
          'recordSha256', v_current_document.record_sha256
        ),
        p_request_id, p_trace_id
      );
    end if;

    select appended.document_id, appended.revision, appended.record_sha256
      into v_new_document_id, v_revision, v_record_sha256
    from relay.append_legal_document(
      v_document_type,
      v_version,
      v_effective_at,
      v_canonical_url,
      v_content_sha256,
      v_requires_acceptance,
      v_acceptance_scope,
      v_operator_user_id
    ) as appended;
    v_response := pg_catalog.jsonb_build_object(
      'kind', 'revised',
      'documentId', v_new_document_id::text,
      'revision', v_revision
    );
    return relay.complete_governance_mutation(
      v_operation, v_operator_user_id, p_idempotency_key_hash,
      v_request_fingerprint, v_response, 'legal_document.revise',
      'legal_document', v_new_document_id::text, 'success', 'revision_appended',
      pg_catalog.jsonb_build_object(
        'documentId', v_current_document.id::text,
        'revision', v_current_document.revision,
        'recordSha256', v_current_document.record_sha256
      ),
      pg_catalog.jsonb_build_object(
        'documentId', v_new_document_id::text,
        'revision', v_revision,
        'recordSha256', v_record_sha256
      ),
      p_request_id, p_trace_id
    );
  end if;

  if p_operation = 'publish' then
    if p_payload ->> 'documentId' !~ '^[1-9][0-9]{0,18}$' then
      raise exception 'invalid legal-document target'
        using errcode = '22023';
    end if;
    v_document_id := (p_payload ->> 'documentId')::bigint;
    select * into v_document
    from relay.legal_documents
    where id = v_document_id;
    if not found then
      v_response := pg_catalog.jsonb_build_object('kind', 'not_found');
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'legal_document.publish',
        'legal_document', v_document_id::text, 'failure', 'not_found',
        null, null, p_request_id, p_trace_id
      );
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'relay.legal-document:' || v_document.document_type || ':' ||
          v_document.version,
        0
      )
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'relay.legal-document-publication:' || v_document.document_type,
        0
      )
    );
    select pg_catalog.max(document.revision) into v_revision
    from relay.legal_documents as document
    where document.document_type = v_document.document_type
      and document.version = v_document.version;
    if v_revision <> v_document.revision then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'revision_conflict',
        'documentId', v_document_id::text,
        'actualRevision', v_revision
      );
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'legal_document.publish',
        'legal_document', v_document_id::text, 'failure',
        'not_latest_revision', null, null, p_request_id, p_trace_id
      );
    end if;

    select current.document_id into v_current_document_id
    from relay.current_legal_publications() as current
    where current.document_type = v_document.document_type;

    select event.action, event.occurred_at
      into v_latest_event_action, v_latest_event_occurred_at
    from relay.legal_document_publication_events as event
    where event.document_id = v_document_id
    order by event.id desc
    limit 1;
    v_activation_at := case
      when v_latest_event_action in ('publish', 'supersede')
        then greatest(v_document.effective_at, v_latest_event_occurred_at)
      else null
    end;

    if v_current_document_id = v_document_id
      or (
        v_latest_event_action in ('publish', 'supersede')
        and v_activation_at > pg_catalog.statement_timestamp()
      )
    then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'unchanged',
        'documentId', v_document_id::text,
        'revision', v_document.revision,
        'supersededDocumentId', null
      );
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'legal_document.publish',
        'legal_document', v_document_id::text, 'success',
        'already_published',
        pg_catalog.jsonb_build_object('documentId', v_document_id::text),
        pg_catalog.jsonb_build_object('documentId', v_document_id::text),
        p_request_id, p_trace_id
      );
    end if;

    v_event_action := case when v_current_document_id is null
      then 'publish' else 'supersede' end;
    insert into relay.legal_document_publication_events (
      document_type,
      document_id,
      action,
      superseded_document_id,
      actor_user_id,
      request_id,
      trace_id
    ) values (
      v_document.document_type,
      v_document_id,
      v_event_action,
      v_current_document_id,
      v_operator_user_id,
      p_request_id,
      p_trace_id
    );
    v_response := pg_catalog.jsonb_build_object(
      'kind', case when v_event_action = 'supersede'
        then 'superseded' else 'published' end,
      'documentId', v_document_id::text,
      'revision', v_document.revision,
      'supersededDocumentId', v_current_document_id::text
    );
    return relay.complete_governance_mutation(
      v_operation, v_operator_user_id, p_idempotency_key_hash,
      v_request_fingerprint, v_response, 'legal_document.publish',
      'legal_document', v_document_id::text, 'success', v_event_action,
      case when v_current_document_id is null then null
        else pg_catalog.jsonb_build_object(
          'documentId', v_current_document_id::text
        ) end,
      pg_catalog.jsonb_build_object(
        'documentId', v_document_id::text,
        'documentType', v_document.document_type,
        'version', v_document.version,
        'revision', v_document.revision,
        'contentSha256', v_document.content_sha256,
        'recordSha256', v_document.record_sha256
      ),
      p_request_id, p_trace_id
    );
  end if;

  v_document_type := p_payload ->> 'documentType';
  if v_document_type !~ '^[a-z][a-z0-9_.-]{0,63}$'
    or p_payload ->> 'expectedDocumentId' !~ '^[1-9][0-9]{0,18}$'
  then
    raise exception 'invalid legal-document unpublish target'
      using errcode = '22023';
  end if;
  v_expected_document_id := (p_payload ->> 'expectedDocumentId')::bigint;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'relay.legal-document-publication:' || v_document_type,
      0
    )
  );
  select current.document_id into v_current_document_id
  from relay.current_legal_publications() as current
  where current.document_type = v_document_type;

  select * into v_document
  from relay.legal_documents
  where id = v_expected_document_id
    and document_type = v_document_type;
  if found then
    select event.action, event.occurred_at
      into v_latest_event_action, v_latest_event_occurred_at
    from relay.legal_document_publication_events as event
    where event.document_id = v_expected_document_id
    order by event.id desc
    limit 1;
  else
    v_latest_event_action := null;
    v_latest_event_occurred_at := null;
  end if;
  v_activation_at := case
    when v_latest_event_action in ('publish', 'supersede')
      then greatest(v_document.effective_at, v_latest_event_occurred_at)
    else null
  end;

  if v_latest_event_action not in ('publish', 'supersede')
    or v_latest_event_action is null
  then
    if v_current_document_id is null then
      v_response := pg_catalog.jsonb_build_object(
        'kind', 'unchanged',
        'documentId', v_expected_document_id::text
      );
      return relay.complete_governance_mutation(
        v_operation, v_operator_user_id, p_idempotency_key_hash,
        v_request_fingerprint, v_response, 'legal_document.unpublish',
        'legal_document', v_expected_document_id::text, 'success',
        'already_unpublished', null, null, p_request_id, p_trace_id
      );
    end if;
  end if;

  if v_latest_event_action not in ('publish', 'supersede')
    or v_latest_event_action is null
    or (
      v_current_document_id is distinct from v_expected_document_id
      and v_activation_at <= pg_catalog.statement_timestamp()
    )
  then
    v_response := pg_catalog.jsonb_build_object(
      'kind', 'revision_conflict',
      'documentId', v_expected_document_id::text,
      'actualDocumentId', v_current_document_id::text
    );
    return relay.complete_governance_mutation(
      v_operation, v_operator_user_id, p_idempotency_key_hash,
      v_request_fingerprint, v_response, 'legal_document.unpublish',
      'legal_document', v_expected_document_id::text, 'failure',
      'document_conflict',
      pg_catalog.jsonb_build_object(
        'documentId', v_current_document_id::text
      ), null, p_request_id, p_trace_id
    );
  end if;

  insert into relay.legal_document_publication_events (
    document_type,
    document_id,
    action,
    actor_user_id,
    request_id,
    trace_id
  ) values (
    v_document_type,
    v_expected_document_id,
    'unpublish',
    v_operator_user_id,
    p_request_id,
    p_trace_id
  );
  v_response := pg_catalog.jsonb_build_object(
    'kind', 'unpublished',
    'documentId', v_expected_document_id::text
  );
  return relay.complete_governance_mutation(
    v_operation, v_operator_user_id, p_idempotency_key_hash,
    v_request_fingerprint, v_response, 'legal_document.unpublish',
    'legal_document', v_expected_document_id::text, 'success',
    case when v_activation_at > pg_catalog.statement_timestamp()
      then 'schedule_cancelled' else 'unpublished' end,
    pg_catalog.jsonb_build_object(
      'documentId', v_expected_document_id::text,
      'published', v_current_document_id = v_expected_document_id,
      'scheduled', v_activation_at > pg_catalog.statement_timestamp()
    ),
    pg_catalog.jsonb_build_object(
      'documentId', v_expected_document_id::text,
      'published', false,
      'scheduled', false
    ),
    p_request_id, p_trace_id
  );
end;
$_$;

CREATE FUNCTION relay.protect_artifact_version() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'relay.artifact_versions rows are immutable history'
      using errcode = '55000';
  end if;

  if row(
    NEW.id,
    NEW.workspace_id,
    NEW.artifact_id,
    NEW.sequence,
    NEW.object_key,
    NEW.sha256,
    NEW.content_md5,
    NEW.size_bytes,
    NEW.mime_type,
    NEW.width,
    NEW.height,
    NEW.duration_ms,
    NEW.source,
    NEW.source_run_id,
    NEW.parent_version_id,
    NEW.metadata,
    NEW.created_at
  ) is distinct from row(
    OLD.id,
    OLD.workspace_id,
    OLD.artifact_id,
    OLD.sequence,
    OLD.object_key,
    OLD.sha256,
    OLD.content_md5,
    OLD.size_bytes,
    OLD.mime_type,
    OLD.width,
    OLD.height,
    OLD.duration_ms,
    OLD.source,
    OLD.source_run_id,
    OLD.parent_version_id,
    OLD.metadata,
    OLD.created_at
  ) then
    raise exception 'relay.artifact_versions identity and provenance are immutable'
      using errcode = '55000';
  end if;

  if NEW.verification_status is not distinct from OLD.verification_status then
    if row(
      NEW.storage_version_id,
      NEW.etag,
      NEW.verified_at,
      NEW.failure_code
    ) is distinct from row(
      OLD.storage_version_id,
      OLD.etag,
      OLD.verified_at,
      OLD.failure_code
    ) then
      raise exception 'artifact-version verification evidence is immutable'
        using errcode = '55000';
    end if;
  elsif OLD.verification_status = 'pending'
    and NEW.verification_status in ('head_verified', 'cryptographically_verified')
  then
    if NEW.verified_at is null or NEW.failure_code is not null then
      raise exception 'verified artifact version requires verification evidence'
        using errcode = '55000';
    end if;
  elsif OLD.verification_status = 'pending'
    and NEW.verification_status = 'failed'
  then
    if NEW.storage_version_id is not null
      or NEW.etag is not null
      or NEW.verified_at is not null
      or NEW.failure_code is null
    then
      raise exception 'failed artifact version cannot retain verified storage identity'
        using errcode = '55000';
    end if;
  elsif OLD.verification_status = 'head_verified'
    and NEW.verification_status = 'cryptographically_verified'
  then
    if NEW.storage_version_id is distinct from OLD.storage_version_id
      or NEW.etag is distinct from OLD.etag
      or NEW.failure_code is distinct from OLD.failure_code
      or NEW.verified_at is null
      or NEW.verified_at < OLD.verified_at
    then
      raise exception 'cryptographic verification cannot rewrite storage identity'
        using errcode = '55000';
    end if;
  else
    raise exception 'invalid artifact-version verification transition'
      using errcode = '55000';
  end if;

  if NEW.purge_status is not distinct from OLD.purge_status then
    if NEW.purge_status = 'deleting' then
      if NEW.purge_started_at is distinct from OLD.purge_started_at
        or NEW.purged_at is distinct from OLD.purged_at
      then
        raise exception 'artifact-version purge progress is immutable within a lease'
          using errcode = '55000';
      end if;
      if NEW.purge_lease_token is distinct from OLD.purge_lease_token then
        perform 1
        from relay.artifacts a
        where a.workspace_id = NEW.workspace_id
          and a.id = NEW.artifact_id
          and a.purge_status = 'deleting'
          and a.purge_lease_token = NEW.purge_lease_token
        for share;
        if not found then
          raise exception 'artifact-version purge lease transfer is not owned'
            using errcode = '55000';
        end if;
      end if;
    elsif row(
      NEW.purge_lease_token,
      NEW.purge_started_at,
      NEW.purged_at
    ) is distinct from row(
      OLD.purge_lease_token,
      OLD.purge_started_at,
      OLD.purged_at
    ) then
      raise exception 'artifact-version purge state is immutable'
        using errcode = '55000';
    end if;
  elsif OLD.purge_status = 'not_requested' and NEW.purge_status = 'deleting' then
    perform 1
    from relay.artifacts a
    where a.workspace_id = NEW.workspace_id
      and a.id = NEW.artifact_id
      and a.purge_status = 'deleting'
      and a.purge_lease_token = NEW.purge_lease_token
    for share;
    if not found or NEW.purge_started_at is null or NEW.purged_at is not null then
      raise exception 'artifact-version purge start is not owned'
        using errcode = '55000';
    end if;
  elsif OLD.purge_status = 'deleting' and NEW.purge_status = 'deleted' then
    perform 1
    from relay.artifacts a
    where a.workspace_id = NEW.workspace_id
      and a.id = NEW.artifact_id
      and a.purge_status = 'deleting'
      and a.purge_lease_token = OLD.purge_lease_token
    for share;
    if not found
      or NEW.purge_lease_token is not null
      or NEW.purge_started_at is distinct from OLD.purge_started_at
      or NEW.purged_at is null
    then
      raise exception 'artifact-version purge completion is not owned'
        using errcode = '55000';
    end if;
  else
    raise exception 'invalid artifact-version purge transition'
      using errcode = '55000';
  end if;

  return NEW;
end;
$$;

CREATE FUNCTION relay.protect_output_item() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if row(
    NEW.id,
    NEW.workspace_id,
    NEW.output_set_id,
    NEW.name,
    NEW.ordinal,
    NEW.created_at
  ) is distinct from row(
    OLD.id,
    OLD.workspace_id,
    OLD.output_set_id,
    OLD.name,
    OLD.ordinal,
    OLD.created_at
  ) then
    raise exception 'relay.output_items identity is immutable'
      using errcode = '55000';
  end if;

  if NEW.status is distinct from OLD.status and not (
    OLD.status = 'pending' and NEW.status in ('succeeded', 'failed')
  ) then
    raise exception 'invalid output-item status transition'
      using errcode = '55000';
  end if;

  if NEW.status is not distinct from OLD.status and row(
    NEW.artifact_version_id,
    NEW.error_code,
    NEW.completed_at
  ) is distinct from row(
    OLD.artifact_version_id,
    OLD.error_code,
    OLD.completed_at
  ) then
    raise exception 'terminal output-item outcome is immutable'
      using errcode = '55000';
  end if;

  if NEW.status = 'succeeded' then
    perform 1
    from relay.output_sets os
    join relay.artifact_versions v
      on v.workspace_id = os.workspace_id
     and v.id = NEW.artifact_version_id
     and v.source = 'generated'
     and v.source_run_id = os.run_id
     and v.verification_status in ('head_verified', 'cryptographically_verified')
     and v.purged_at is null
    where os.workspace_id = NEW.workspace_id
      and os.id = NEW.output_set_id
    for share of os, v;

    if not found then
      raise exception 'successful output item must reference an available generated version from its run'
        using errcode = '23514';
    end if;
  end if;

  return NEW;
end;
$$;

CREATE FUNCTION relay.protect_output_set() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if row(
    NEW.id,
    NEW.workspace_id,
    NEW.run_id,
    NEW.requested_count,
    NEW.warnings,
    NEW.created_at
  ) is distinct from row(
    OLD.id,
    OLD.workspace_id,
    OLD.run_id,
    OLD.requested_count,
    OLD.warnings,
    OLD.created_at
  ) then
    raise exception 'relay.output_sets identity and request are immutable'
      using errcode = '55000';
  end if;

  if NEW.produced_count < OLD.produced_count then
    raise exception 'output-set produced count cannot decrease'
      using errcode = '55000';
  end if;

  if NEW.completeness is distinct from OLD.completeness and not (
    OLD.completeness = 'pending'
    and NEW.completeness in ('complete', 'partial', 'failed')
  ) then
    raise exception 'invalid output-set completeness transition'
      using errcode = '55000';
  end if;

  if OLD.completeness <> 'pending' and row(
    NEW.produced_count,
    NEW.completeness,
    NEW.finalized_at
  ) is distinct from row(
    OLD.produced_count,
    OLD.completeness,
    OLD.finalized_at
  ) then
    raise exception 'finalized output-set outcome is immutable'
      using errcode = '55000';
  end if;

  if NEW.completeness is not distinct from OLD.completeness
    and NEW.finalized_at is distinct from OLD.finalized_at
  then
    raise exception 'output-set finalization time may only be set at finalization'
      using errcode = '55000';
  end if;

  return NEW;
end;
$$;

CREATE FUNCTION relay.protect_share_link_policy() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'relay.share_links policies cannot be deleted'
      using errcode = '55000';
  end if;

  if row(
    NEW.id,
    NEW.workspace_id,
    NEW.artifact_id,
    NEW.artifact_version_id,
    NEW.token_hash,
    NEW.follow_current,
    NEW.expires_at,
    NEW.max_resolutions,
    NEW.require_auth,
    NEW.content_disposition,
    NEW.created_by,
    NEW.created_at
  ) is distinct from row(
    OLD.id,
    OLD.workspace_id,
    OLD.artifact_id,
    OLD.artifact_version_id,
    OLD.token_hash,
    OLD.follow_current,
    OLD.expires_at,
    OLD.max_resolutions,
    OLD.require_auth,
    OLD.content_disposition,
    OLD.created_by,
    OLD.created_at
  ) then
    raise exception 'relay.share_links durable policy is immutable'
      using errcode = '55000';
  end if;

  if NEW.resolution_count = OLD.resolution_count then
    if NEW.last_resolved_at is distinct from OLD.last_resolved_at then
      raise exception 'share-link resolution timestamp requires a counted resolution'
        using errcode = '55000';
    end if;
  elsif NEW.resolution_count = OLD.resolution_count + 1 then
    if OLD.revoked_at is not null
      or NEW.last_resolved_at is null
      or (
        OLD.last_resolved_at is not null
        and NEW.last_resolved_at < OLD.last_resolved_at
      )
    then
      raise exception 'share-link resolution cannot advance after revocation or move backward'
        using errcode = '55000';
    end if;
  else
    raise exception 'share-link resolution count must advance atomically'
      using errcode = '55000';
  end if;

  if NEW.revoked_at is distinct from OLD.revoked_at and not (
    OLD.revoked_at is null and NEW.revoked_at is not null
  ) then
    raise exception 'share-link revocation is irreversible'
      using errcode = '55000';
  end if;

  return NEW;
end;
$$;

CREATE FUNCTION relay.record_audit_event(p_actor_type text, p_actor_user_id text, p_oauth_client_id text, p_workspace_id text, p_action text, p_target_type text, p_target_id text, p_outcome text, p_reason_code text, p_before_snapshot jsonb, p_after_snapshot jsonb, p_request_id text, p_trace_id text, p_ip_hash_or_policy_value text, p_user_agent_summary text, p_idempotency_scope_hash text, p_idempotency_key_hash text, p_event_fingerprint text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  claimed_fingerprint text;
  existing_fingerprint text;
  stored_idempotency_key text;
begin
  if p_actor_type not in ('user', 'system', 'oauth_client')
    or p_outcome not in ('success', 'failure', 'denied')
    or nullif(pg_catalog.btrim(p_action), '') is null
    or nullif(pg_catalog.btrim(p_target_type), '') is null
  then
    raise exception 'invalid audit event identity or outcome'
      using errcode = '22023';
  end if;

  if p_action like 'system_role.superadmin.%'
    or p_action like 'changelog.%'
    or p_action like 'legal_document.%'
    or p_action = 'metering.usage.adjust'
  then
    raise exception 'protected audit actions require their dedicated mutation function'
      using errcode = '42501';
  end if;

  if p_idempotency_scope_hash is null then
    if p_idempotency_key_hash is not null or p_event_fingerprint is not null then
      raise exception 'audit idempotency metadata must be all null or all present'
        using errcode = '22023';
    end if;
    stored_idempotency_key := null;
  else
    if p_idempotency_key_hash is null
      or p_event_fingerprint is null
      or p_idempotency_scope_hash !~ '^[0-9a-f]{64}$'
      or p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
      or p_event_fingerprint !~ '^[0-9a-f]{64}$'
    then
      raise exception 'invalid audit idempotency metadata'
        using errcode = '22023';
    end if;

    insert into relay.audit_event_idempotency (
      scope_hash,
      idempotency_key_hash,
      event_fingerprint
    ) values (
      p_idempotency_scope_hash,
      p_idempotency_key_hash,
      p_event_fingerprint
    )
    on conflict (scope_hash, idempotency_key_hash) do nothing
    returning event_fingerprint into claimed_fingerprint;

    if claimed_fingerprint is null then
      select record.event_fingerprint into existing_fingerprint
      from relay.audit_event_idempotency as record
      where scope_hash = p_idempotency_scope_hash
        and idempotency_key_hash = p_idempotency_key_hash;

      if existing_fingerprint is null then
        raise exception 'audit idempotency claim disappeared unexpectedly'
          using errcode = 'XX000';
      end if;
      if existing_fingerprint = p_event_fingerprint then
        return 'replayed';
      end if;
      return 'conflict';
    end if;

    stored_idempotency_key := 'v2:' || p_idempotency_scope_hash || ':' || p_idempotency_key_hash;
  end if;

  insert into relay.audit_events (
    actor_type,
    actor_user_id,
    oauth_client_id,
    workspace_id,
    action,
    target_type,
    target_id,
    outcome,
    reason_code,
    before_snapshot,
    after_snapshot,
    request_id,
    trace_id,
    ip_hash_or_policy_value,
    user_agent_summary,
    idempotency_key
  ) values (
    p_actor_type,
    p_actor_user_id,
    p_oauth_client_id,
    p_workspace_id,
    p_action,
    p_target_type,
    p_target_id,
    p_outcome,
    p_reason_code,
    p_before_snapshot,
    p_after_snapshot,
    p_request_id,
    p_trace_id,
    p_ip_hash_or_policy_value,
    p_user_agent_summary,
    stored_idempotency_key
  );

  return 'inserted';
end;
$_$;

CREATE FUNCTION relay.reject_active_superadmin_user_delete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if exists (
    select 1
    from relay.system_role_assignments
    where user_id = old.id and revoked_at is null
  ) then
    raise exception 'an active superadmin must be revoked through relay.revoke_superadmin before deleting the user'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

CREATE FUNCTION relay.reject_artifact_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  raise exception 'relay.artifacts are retained as purge tombstones'
    using errcode = '55000';
end;
$$;

CREATE FUNCTION relay.reject_changelog_release_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  raise exception 'changelog release history cannot be deleted'
    using errcode = '55000';
end;
$$;

CREATE FUNCTION relay.reject_immutable_governance_row() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  raise exception 'published governance history is immutable'
    using errcode = '55000';
end;
$$;

CREATE FUNCTION relay.reject_immutable_metering_record() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  raise exception 'relay.% rows are immutable', TG_TABLE_NAME
    using errcode = '55000';
end;
$$;

CREATE FUNCTION relay.reject_immutable_routing_record() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  raise exception 'relay.% rows are immutable', TG_TABLE_NAME
    using errcode = '55000';
end;
$$;

CREATE FUNCTION relay.reject_system_role_assignment_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if NEW.user_id is distinct from OLD.user_id
    or NEW.role is distinct from OLD.role
    or NEW.granted_by is distinct from OLD.granted_by
    or NEW.granted_at is distinct from OLD.granted_at
    or OLD.revoked_at is not null
    or NEW.revoked_at is null
    or NEW.revoked_by is null
  then
    raise exception 'relay.system_role_assignments row % only allows a one-time revoke (revoked_by/revoked_at set together, once, on a not-yet-revoked row) -- every other mutation is rejected', OLD.id;
  end if;
  return NEW;
end;
$$;

CREATE FUNCTION relay.reject_tool_provider_binding_structure_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if NEW.id is distinct from OLD.id
    or NEW.tool_version_id is distinct from OLD.tool_version_id
    or NEW.provider_model_id is distinct from OLD.provider_model_id
    or NEW.capacity_pool_id is distinct from OLD.capacity_pool_id
    or NEW.routing_order is distinct from OLD.routing_order
    or NEW.routing_policy_id is distinct from OLD.routing_policy_id
    or NEW.created_at is distinct from OLD.created_at
  then
    raise exception 'relay.tool_provider_bindings "%" structure is immutable; only enabled may change', OLD.id
      using errcode = '55000';
  end if;
  return NEW;
end;
$$;

CREATE FUNCTION relay.reject_tool_version_deletion_after_publish() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if OLD.published_at is not null then
    raise exception 'relay.tool_versions "%" is published and immutable (cannot be deleted)', OLD.id;
  end if;
  return OLD;
end;
$$;

CREATE FUNCTION relay.reject_tool_version_mutation_after_publish() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if OLD.published_at is not null then
    raise exception 'relay.tool_versions "%" is published and fully immutable', OLD.id
      using errcode = '55000';
  end if;

  if NEW.published_at is not null and row(
    NEW.id,
    NEW.tool_id,
    NEW.version,
    NEW.input_schema,
    NEW.output_schema,
    NEW.handler_key,
    NEW.input_schema_version,
    NEW.handler_version,
    NEW.execution_mode,
    NEW.max_duration_seconds,
    NEW.meter_policy_id,
    NEW.entitlement_key,
    NEW.compatibility_metadata,
    NEW.deprecated_at,
    NEW.retired_at,
    NEW.immutable_hash,
    NEW.created_at
  ) is distinct from row(
    OLD.id,
    OLD.tool_id,
    OLD.version,
    OLD.input_schema,
    OLD.output_schema,
    OLD.handler_key,
    OLD.input_schema_version,
    OLD.handler_version,
    OLD.execution_mode,
    OLD.max_duration_seconds,
    OLD.meter_policy_id,
    OLD.entitlement_key,
    OLD.compatibility_metadata,
    OLD.deprecated_at,
    OLD.retired_at,
    OLD.immutable_hash,
    OLD.created_at
  ) then
    raise exception 'relay.tool_versions "%" publication may only set published_at', OLD.id
      using errcode = '55000';
  end if;

  return NEW;
end;
$$;

CREATE FUNCTION relay.require_complete_tool_run_metering_route() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  current_run record;
begin
  select run.workspace_id, run.tool_version_id, run.reservation_id
    into current_run
    from relay.tool_runs run
   where run.id = NEW.id;
  if not found or current_run.reservation_id is null then
    return null;
  end if;

  perform 1
    from relay.usage_reservations usage
    join relay.routing_decisions decision
      on decision.tool_run_id = NEW.id
     and decision.tool_version_id = usage.tool_version_id
     and decision.provider_model_id = usage.provider_model_id
   where usage.id = current_run.reservation_id
     and usage.workspace_id = current_run.workspace_id
     and usage.tool_version_id = current_run.tool_version_id;
  if not found then
    raise exception 'reservation-backed tool run requires a matching routing decision'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

CREATE FUNCTION relay.require_current_user_session(p_session_id text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  v_user_id text;
begin
  if nullif(pg_catalog.btrim(p_session_id), '') is null
    or pg_catalog.char_length(p_session_id) > 256
  then
    raise exception 'a valid user session is required'
      using errcode = '28000';
  end if;
  select session."userId" into v_user_id
  from auth."session" as session
  where session.id = p_session_id
    and session."expiresAt" > pg_catalog.statement_timestamp()
  for share;
  if not found then
    raise exception 'user session is missing or expired'
      using errcode = '28000';
  end if;
  return v_user_id;
end;
$$;

CREATE FUNCTION relay.require_fresh_superadmin_session(p_operator_session_id text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  operator_user_id text;
  session_created_at timestamptz;
begin
  if nullif(pg_catalog.btrim(p_operator_session_id), '') is null
    or pg_catalog.char_length(p_operator_session_id) > 256
  then
    raise exception 'a valid operator session is required'
      using errcode = '28000';
  end if;

  select session."userId", session."createdAt"
    into operator_user_id, session_created_at
  from auth."session" as session
  where session.id = p_operator_session_id
    and session."expiresAt" > pg_catalog.statement_timestamp()
  for share;

  if not found then
    raise exception 'operator session is missing or expired'
      using errcode = '28000';
  end if;

  if session_created_at < pg_catalog.statement_timestamp() - interval '15 minutes'
    or session_created_at > pg_catalog.statement_timestamp() + interval '1 minute'
  then
    raise exception 'operator session is not fresh'
      using errcode = '55000';
  end if;

  perform 1
  from relay.system_role_assignments
  where user_id = operator_user_id and revoked_at is null
  for share;

  if not found then
    raise exception 'operator is not a current superadmin'
      using errcode = '42501';
  end if;

  return operator_user_id;
end;
$$;

CREATE FUNCTION relay.revoke_superadmin(p_target_user_id text, p_operator_session_id text, p_idempotency_key_hash text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
declare
  v_operator_user_id text;
  existing_mutation relay.privileged_operation_idempotency%rowtype;
  target_assignment_id bigint;
  active_superadmin_count bigint;
  mutation_result text;
begin
  if p_idempotency_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid privileged-operation idempotency key hash'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('relay.system-role:mutations', 0)
  );
  v_operator_user_id := relay.require_fresh_superadmin_session(
    p_operator_session_id
  );

  select * into existing_mutation
  from relay.privileged_operation_idempotency
  where operation = 'revoke'
    and operator_user_id = v_operator_user_id
    and idempotency_key_hash = p_idempotency_key_hash;

  if found then
    if existing_mutation.target_user_id is distinct from p_target_user_id then
      raise exception 'privileged-operation idempotency key reused for a different target'
        using errcode = '22023';
    end if;
    return 'replayed';
  end if;

  if not exists (select 1 from auth."user" where id = p_target_user_id) then
    raise exception 'superadmin mutation target does not exist'
      using errcode = '23503';
  end if;

  select id into target_assignment_id
  from relay.system_role_assignments
  where user_id = p_target_user_id and revoked_at is null
  for update;

  if target_assignment_id is null then
    mutation_result := 'unchanged';
  else
    select pg_catalog.count(*) into active_superadmin_count
    from relay.system_role_assignments
    where revoked_at is null;

    if active_superadmin_count <= 1 then
      mutation_result := 'last_superadmin';
    else
      update relay.system_role_assignments
      set revoked_by = v_operator_user_id,
          revoked_at = pg_catalog.statement_timestamp()
      where id = target_assignment_id;
      mutation_result := 'changed';
    end if;
  end if;

  insert into relay.audit_events (
    actor_type,
    actor_user_id,
    action,
    target_type,
    target_id,
    outcome,
    reason_code,
    before_snapshot,
    after_snapshot
  ) values (
    'user',
    v_operator_user_id,
    'system_role.superadmin.revoke',
    'user',
    p_target_user_id,
    case when mutation_result = 'last_superadmin' then 'denied' else 'success' end,
    case
      when mutation_result = 'changed' then 'revoked'
      when mutation_result = 'last_superadmin' then 'last_superadmin'
      else 'already_revoked'
    end,
    pg_catalog.jsonb_build_object(
      'role', 'superadmin',
      'active', target_assignment_id is not null
    ),
    pg_catalog.jsonb_build_object(
      'role', 'superadmin',
      'active', mutation_result <> 'changed' and target_assignment_id is not null
    )
  );

  insert into relay.privileged_operation_idempotency (
    operation,
    operator_user_id,
    idempotency_key_hash,
    target_user_id,
    result
  ) values (
    'revoke',
    v_operator_user_id,
    p_idempotency_key_hash,
    p_target_user_id,
    mutation_result
  );

  return mutation_result;
end;
$_$;

CREATE FUNCTION relay.set_meter_policy_immutable_hash() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  expected_hash text;
begin
  expected_hash := relay.compute_meter_policy_immutable_hash(
    NEW.id,
    NEW.policy_key,
    NEW.revision,
    NEW.document,
    NEW.effective_at,
    NEW.expires_at
  );
  if NEW.immutable_hash is not null and NEW.immutable_hash is distinct from expected_hash then
    raise exception 'meter policy immutable_hash does not match its canonical document'
      using errcode = '23514';
  end if;
  NEW.immutable_hash := expected_hash;
  return NEW;
end;
$$;

CREATE FUNCTION relay.set_pricing_policy_immutable_hash() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  expected_hash text;
begin
  expected_hash := relay.compute_pricing_policy_immutable_hash(
    NEW.id,
    NEW.policy_key,
    NEW.revision,
    NEW.document,
    NEW.effective_at,
    NEW.expires_at
  );
  if NEW.immutable_hash is not null and NEW.immutable_hash is distinct from expected_hash then
    raise exception 'pricing policy immutable_hash does not match its canonical document'
      using errcode = '23514';
  end if;
  NEW.immutable_hash := expected_hash;
  return NEW;
end;
$$;

CREATE FUNCTION relay.set_routing_policy_immutable_hash() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  expected_hash text;
begin
  expected_hash := relay.compute_routing_policy_immutable_hash(
    NEW.id,
    NEW.revision,
    NEW.policy,
    NEW.effective_at
  );
  if NEW.immutable_hash is not null and NEW.immutable_hash is distinct from expected_hash then
    raise exception 'relay.routing_policies revision % immutable_hash does not match its canonical policy', NEW.revision
      using errcode = '23514';
  end if;
  NEW.immutable_hash := expected_hash;
  return NEW;
end;
$$;

CREATE FUNCTION relay.set_subscription_snapshot_immutable_hash() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  expected_hash text;
begin
  expected_hash := relay.compute_subscription_snapshot_immutable_hash(
    NEW.id,
    NEW.workspace_id,
    NEW.source_key,
    NEW.subscription_key,
    NEW.revision,
    NEW.state,
    NEW.catalog_item_key,
    NEW.catalog_revision,
    NEW.snapshot,
    NEW.effective_at,
    NEW.expires_at
  );
  if NEW.immutable_hash is not null and NEW.immutable_hash is distinct from expected_hash then
    raise exception 'subscription snapshot immutable_hash does not match its canonical document'
      using errcode = '23514';
  end if;
  NEW.immutable_hash := expected_hash;
  return NEW;
end;
$$;

CREATE FUNCTION relay.set_workspace_scheduling_profile(p_workspace_id text, p_class_key text, p_granted_by text, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
declare
  selected_version integer;
begin
  select policy_version into selected_version
    from relay.scheduler_classes
   where class_key = p_class_key and enabled = true
   for key share;

  if selected_version is null then
    raise exception 'unknown or disabled scheduling class %', p_class_key
      using errcode = '22023';
  end if;
  if p_class_key <> 'standard' and p_granted_by is null then
    raise exception 'non-standard scheduling profiles require granted_by'
      using errcode = '23502';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'scheduling profile expiry must be in the future'
      using errcode = '22023';
  end if;

  insert into relay.workspace_scheduling_profiles
    (workspace_id, class_key, policy_version, granted_by, granted_at, expires_at)
  values
    (p_workspace_id, p_class_key, selected_version, p_granted_by, now(), p_expires_at)
  on conflict (workspace_id) do update
    set class_key = excluded.class_key,
        policy_version = excluded.policy_version,
        granted_by = excluded.granted_by,
        granted_at = excluded.granted_at,
        expires_at = excluded.expires_at;
end;
$$;

CREATE FUNCTION relay.validate_artifact_head() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  old_sequence integer;
  new_sequence integer;
  new_verification_status text;
  new_purged_at timestamptz;
  is_purge_claim boolean;
begin
  if row(
    NEW.id,
    NEW.workspace_id,
    NEW.source_run_id,
    NEW.created_by,
    NEW.created_at
  ) is distinct from row(
    OLD.id,
    OLD.workspace_id,
    OLD.source_run_id,
    OLD.created_by,
    OLD.created_at
  ) then
    raise exception 'relay.artifacts identity and provenance are immutable'
      using errcode = '55000';
  end if;

  is_purge_claim := (
    (OLD.purge_status = 'pending' and NEW.purge_status = 'claimed')
    or (
      OLD.purge_status = 'deleting_pending'
      and NEW.purge_status = 'deleting'
    )
    or (
      OLD.purge_status in ('claimed', 'deleting')
      and NEW.purge_status = OLD.purge_status
      and NEW.purge_lease_token is distinct from OLD.purge_lease_token
    )
  );

  if NEW.purge_status is distinct from OLD.purge_status and not (
    (OLD.purge_status = 'not_requested' and NEW.purge_status = 'pending')
    or (OLD.purge_status = 'pending' and NEW.purge_status in ('claimed', 'not_requested'))
    or (OLD.purge_status = 'claimed' and NEW.purge_status in ('pending', 'deleting'))
    or (OLD.purge_status = 'deleting' and NEW.purge_status in ('deleting_pending', 'purged'))
    or (OLD.purge_status = 'deleting_pending' and NEW.purge_status = 'deleting')
  ) then
    raise exception 'invalid artifact purge transition'
      using errcode = '55000';
  end if;

  if is_purge_claim then
    if NEW.purge_attempt_count <> OLD.purge_attempt_count + 1 then
      raise exception 'claiming artifact purge must increment attempts once'
        using errcode = '55000';
    end if;
  elsif NEW.purge_attempt_count <> OLD.purge_attempt_count then
    raise exception 'artifact purge attempts may only increment on claim'
      using errcode = '55000';
  end if;

  if NEW.purge_status is not distinct from OLD.purge_status then
    if row(
      NEW.deleted_at,
      NEW.purge_after,
      NEW.purge_io_started_at,
      NEW.purged_at
    ) is distinct from row(
      OLD.deleted_at,
      OLD.purge_after,
      OLD.purge_io_started_at,
      OLD.purged_at
    ) then
      raise exception 'artifact purge lifecycle fields are immutable within a state'
        using errcode = '55000';
    end if;
    if OLD.purge_status not in ('claimed', 'deleting') and row(
      NEW.purge_lease_token,
      NEW.purge_claimed_at
    ) is distinct from row(
      OLD.purge_lease_token,
      OLD.purge_claimed_at
    ) then
      raise exception 'artifact purge lease fields require a claimed state'
        using errcode = '55000';
    end if;
    if OLD.purge_status in ('claimed', 'deleting')
      and NEW.purge_lease_token is distinct from OLD.purge_lease_token
      and not is_purge_claim
    then
      raise exception 'artifact purge lease transfer must be a fenced reclaim'
        using errcode = '55000';
    end if;
  elsif OLD.purge_status <> 'not_requested'
    and NEW.purge_status <> 'not_requested'
    and row(NEW.deleted_at, NEW.purge_after) is distinct from
        row(OLD.deleted_at, OLD.purge_after)
  then
    raise exception 'artifact purge target timing is immutable after deletion'
      using errcode = '55000';
  end if;

  if NEW.purge_io_started_at is distinct from OLD.purge_io_started_at and not (
    OLD.purge_io_started_at is null
    and NEW.purge_io_started_at is not null
    and OLD.purge_status = 'claimed'
    and NEW.purge_status = 'deleting'
  ) then
    raise exception 'artifact purge I/O start is irreversible and owned'
      using errcode = '55000';
  end if;

  if NEW.current_version_id is distinct from OLD.current_version_id then
    if NEW.current_version_id is null then
      if NEW.purged_at is null then
        raise exception 'artifact head can only be cleared by purge'
          using errcode = '55000';
      end if;
    else
      select sequence, verification_status, purged_at
        into new_sequence, new_verification_status, new_purged_at
      from relay.artifact_versions
      where id = NEW.current_version_id
        and workspace_id = NEW.workspace_id
        and artifact_id = NEW.id
      for share;

      if not found
        or new_verification_status not in ('head_verified', 'cryptographically_verified')
        or new_purged_at is not null
      then
        raise exception 'artifact head must reference an available version'
          using errcode = '23514';
      end if;

      if OLD.current_version_id is not null then
        select sequence into old_sequence
        from relay.artifact_versions
        where id = OLD.current_version_id;
        if new_sequence <= old_sequence then
          raise exception 'artifact head must advance to a newer version'
            using errcode = '55000';
        end if;
      end if;
    end if;
  end if;

  if OLD.deleted_at is not null and NEW.deleted_at is null and (
    NEW.current_version_id is null
    or NEW.current_version_id is not distinct from OLD.current_version_id
  ) then
    raise exception 'restoring an artifact requires a new head version'
      using errcode = '55000';
  end if;

  if NEW.purged_at is distinct from OLD.purged_at and not (
    OLD.purged_at is null
    and NEW.purged_at is not null
    and OLD.purge_status = 'deleting'
    and NEW.purge_status = 'purged'
    and NEW.purge_io_started_at is not null
  ) then
    raise exception 'artifact purge marker requires a fenced deleting purge'
      using errcode = '55000';
  end if;

  if OLD.purge_status = 'deleting' and NEW.purge_status = 'purged' and exists (
    select 1
    from relay.artifact_versions v
    where v.workspace_id = OLD.workspace_id
      and v.artifact_id = OLD.id
      and v.purge_status <> 'deleted'
  ) then
    raise exception 'artifact purge cannot finalize before every version is deleted'
      using errcode = '55000';
  end if;

  return NEW;
end;
$$;

CREATE FUNCTION relay.validate_artifact_upload() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  version_record record;
  is_cleanup_claim boolean;
begin
  select object_key, size_bytes, mime_type, sha256, content_md5,
         source, source_run_id
    into version_record
  from relay.artifact_versions
  where id = NEW.artifact_version_id
    and workspace_id = NEW.workspace_id
    and artifact_id = NEW.artifact_id
  for share;

  if not found
    or NEW.object_key is distinct from version_record.object_key
    or NEW.expected_size_bytes is distinct from version_record.size_bytes
    or NEW.expected_mime_type is distinct from version_record.mime_type
    or NEW.expected_sha256 is distinct from version_record.sha256
    or NEW.content_md5 is distinct from version_record.content_md5
    or (
      NEW.kind = 'direct_upload'
      and version_record.source <> 'upload'
    )
    or (
      NEW.kind in ('generated', 'restore')
      and version_record.source <> NEW.kind
    )
    or (NEW.kind = 'generated' and not NEW.created_artifact)
    or (NEW.kind = 'restore' and NEW.created_artifact)
    or (
      NEW.kind = 'restore'
      and NEW.expected_previous_version_id is null
    )
  then
    raise exception 'artifact upload does not match its immutable version'
      using errcode = '23514';
  end if;

  if NEW.kind = 'generated' then
    perform 1
    from relay.output_items oi
    join relay.output_sets os
      on os.workspace_id = oi.workspace_id and os.id = oi.output_set_id
    where oi.workspace_id = NEW.workspace_id
      and oi.id = NEW.output_item_id
      and os.run_id = version_record.source_run_id
    for share of oi, os;

    if not found then
      raise exception 'generated artifact upload must belong to its source run output set'
        using errcode = '23514';
    end if;
  end if;

  if TG_OP = 'UPDATE' then
    if row(
      NEW.id,
      NEW.workspace_id,
      NEW.artifact_id,
      NEW.artifact_version_id,
      NEW.output_item_id,
      NEW.kind,
      NEW.object_key,
      NEW.expected_previous_version_id,
      NEW.expected_size_bytes,
      NEW.expected_mime_type,
      NEW.expected_sha256,
      NEW.content_md5,
      NEW.expires_at,
      NEW.quota_reservation_id,
      NEW.created_artifact,
      NEW.created_at
    ) is distinct from row(
      OLD.id,
      OLD.workspace_id,
      OLD.artifact_id,
      OLD.artifact_version_id,
      OLD.output_item_id,
      OLD.kind,
      OLD.object_key,
      OLD.expected_previous_version_id,
      OLD.expected_size_bytes,
      OLD.expected_mime_type,
      OLD.expected_sha256,
      OLD.content_md5,
      OLD.expires_at,
      OLD.quota_reservation_id,
      OLD.created_artifact,
      OLD.created_at
    ) then
      raise exception 'artifact upload identity and expectations are immutable'
        using errcode = '55000';
    end if;

    if NEW.status is distinct from OLD.status and not (
      OLD.status = 'pending' and NEW.status in ('completed', 'failed', 'expired')
    ) then
      raise exception 'invalid artifact-upload status transition'
        using errcode = '55000';
    end if;

    if NEW.quota_state is distinct from OLD.quota_state and not (
      (OLD.quota_state = 'reserved' and NEW.quota_state in ('committed', 'cleanup_held'))
      or (
        OLD.quota_state = 'cleanup_held'
        and NEW.quota_state = 'released'
        and OLD.cleanup_status = 'claimed'
        and NEW.cleanup_status = 'deleted'
      )
      or (
        OLD.quota_state = 'committed'
        and NEW.quota_state = 'decremented'
      )
    ) then
      raise exception 'invalid artifact-upload quota transition'
        using errcode = '55000';
    end if;

    if OLD.quota_state = 'committed' and NEW.quota_state = 'decremented' then
      perform 1
      from relay.artifact_versions v
      join relay.artifacts a
        on a.workspace_id = v.workspace_id and a.id = v.artifact_id
      where v.workspace_id = NEW.workspace_id
        and v.id = NEW.artifact_version_id
        and v.purge_status = 'deleting'
        and a.purge_status = 'deleting'
        and v.purge_lease_token = a.purge_lease_token
      for share of v, a;
      if not found then
        raise exception 'committed quota decrement requires an owned version purge'
          using errcode = '55000';
      end if;
    end if;

    if NEW.cleanup_status is distinct from OLD.cleanup_status and not (
      (OLD.cleanup_status = 'not_required' and NEW.cleanup_status = 'pending')
      or (OLD.cleanup_status = 'pending' and NEW.cleanup_status = 'claimed')
      or (OLD.cleanup_status = 'claimed' and NEW.cleanup_status in ('pending', 'deleted'))
    ) then
      raise exception 'invalid artifact-upload cleanup transition'
        using errcode = '55000';
    end if;

    if NEW.status is not distinct from OLD.status and row(
      NEW.completed_at,
      NEW.became_current,
      NEW.failure_code,
      NEW.cleanup_storage_version_id
    ) is distinct from row(
      OLD.completed_at,
      OLD.became_current,
      OLD.failure_code,
      OLD.cleanup_storage_version_id
    ) then
      raise exception 'artifact-upload terminal outcome is immutable'
        using errcode = '55000';
    end if;

    if NEW.cleanup_storage_version_id is distinct from OLD.cleanup_storage_version_id
      and not (
        OLD.status = 'pending'
        and NEW.status in ('failed', 'expired')
        and OLD.cleanup_storage_version_id is null
      )
    then
      raise exception 'cleanup storage identity can only be captured on failure'
        using errcode = '55000';
    end if;

    is_cleanup_claim := (
      (OLD.cleanup_status = 'pending' and NEW.cleanup_status = 'claimed')
      or (
        OLD.cleanup_status = 'claimed'
        and NEW.cleanup_status = 'claimed'
        and NEW.cleanup_lease_token is distinct from OLD.cleanup_lease_token
      )
    );
    if is_cleanup_claim then
      if NEW.cleanup_attempt_count <> OLD.cleanup_attempt_count + 1 then
        raise exception 'claiming artifact-upload cleanup must increment attempts once'
          using errcode = '55000';
      end if;
    elsif NEW.cleanup_attempt_count <> OLD.cleanup_attempt_count then
      raise exception 'artifact-upload cleanup attempts may only increment on claim'
        using errcode = '55000';
    end if;
  end if;

  return NEW;
end;
$$;

CREATE FUNCTION relay.validate_capacity_pool_binding_consistency() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if NEW.provider_model_id is not null and exists (
    select 1
    from relay.tool_provider_bindings tpb
    where tpb.capacity_pool_id = NEW.id
      and tpb.provider_model_id <> NEW.provider_model_id
  ) then
    raise exception 'capacity pool model conflicts with an existing tool-provider binding'
      using errcode = '23514';
  end if;

  return NEW;
end;
$$;

CREATE FUNCTION relay.validate_provider_cost_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  policy record;
  routing_context record;
begin
  perform 1
    from relay.tool_runs
   where id = NEW.run_id and workspace_id = NEW.workspace_id
   for share;
  if not found then
    raise exception 'provider cost run is unavailable in this workspace'
      using errcode = '23503';
  end if;

  if NEW.attempt_id is not null and not exists (
    select 1
      from relay.job_attempts attempt
      join relay.execution_jobs job on job.id = attempt.job_id
      join relay.routing_decisions decision
        on decision.tool_run_id = job.run_id
     where attempt.id = NEW.attempt_id
       and job.run_id = NEW.run_id
       and attempt.routing_decision_id = decision.id
  ) then
    raise exception 'provider cost attempt does not match its run routing decision'
      using errcode = '23514';
  end if;

  select decision.provider_model_id, model.pricing_policy_id
    into routing_context
    from relay.routing_decisions decision
    join relay.provider_models model on model.id = decision.provider_model_id
   where decision.tool_run_id = NEW.run_id;
  if not found
    or NEW.provider_model_id is distinct from routing_context.provider_model_id
    or NEW.pricing_policy_id is distinct from routing_context.pricing_policy_id
  then
    raise exception 'provider cost does not match its run routing decision'
      using errcode = '23514';
  end if;

  select policy_key, document into policy
    from relay.pricing_policies
   where id = NEW.pricing_policy_id
     and revision = NEW.pricing_policy_revision
     and immutable_hash = NEW.pricing_policy_hash;
  if not found
    or NEW.pricing_policy_key is distinct from policy.policy_key
    or NEW.pricing_policy_snapshot is distinct from policy.document
  then
    raise exception 'provider cost pricing policy snapshot is invalid'
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

CREATE FUNCTION relay.validate_routing_decision_consistency() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  route record;
  has_higher_priority_binding boolean;
  has_higher_priority_available_binding boolean;
begin
  select tpb.tool_version_id,
         tv.tool_id,
         tv.version as tool_version_number,
         tv.input_schema,
         tv.output_schema,
         tv.immutable_hash as tool_version_immutable_hash,
         tv.handler_key,
         tv.input_schema_version,
         tv.handler_version,
         tv.execution_mode,
         tv.max_duration_seconds,
         tv.meter_policy_id,
         tv.entitlement_key,
         tv.compatibility_metadata,
         tpb.provider_model_id,
         pm.provider_id,
         tpb.capacity_pool_id,
         tpb.routing_order,
         tpb.routing_policy_id,
         rp.revision as routing_policy_revision,
         rp.policy as routing_policy,
         rp.effective_at as routing_policy_effective_at,
         rp.immutable_hash as routing_policy_immutable_hash,
         tv.published_at,
         t.lifecycle as tool_lifecycle,
         tpb.enabled as binding_enabled,
         p.lifecycle as provider_lifecycle,
         pm.lifecycle as provider_model_lifecycle,
         cp.enabled as capacity_pool_enabled,
         cp.provider_model_id as pool_provider_model_id
  into route
  from relay.tool_provider_bindings tpb
  join relay.tool_versions tv on tv.id = tpb.tool_version_id
  join relay.tools t on t.id = tv.tool_id
  join relay.provider_models pm on pm.id = tpb.provider_model_id
  join relay.providers p on p.id = pm.provider_id
  join relay.capacity_pools cp on cp.id = tpb.capacity_pool_id
  left join relay.routing_policies rp on rp.id = tpb.routing_policy_id
  where tpb.id = NEW.selected_binding_id
  for share of tpb, tv, t, pm, p, cp;

  if not found then
    raise exception 'routing decision references an unknown catalog binding'
      using errcode = '23503';
  end if;

  perform 1
  from relay.tool_runs tr
  where tr.id = NEW.tool_run_id
    and tr.tool_version_id = route.tool_version_id
  for share;
  if not found then
    raise exception 'routing decision binding belongs to a different tool version'
      using errcode = '23514';
  end if;

  if NEW.provider_model_id <> route.provider_model_id then
    raise exception 'routing decision provider model disagrees with its binding'
      using errcode = '23514';
  end if;
  if NEW.provider_id <> route.provider_id then
    raise exception 'routing decision provider disagrees with its model'
      using errcode = '23514';
  end if;
  if NEW.tool_id is not null and NEW.tool_id <> route.tool_id then
    raise exception 'routing decision tool disagrees with its binding'
      using errcode = '23514';
  end if;
  if NEW.tool_version_id is not null and
     NEW.tool_version_id <> route.tool_version_id then
    raise exception 'routing decision tool version disagrees with its binding'
      using errcode = '23514';
  end if;
  if NEW.capacity_pool_id is not null and
     NEW.capacity_pool_id <> route.capacity_pool_id then
    raise exception 'routing decision capacity pool disagrees with its binding'
      using errcode = '23514';
  end if;
  if NEW.routing_order is not null and
     NEW.routing_order <> route.routing_order then
    raise exception 'routing decision order disagrees with its binding'
      using errcode = '23514';
  end if;
  if NEW.routing_policy_id is not null and
     NEW.routing_policy_id is distinct from route.routing_policy_id then
    raise exception 'routing decision policy identity disagrees with its binding revision'
      using errcode = '23514';
  end if;
  if NEW.routing_policy_revision is not null and
     NEW.routing_policy_revision is distinct from route.routing_policy_revision then
    raise exception 'routing decision policy identity disagrees with its binding revision'
      using errcode = '23514';
  end if;

  if route.tool_version_immutable_hash is distinct from
    relay.compute_tool_version_immutable_hash(
      route.tool_version_id,
      route.tool_id,
      route.tool_version_number,
      route.input_schema,
      route.output_schema,
      route.handler_key,
      route.input_schema_version,
      route.handler_version,
      route.execution_mode,
      route.max_duration_seconds,
      route.meter_policy_id,
      route.entitlement_key,
      route.compatibility_metadata
    ) then
    raise exception 'routing decision selected a tool version with an invalid immutable hash'
      using errcode = '23514';
  end if;

  if route.routing_policy_id is not null and (
    route.routing_policy_immutable_hash is distinct from
      relay.compute_routing_policy_immutable_hash(
        route.routing_policy_id,
        route.routing_policy_revision,
        route.routing_policy,
        route.routing_policy_effective_at
      )
    or route.routing_policy_effective_at > pg_catalog.statement_timestamp()
  ) then
    raise exception 'routing decision selected an invalid or not-yet-effective routing policy'
      using errcode = '23514';
  end if;

  if route.pool_provider_model_id is not null and
     route.pool_provider_model_id <> route.provider_model_id then
    raise exception 'routing decision binding conflicts with its capacity pool model'
      using errcode = '23514';
  end if;
  if route.published_at is null or route.tool_lifecycle in ('disabled', 'retired') or
     not route.binding_enabled or route.provider_lifecycle in ('disabled', 'retired') or
     route.provider_model_lifecycle in ('disabled', 'retired') or
     not route.capacity_pool_enabled then
    raise exception 'routing decision selected an unavailable catalog route'
      using errcode = '55000';
  end if;

  perform 1
  from relay.tool_provider_bindings candidate
  join relay.provider_models candidate_model
    on candidate_model.id = candidate.provider_model_id
  join relay.providers candidate_provider
    on candidate_provider.id = candidate_model.provider_id
  join relay.capacity_pools candidate_pool
    on candidate_pool.id = candidate.capacity_pool_id
  where candidate.tool_version_id = route.tool_version_id
  for share of candidate, candidate_model, candidate_provider, candidate_pool;

  if exists (
    select 1
    from relay.tool_provider_bindings earlier
    join relay.routing_policies earlier_policy
      on earlier_policy.id = earlier.routing_policy_id
    where earlier.tool_version_id = route.tool_version_id
      and earlier.routing_order < route.routing_order
      and earlier_policy.immutable_hash is distinct from
        relay.compute_routing_policy_immutable_hash(
          earlier_policy.id,
          earlier_policy.revision,
          earlier_policy.policy,
          earlier_policy.effective_at
        )
  ) then
    raise exception 'higher-priority routing policy has an invalid immutable hash'
      using errcode = '23514';
  end if;

  select exists (
    select 1
    from relay.tool_provider_bindings earlier
    where earlier.tool_version_id = route.tool_version_id
      and earlier.routing_order < route.routing_order
  ) into has_higher_priority_binding;

  select exists (
    select 1
    from relay.tool_provider_bindings earlier
    join relay.provider_models earlier_model
      on earlier_model.id = earlier.provider_model_id
    join relay.providers earlier_provider
      on earlier_provider.id = earlier_model.provider_id
    join relay.capacity_pools earlier_pool
      on earlier_pool.id = earlier.capacity_pool_id
    left join relay.routing_policies earlier_policy
      on earlier_policy.id = earlier.routing_policy_id
    where earlier.tool_version_id = route.tool_version_id
      and earlier.routing_order < route.routing_order
      and earlier.enabled
      and earlier_provider.lifecycle not in ('disabled', 'retired')
      and earlier_model.lifecycle not in ('disabled', 'retired')
      and earlier_pool.enabled
      and (
        earlier_pool.provider_model_id is null
        or earlier_pool.provider_model_id = earlier.provider_model_id
      )
      and (
        earlier.routing_policy_id is null
        or (
          earlier_policy.effective_at <= pg_catalog.statement_timestamp()
          and earlier_policy.immutable_hash =
            relay.compute_routing_policy_immutable_hash(
              earlier_policy.id,
              earlier_policy.revision,
              earlier_policy.policy,
              earlier_policy.effective_at
            )
        )
      )
  ) into has_higher_priority_available_binding;

  if has_higher_priority_available_binding then
    raise exception 'routing decision did not select the highest-priority available binding'
      using errcode = '23514';
  end if;

  if has_higher_priority_binding then
    if route.routing_policy_id is null or
       route.routing_policy #>> '{fallback,mode}' is distinct from 'ordered' then
      raise exception 'routing decision fallback is not permitted by its routing policy'
        using errcode = '42501';
    end if;
    NEW.fallback_used := true;
    NEW.fallback_reason := coalesce(
      nullif(pg_catalog.btrim(NEW.fallback_reason), ''),
      'higher_priority_route_unavailable'
    );
  else
    NEW.fallback_used := false;
    NEW.fallback_reason := null;
  end if;

  NEW.tool_id := route.tool_id;
  NEW.tool_version_id := route.tool_version_id;
  NEW.tool_version_immutable_hash := route.tool_version_immutable_hash;
  NEW.handler_key := route.handler_key;
  NEW.input_schema_version := route.input_schema_version;
  NEW.handler_version := route.handler_version;
  NEW.capacity_pool_id := route.capacity_pool_id;
  NEW.routing_order := route.routing_order;
  NEW.routing_policy_id := route.routing_policy_id;
  NEW.routing_policy_revision := route.routing_policy_revision;
  NEW.routing_policy_immutable_hash := route.routing_policy_immutable_hash;

  return NEW;
end;
$$;

CREATE FUNCTION relay.validate_routing_decision_reservation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  reservation record;
begin
  select run.tool_version_id as run_tool_version_id,
         usage.tool_version_id, usage.provider_model_id
    into reservation
    from relay.tool_runs run
    join relay.usage_reservations usage on usage.id = run.reservation_id
   where run.id = NEW.tool_run_id;
  if found and (
    reservation.run_tool_version_id is distinct from reservation.tool_version_id
    or NEW.provider_model_id is distinct from reservation.provider_model_id
  ) then
    raise exception 'routing decision does not match its usage reservation'
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

CREATE FUNCTION relay.validate_tool_active_version() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if NEW.active_version_id is null then
    if NEW.lifecycle in ('published', 'deprecated') then
      raise exception 'published or deprecated tools require an active version'
        using errcode = '23514';
    end if;
    return NEW;
  end if;

  perform 1
  from relay.tool_versions tv
  where tv.id = NEW.active_version_id
    and tv.tool_id = NEW.id
    and tv.published_at is not null
  for share;

  if not found then
    raise exception 'tool active_version_id must reference a published version of the same tool'
      using errcode = '23514';
  end if;

  return NEW;
end;
$$;

CREATE FUNCTION relay.validate_tool_provider_binding_consistency() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  pool_provider_model_id bigint;
begin
  perform 1
  from relay.tool_versions
  where id = NEW.tool_version_id
  for update;

  select provider_model_id
  into pool_provider_model_id
  from relay.capacity_pools
  where id = NEW.capacity_pool_id
  for share;

  if pool_provider_model_id is not null and
     pool_provider_model_id <> NEW.provider_model_id then
    raise exception 'tool-provider binding model does not match its capacity pool model'
      using errcode = '23514';
  end if;

  return NEW;
end;
$$;

CREATE FUNCTION relay.validate_tool_run_reservation_context() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  reservation_provider_model_id bigint;
  routed_provider_model_id bigint;
begin
  if NEW.reservation_id is null then
    return NEW;
  end if;

  select usage.provider_model_id into reservation_provider_model_id
    from relay.usage_reservations usage
   where usage.id = NEW.reservation_id
     and usage.workspace_id = NEW.workspace_id
     and usage.tool_version_id = NEW.tool_version_id
     and usage.status = 'active'
   for share;
  if not found then
    raise exception 'tool run reservation does not match its workspace and tool version'
      using errcode = '23514';
  end if;

  select decision.provider_model_id into routed_provider_model_id
    from relay.routing_decisions decision
   where decision.tool_run_id = NEW.id;
  if found and routed_provider_model_id is distinct from reservation_provider_model_id then
    raise exception 'tool run reservation does not match its routing provider model'
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

CREATE FUNCTION relay.validate_usage_adjustment_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  original record;
begin
  select bucket_id, metric_key, unit, meter_policy_id, meter_policy_key,
         meter_policy_revision, meter_policy_hash, meter_policy_snapshot,
         entitlement_snapshot
    into original
    from relay.usage_events
   where id = NEW.usage_event_id and workspace_id = NEW.workspace_id;
  if not found
    or NEW.bucket_id is distinct from original.bucket_id
    or NEW.metric_key is distinct from original.metric_key
    or NEW.unit is distinct from original.unit
    or NEW.meter_policy_id is distinct from original.meter_policy_id
    or NEW.meter_policy_key is distinct from original.meter_policy_key
    or NEW.meter_policy_revision is distinct from original.meter_policy_revision
    or NEW.meter_policy_hash is distinct from original.meter_policy_hash
    or NEW.meter_policy_snapshot is distinct from original.meter_policy_snapshot
    or NEW.entitlement_snapshot is distinct from original.entitlement_snapshot
  then
    raise exception 'usage adjustment does not match its original event snapshot'
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

CREATE FUNCTION relay.validate_usage_event_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  reservation record;
begin
  select bucket_id, metric_key, unit, meter_policy_id, meter_policy_key,
         meter_policy_revision, meter_policy_hash, meter_policy_snapshot,
         entitlement_snapshot
    into reservation
    from relay.usage_reservations
   where id = NEW.reservation_id
     and workspace_id = NEW.workspace_id
     and status = 'active'
   for share;
  if not found
    or NEW.bucket_id is distinct from reservation.bucket_id
    or NEW.metric_key is distinct from reservation.metric_key
    or NEW.unit is distinct from reservation.unit
    or NEW.meter_policy_id is distinct from reservation.meter_policy_id
    or NEW.meter_policy_key is distinct from reservation.meter_policy_key
    or NEW.meter_policy_revision is distinct from reservation.meter_policy_revision
    or NEW.meter_policy_hash is distinct from reservation.meter_policy_hash
    or NEW.meter_policy_snapshot is distinct from reservation.meter_policy_snapshot
    or NEW.entitlement_snapshot is distinct from reservation.entitlement_snapshot
  then
    raise exception 'usage event does not match its reservation snapshot'
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

CREATE FUNCTION relay.validate_usage_reservation_context() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
declare
  policy record;
  tool_context record;
begin
  select tv.meter_policy_id, tv.entitlement_key
    into tool_context
    from relay.tool_versions tv
    join relay.tools tool on tool.id = tv.tool_id
   where tv.id = NEW.tool_version_id
     and tv.published_at is not null
     and tool.lifecycle not in ('disabled', 'retired')
     and exists (
       select 1
         from relay.tool_provider_bindings binding
         join relay.provider_models model on model.id = binding.provider_model_id
         join relay.providers provider on provider.id = model.provider_id
         join relay.capacity_pools pool on pool.id = binding.capacity_pool_id
        where binding.tool_version_id = tv.id
          and binding.provider_model_id = NEW.provider_model_id
          and binding.enabled = true
          and model.lifecycle not in ('disabled', 'retired')
          and provider.lifecycle not in ('disabled', 'retired')
          and pool.enabled = true
     );
  if not found
    or NEW.meter_policy_id is distinct from tool_context.meter_policy_id
    or NEW.capability_key is distinct from tool_context.entitlement_key
  then
    raise exception 'usage reservation does not match its tool and routing model'
      using errcode = '23514';
  end if;

  select policy_key, document into policy
    from relay.meter_policies
   where id = NEW.meter_policy_id
     and revision = NEW.meter_policy_revision
     and immutable_hash = NEW.meter_policy_hash;
  if not found
    or NEW.meter_policy_key is distinct from policy.policy_key
    or NEW.meter_policy_snapshot is distinct from policy.document
  then
    raise exception 'usage reservation meter policy snapshot is invalid'
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE auth.account (
    id text NOT NULL,
    issuer text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth.invitation (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    email text NOT NULL,
    role text,
    status text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "inviterId" text NOT NULL
);

CREATE TABLE auth.jwks (
    id text NOT NULL,
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "expiresAt" timestamp with time zone,
    alg text,
    crv text
);

CREATE TABLE auth."oauthClient" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "clientSecret" text,
    "clientDiscoveryId" text,
    disabled boolean,
    "skipConsent" boolean,
    "enableEndSession" boolean,
    "subjectType" text,
    scopes jsonb,
    "clientCredentialsScopes" jsonb,
    "userId" text,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone,
    name text,
    uri text,
    icon text,
    contacts jsonb,
    tos text,
    policy text,
    "softwareId" text,
    "softwareVersion" text,
    "softwareStatement" text,
    "redirectUris" jsonb NOT NULL,
    "postLogoutRedirectUris" jsonb,
    "backchannelLogoutUri" text,
    "backchannelLogoutSessionRequired" boolean,
    "tokenEndpointAuthMethod" text,
    "applicationType" text,
    jwks text,
    "jwksUri" text,
    "grantTypes" jsonb,
    "responseTypes" jsonb,
    "requirePKCE" boolean,
    "dpopBoundAccessTokens" boolean,
    "referenceId" text,
    metadata jsonb
);

CREATE TABLE auth."oauthResource" (
    id text NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    "accessTokenTtl" integer,
    "refreshTokenTtl" integer,
    "signingAlgorithm" text,
    "signingKeyId" text,
    "allowedScopes" jsonb,
    "customClaims" jsonb,
    "dpopBoundAccessTokensRequired" boolean,
    disabled boolean,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone,
    "policyVersion" integer,
    metadata jsonb
);

CREATE TABLE auth."oauthClientResource" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "resourceId" text NOT NULL,
    metadata jsonb,
    "createdAt" timestamp with time zone
);

CREATE TABLE auth."oauthRefreshToken" (
    id text NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" text,
    "userId" text NOT NULL,
    "referenceId" text,
    "authorizationCodeId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    revoked timestamp with time zone,
    "rotatedAt" timestamp with time zone,
    "rotationReplayResponse" text,
    "rotationReplayExpiresAt" timestamp with time zone,
    "authTime" timestamp with time zone,
    confirmation jsonb,
    scopes jsonb NOT NULL
);

CREATE TABLE auth."oauthAccessToken" (
    id text NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" text,
    "userId" text,
    "referenceId" text,
    "authorizationCodeId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    "refreshId" text,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    revoked timestamp with time zone,
    confirmation jsonb,
    scopes jsonb NOT NULL
);

CREATE TABLE auth."oauthConsent" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "userId" text,
    "referenceId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    scopes jsonb NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth."oauthClientAssertion" (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth.member (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    "userId" text NOT NULL,
    role text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth.organization (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    logo text,
    "createdAt" timestamp with time zone NOT NULL,
    metadata text
);

CREATE TABLE auth."rateLimit" (
    id text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    "lastRequest" bigint NOT NULL
);

CREATE TABLE auth.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL,
    "activeOrganizationId" text
);

CREATE TABLE auth."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE auth.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE relay.artifact_uploads (
    id text NOT NULL,
    workspace_id text NOT NULL,
    artifact_id text NOT NULL,
    artifact_version_id text NOT NULL,
    output_item_id bigint,
    kind text NOT NULL,
    object_key text NOT NULL,
    expected_previous_version_id text,
    expected_size_bytes bigint NOT NULL,
    expected_mime_type text NOT NULL,
    expected_sha256 text NOT NULL,
    content_md5 text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    became_current boolean,
    failure_code text,
    quota_reservation_id text NOT NULL,
    quota_state text DEFAULT 'reserved'::text NOT NULL,
    cleanup_status text DEFAULT 'not_required'::text NOT NULL,
    cleanup_lease_token text,
    cleanup_claimed_at timestamp with time zone,
    cleanup_available_at timestamp with time zone,
    cleanup_storage_version_id text,
    cleanup_attempt_count integer DEFAULT 0 NOT NULL,
    cleanup_last_error text,
    created_artifact boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT artifact_uploads_cleanup_attempt_count_check CHECK ((cleanup_attempt_count >= 0)),
    CONSTRAINT artifact_uploads_cleanup_last_error_check CHECK (((cleanup_last_error IS NULL) OR (((char_length(cleanup_last_error) >= 1) AND (char_length(cleanup_last_error) <= 512)) AND (cleanup_last_error !~ '[[:cntrl:]]'::text) AND (cleanup_last_error !~* '[a-z][a-z0-9+.-]*://'::text)))),
    CONSTRAINT artifact_uploads_cleanup_status_check CHECK ((cleanup_status = ANY (ARRAY['not_required'::text, 'pending'::text, 'claimed'::text, 'deleted'::text]))),
    CONSTRAINT artifact_uploads_cleanup_storage_version_id_check CHECK (((cleanup_storage_version_id IS NULL) OR (((char_length(cleanup_storage_version_id) >= 1) AND (char_length(cleanup_storage_version_id) <= 1024)) AND (cleanup_storage_version_id !~ '[[:cntrl:]]'::text) AND (cleanup_storage_version_id !~* '[a-z][a-z0-9+.-]*://'::text)))),
    CONSTRAINT artifact_uploads_content_md5_check CHECK ((content_md5 ~ '^[A-Za-z0-9+/]{22}==$'::text)),
    CONSTRAINT artifact_uploads_expected_mime_type_check CHECK ((((char_length(btrim(expected_mime_type)) >= 1) AND (char_length(btrim(expected_mime_type)) <= 255)) AND (expected_mime_type !~ '[[:cntrl:]]'::text) AND (expected_mime_type !~* '[a-z][a-z0-9+.-]*://'::text))),
    CONSTRAINT artifact_uploads_expected_sha256_check CHECK ((expected_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT artifact_uploads_expected_size_bytes_check CHECK ((expected_size_bytes >= 0)),
    CONSTRAINT artifact_uploads_failure_code_check CHECK (((failure_code IS NULL) OR (failure_code ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT artifact_uploads_id_check CHECK ((id ~ '^upl_[0-9a-f]{32}$'::text)),
    CONSTRAINT artifact_uploads_kind_check CHECK ((kind = ANY (ARRAY['direct_upload'::text, 'generated'::text, 'restore'::text]))),
    CONSTRAINT artifact_uploads_lifecycle_check CHECK (((expires_at > created_at) AND (((status = 'pending'::text) AND (completed_at IS NULL) AND (became_current IS NULL) AND (failure_code IS NULL) AND (quota_state = 'reserved'::text) AND (cleanup_status = 'not_required'::text) AND (cleanup_available_at IS NULL) AND (cleanup_storage_version_id IS NULL)) OR ((status = 'completed'::text) AND (completed_at IS NOT NULL) AND (became_current IS NOT NULL) AND (failure_code IS NULL) AND (quota_state = ANY (ARRAY['committed'::text, 'decremented'::text])) AND (cleanup_status = 'not_required'::text) AND (cleanup_available_at IS NULL) AND (cleanup_storage_version_id IS NULL)) OR ((status = ANY (ARRAY['failed'::text, 'expired'::text])) AND (completed_at IS NULL) AND (became_current IS NULL) AND (failure_code IS NOT NULL) AND (((quota_state = 'cleanup_held'::text) AND (cleanup_status = ANY (ARRAY['pending'::text, 'claimed'::text]))) OR ((quota_state = 'released'::text) AND (cleanup_status = 'deleted'::text))) AND (cleanup_available_at IS NOT NULL))) AND (((cleanup_status = 'claimed'::text) AND (cleanup_lease_token IS NOT NULL) AND (cleanup_claimed_at IS NOT NULL)) OR ((cleanup_status <> 'claimed'::text) AND (cleanup_lease_token IS NULL) AND (cleanup_claimed_at IS NULL))))),
    CONSTRAINT artifact_uploads_object_key_check CHECK ((object_key ~ '^artifacts/art_[0-9a-f]{32}/aver_[0-9a-f]{32}/[0-9a-f]{48}$'::text)),
    CONSTRAINT artifact_uploads_output_item_kind_check CHECK ((((kind = 'generated'::text) AND (output_item_id IS NOT NULL)) OR ((kind <> 'generated'::text) AND (output_item_id IS NULL)))),
    CONSTRAINT artifact_uploads_quota_reservation_id_check CHECK (((char_length(btrim(quota_reservation_id)) >= 1) AND (char_length(btrim(quota_reservation_id)) <= 255))),
    CONSTRAINT artifact_uploads_quota_state_check CHECK ((quota_state = ANY (ARRAY['reserved'::text, 'cleanup_held'::text, 'committed'::text, 'decremented'::text, 'released'::text]))),
    CONSTRAINT artifact_uploads_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'expired'::text])))
);

CREATE TABLE relay.artifact_versions (
    id text NOT NULL,
    workspace_id text NOT NULL,
    artifact_id text NOT NULL,
    sequence integer NOT NULL,
    object_key text NOT NULL,
    storage_version_id text,
    sha256 text NOT NULL,
    content_md5 text NOT NULL,
    etag text,
    size_bytes bigint NOT NULL,
    mime_type text NOT NULL,
    width integer,
    height integer,
    duration_ms bigint,
    source text NOT NULL,
    source_run_id text,
    parent_version_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    verification_status text NOT NULL,
    verified_at timestamp with time zone,
    failure_code text,
    purge_status text DEFAULT 'not_requested'::text NOT NULL,
    purge_lease_token text,
    purge_started_at timestamp with time zone,
    purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT artifact_versions_content_md5_check CHECK ((content_md5 ~ '^[A-Za-z0-9+/]{22}==$'::text)),
    CONSTRAINT artifact_versions_duration_ms_check CHECK ((duration_ms > 0)),
    CONSTRAINT artifact_versions_etag_check CHECK (((etag IS NULL) OR (((char_length(etag) >= 1) AND (char_length(etag) <= 512)) AND (etag !~* '[a-z][a-z0-9+.-]*://'::text)))),
    CONSTRAINT artifact_versions_failure_code_check CHECK (((failure_code IS NULL) OR (failure_code ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT artifact_versions_generated_source_run_check CHECK ((((source = 'generated'::text) AND (source_run_id IS NOT NULL)) OR (source <> 'generated'::text))),
    CONSTRAINT artifact_versions_height_check CHECK ((height > 0)),
    CONSTRAINT artifact_versions_id_check CHECK ((id ~ '^aver_[0-9a-f]{32}$'::text)),
    CONSTRAINT artifact_versions_metadata_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (NOT relay.jsonb_contains_raw_url(metadata)))),
    CONSTRAINT artifact_versions_mime_type_check CHECK ((((char_length(btrim(mime_type)) >= 1) AND (char_length(btrim(mime_type)) <= 255)) AND (mime_type !~ '[[:cntrl:]]'::text) AND (mime_type !~* '[a-z][a-z0-9+.-]*://'::text))),
    CONSTRAINT artifact_versions_object_key_check CHECK ((object_key ~ '^artifacts/art_[0-9a-f]{32}/aver_[0-9a-f]{32}/[0-9a-f]{48}$'::text)),
    CONSTRAINT artifact_versions_object_key_identity_check CHECK (((split_part(object_key, '/'::text, 2) = artifact_id) AND (split_part(object_key, '/'::text, 3) = id))),
    CONSTRAINT artifact_versions_purge_state_check CHECK ((((purge_status = 'not_requested'::text) AND (purge_lease_token IS NULL) AND (purge_started_at IS NULL) AND (purged_at IS NULL)) OR ((purge_status = 'deleting'::text) AND (purge_lease_token IS NOT NULL) AND (purge_started_at IS NOT NULL) AND (purged_at IS NULL)) OR ((purge_status = 'deleted'::text) AND (purge_lease_token IS NULL) AND (purge_started_at IS NOT NULL) AND (purged_at IS NOT NULL)))),
    CONSTRAINT artifact_versions_purge_status_check CHECK ((purge_status = ANY (ARRAY['not_requested'::text, 'deleting'::text, 'deleted'::text]))),
    CONSTRAINT artifact_versions_restore_parent_check CHECK ((((source = 'restore'::text) AND (parent_version_id IS NOT NULL)) OR (source <> 'restore'::text))),
    CONSTRAINT artifact_versions_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT artifact_versions_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT artifact_versions_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT artifact_versions_source_check CHECK ((source = ANY (ARRAY['upload'::text, 'generated'::text, 'restore'::text]))),
    CONSTRAINT artifact_versions_storage_version_id_check CHECK (((storage_version_id IS NULL) OR (((char_length(storage_version_id) >= 1) AND (char_length(storage_version_id) <= 1024)) AND (storage_version_id !~* '[a-z][a-z0-9+.-]*://'::text)))),
    CONSTRAINT artifact_versions_verification_state_check CHECK ((((verification_status = 'pending'::text) AND (storage_version_id IS NULL) AND (etag IS NULL) AND (verified_at IS NULL) AND (failure_code IS NULL)) OR ((verification_status = ANY (ARRAY['head_verified'::text, 'cryptographically_verified'::text])) AND (verified_at IS NOT NULL) AND (failure_code IS NULL)) OR ((verification_status = 'failed'::text) AND (storage_version_id IS NULL) AND (etag IS NULL) AND (verified_at IS NULL) AND (failure_code IS NOT NULL)))),
    CONSTRAINT artifact_versions_verification_status_check CHECK ((verification_status = ANY (ARRAY['pending'::text, 'head_verified'::text, 'cryptographically_verified'::text, 'failed'::text]))),
    CONSTRAINT artifact_versions_width_check CHECK ((width > 0))
);

CREATE TABLE relay.artifacts (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    media_kind text NOT NULL,
    current_version_id text,
    source_run_id text,
    created_by text NOT NULL,
    retention_policy_id text,
    deleted_at timestamp with time zone,
    purge_after timestamp with time zone,
    purge_status text DEFAULT 'not_requested'::text NOT NULL,
    purge_lease_token text,
    purge_claimed_at timestamp with time zone,
    purge_io_started_at timestamp with time zone,
    purge_attempt_count integer DEFAULT 0 NOT NULL,
    purge_last_error text,
    purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT artifacts_id_check CHECK ((id ~ '^art_[0-9a-f]{32}$'::text)),
    CONSTRAINT artifacts_media_kind_check CHECK ((((char_length(btrim(media_kind)) >= 1) AND (char_length(btrim(media_kind)) <= 64)) AND (media_kind ~ '^[a-z][a-z0-9._-]*$'::text))),
    CONSTRAINT artifacts_name_check CHECK ((((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 255)) AND (name !~ '[[:cntrl:]]'::text) AND (name !~* '[a-z][a-z0-9+.-]*://'::text))),
    CONSTRAINT artifacts_purge_attempt_count_check CHECK ((purge_attempt_count >= 0)),
    CONSTRAINT artifacts_purge_last_error_check CHECK (((purge_last_error IS NULL) OR (((char_length(purge_last_error) >= 1) AND (char_length(purge_last_error) <= 512)) AND (purge_last_error !~ '[[:cntrl:]]'::text) AND (purge_last_error !~* '[a-z][a-z0-9+.-]*://'::text)))),
    CONSTRAINT artifacts_purge_state_check CHECK ((((purge_status = 'not_requested'::text) AND (deleted_at IS NULL) AND (purge_after IS NULL) AND (purge_lease_token IS NULL) AND (purge_claimed_at IS NULL) AND (purge_io_started_at IS NULL) AND (purged_at IS NULL)) OR ((purge_status = 'pending'::text) AND (deleted_at IS NOT NULL) AND (purge_after IS NOT NULL) AND (purge_lease_token IS NULL) AND (purge_claimed_at IS NULL) AND (purge_io_started_at IS NULL) AND (purged_at IS NULL)) OR ((purge_status = 'claimed'::text) AND (deleted_at IS NOT NULL) AND (purge_after IS NOT NULL) AND (purge_lease_token IS NOT NULL) AND (purge_claimed_at IS NOT NULL) AND (purge_io_started_at IS NULL) AND (purged_at IS NULL)) OR ((purge_status = 'deleting_pending'::text) AND (deleted_at IS NOT NULL) AND (purge_after IS NOT NULL) AND (purge_lease_token IS NULL) AND (purge_claimed_at IS NULL) AND (purge_io_started_at IS NOT NULL) AND (purged_at IS NULL)) OR ((purge_status = 'deleting'::text) AND (deleted_at IS NOT NULL) AND (purge_after IS NOT NULL) AND (purge_lease_token IS NOT NULL) AND (purge_claimed_at IS NOT NULL) AND (purge_io_started_at IS NOT NULL) AND (purged_at IS NULL)) OR ((purge_status = 'purged'::text) AND (deleted_at IS NOT NULL) AND (current_version_id IS NULL) AND (purge_lease_token IS NULL) AND (purge_claimed_at IS NULL) AND (purge_io_started_at IS NOT NULL) AND (purged_at IS NOT NULL)))),
    CONSTRAINT artifacts_purge_status_check CHECK ((purge_status = ANY (ARRAY['not_requested'::text, 'pending'::text, 'claimed'::text, 'deleting_pending'::text, 'deleting'::text, 'purged'::text]))),
    CONSTRAINT artifacts_retention_policy_id_check CHECK (((retention_policy_id IS NULL) OR (((char_length(btrim(retention_policy_id)) >= 1) AND (char_length(btrim(retention_policy_id)) <= 255)) AND (retention_policy_id !~ '[[:cntrl:]]'::text) AND (retention_policy_id !~* '[a-z][a-z0-9+.-]*://'::text))))
);

CREATE TABLE relay.audit_event_idempotency (
    scope_hash text NOT NULL,
    idempotency_key_hash text NOT NULL,
    event_fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_event_idempotency_event_fingerprint_check CHECK ((event_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT audit_event_idempotency_idempotency_key_hash_check CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT audit_event_idempotency_scope_hash_check CHECK ((scope_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE relay.audit_events (
    id bigint NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_type text NOT NULL,
    actor_user_id text,
    oauth_client_id text,
    workspace_id text,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    outcome text NOT NULL,
    reason_code text,
    before_snapshot jsonb,
    after_snapshot jsonb,
    request_id text,
    trace_id text,
    ip_hash_or_policy_value text,
    user_agent_summary text,
    idempotency_key text
);

ALTER TABLE relay.audit_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.audit_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.capacity_policies (
    id bigint NOT NULL,
    scope_type text NOT NULL,
    scope_id text NOT NULL,
    revision integer NOT NULL,
    configuration jsonb NOT NULL,
    effective_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);

ALTER TABLE relay.capacity_policies ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.capacity_policies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.capacity_pools (
    id bigint NOT NULL,
    key text NOT NULL,
    provider_model_id bigint,
    region text,
    execution_class text NOT NULL,
    enabled boolean DEFAULT true NOT NULL
);

ALTER TABLE relay.capacity_pools ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.capacity_pools_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.changelog_items (
    id bigint NOT NULL,
    release_id bigint NOT NULL,
    revision integer NOT NULL,
    category text NOT NULL,
    area text,
    title text NOT NULL,
    description text NOT NULL,
    sort_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT changelog_items_category_check CHECK ((category = ANY (ARRAY['added'::text, 'improved'::text, 'fixed'::text, 'security'::text, 'breaking'::text]))),
    CONSTRAINT changelog_items_sort_order_check CHECK ((sort_order >= 0))
);

ALTER TABLE relay.changelog_items ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.changelog_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.changelog_publication_events (
    id bigint NOT NULL,
    release_id bigint NOT NULL,
    revision integer NOT NULL,
    action text NOT NULL,
    superseded_revision integer,
    actor_user_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    request_id text,
    trace_id text,
    CONSTRAINT changelog_publication_events_action_check CHECK ((action = ANY (ARRAY['publish'::text, 'supersede'::text, 'unpublish'::text])))
);

ALTER TABLE relay.changelog_publication_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.changelog_publication_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.changelog_releases (
    id bigint NOT NULL,
    version text NOT NULL,
    slug text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    latest_revision integer NOT NULL,
    published_revision integer,
    first_published_at timestamp with time zone,
    last_published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT changelog_releases_latest_revision_check CHECK ((latest_revision > 0)),
    CONSTRAINT changelog_releases_publication_state_check CHECK ((((status = 'draft'::text) AND (published_revision IS NULL) AND (first_published_at IS NULL) AND (last_published_at IS NULL)) OR ((status = ANY (ARRAY['published'::text, 'archived'::text])) AND (published_revision IS NOT NULL) AND (first_published_at IS NOT NULL) AND (last_published_at IS NOT NULL) AND (first_published_at <= last_published_at) AND (published_revision <= latest_revision)))),
    CONSTRAINT changelog_releases_published_revision_check CHECK ((published_revision > 0)),
    CONSTRAINT changelog_releases_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text])))
);

ALTER TABLE relay.changelog_releases ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.changelog_releases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.changelog_revisions (
    release_id bigint NOT NULL,
    revision integer NOT NULL,
    version text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    summary text,
    git_tag text,
    commit_sha text,
    released_at timestamp with time zone,
    snapshot jsonb NOT NULL,
    content_sha256 text NOT NULL,
    changed_by text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT changelog_revisions_content_sha256_check CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT changelog_revisions_revision_check CHECK ((revision > 0)),
    CONSTRAINT changelog_revisions_snapshot_check CHECK ((jsonb_typeof(snapshot) = 'object'::text))
);

CREATE TABLE relay.entitlement_grants (
    id text NOT NULL,
    workspace_id text NOT NULL,
    entitlement_key text NOT NULL,
    grant_kind text NOT NULL,
    capability_enabled boolean,
    limit_amount numeric(38,9),
    unit text,
    period text,
    source_kind text NOT NULL,
    source_reference text,
    subscription_snapshot_id text,
    effective_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entitlement_grants_check CHECK (((expires_at IS NULL) OR (expires_at > effective_at))),
    CONSTRAINT entitlement_grants_check1 CHECK (((revoked_at IS NULL) OR (revoked_at >= created_at))),
    CONSTRAINT entitlement_grants_check2 CHECK ((((source_kind = 'subscription'::text) AND (subscription_snapshot_id IS NOT NULL)) OR ((source_kind <> 'subscription'::text) AND (subscription_snapshot_id IS NULL)))),
    CONSTRAINT entitlement_grants_check3 CHECK ((((grant_kind = 'capability'::text) AND (capability_enabled = true) AND (limit_amount IS NULL) AND (unit IS NULL) AND (period IS NULL)) OR ((grant_kind = 'limit'::text) AND (capability_enabled IS NULL) AND ((limit_amount IS NULL) OR (limit_amount >= (0)::numeric)) AND (unit IS NOT NULL) AND (period IS NOT NULL)))),
    CONSTRAINT entitlement_grants_grant_kind_check CHECK ((grant_kind = ANY (ARRAY['capability'::text, 'limit'::text]))),
    CONSTRAINT entitlement_grants_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT entitlement_grants_period_check CHECK ((period = ANY (ARRAY['calendar_day'::text, 'calendar_month'::text, 'lifetime'::text]))),
    CONSTRAINT entitlement_grants_source_kind_check CHECK ((source_kind = ANY (ARRAY['manual'::text, 'subscription'::text, 'system'::text])))
);

CREATE TABLE relay.execution_capacity_leases (
    id bigint NOT NULL,
    job_id bigint NOT NULL,
    lease_epoch bigint NOT NULL,
    tool_id text NOT NULL,
    workspace_id text NOT NULL,
    capacity_pool_id bigint,
    units numeric NOT NULL,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    released_at timestamp with time zone,
    policy_revision integer,
    redis_lease_id text,
    redis_scope_keys jsonb,
    lease_owner text,
    CONSTRAINT execution_capacity_leases_scope_keys_check CHECK (((redis_scope_keys IS NULL) OR (jsonb_typeof(redis_scope_keys) = 'array'::text)))
);

ALTER TABLE relay.execution_capacity_leases ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.execution_capacity_leases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.execution_jobs (
    id bigint NOT NULL,
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    tool_version_id text NOT NULL,
    capacity_pool_id bigint,
    status text NOT NULL,
    scheduling_class text NOT NULL,
    scheduling_policy_version integer NOT NULL,
    estimated_cost_units numeric DEFAULT 1 NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    eligible_at timestamp with time zone DEFAULT now() NOT NULL,
    admission_deadline_at timestamp with time zone,
    attempt_deadline_at timestamp with time zone,
    run_deadline_at timestamp with time zone,
    dispatch_generation integer DEFAULT 0 NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    deferral_count integer DEFAULT 0 NOT NULL,
    lease_epoch bigint DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    capacity_lease_id bigint,
    capacity_policy_revision integer,
    cancel_requested_at timestamp with time zone,
    terminal_at timestamp with time zone,
    state_version bigint DEFAULT 0 NOT NULL,
    fifo_sequence bigint NOT NULL,
    scheduler_ticket_token text,
    CONSTRAINT execution_jobs_fifo_sequence_check CHECK (((fifo_sequence > 0) AND (fifo_sequence <= '9007199254740991'::bigint))),
    CONSTRAINT execution_jobs_lifecycle_counts_nonnegative_check CHECK (((dispatch_generation >= 0) AND (attempt_count >= 0) AND (deferral_count >= 0))),
    CONSTRAINT execution_jobs_scheduler_cost_check CHECK (((estimated_cost_units > (0)::numeric) AND (estimated_cost_units <= (10000)::numeric))),
    CONSTRAINT execution_jobs_scheduler_ticket_token_check CHECK (((scheduler_ticket_token IS NULL) OR ((char_length(scheduler_ticket_token) >= 16) AND (char_length(scheduler_ticket_token) <= 256)))),
    CONSTRAINT execution_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancel_requested'::text, 'cancelled'::text])))
);

CREATE SEQUENCE relay.execution_jobs_fifo_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE relay.execution_jobs_fifo_sequence_seq OWNED BY relay.execution_jobs.fifo_sequence;

ALTER TABLE relay.execution_jobs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.execution_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.governance_operation_idempotency (
    operation text NOT NULL,
    operator_user_id text NOT NULL,
    idempotency_key_hash text NOT NULL,
    request_fingerprint text NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governance_operation_idempotency_idempotency_key_hash_check CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT governance_operation_idempotency_operation_check CHECK ((operation = ANY (ARRAY['changelog.create'::text, 'changelog.revise'::text, 'changelog.publish'::text, 'changelog.unpublish'::text, 'legal_document.create'::text, 'legal_document.revise'::text, 'legal_document.publish'::text, 'legal_document.unpublish'::text, 'capacity_policy.revise'::text]))),
    CONSTRAINT governance_operation_idempotency_request_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT governance_operation_idempotency_response_check CHECK ((jsonb_typeof(response) = 'object'::text))
);

CREATE TABLE relay.idempotency_records (
    id bigint NOT NULL,
    workspace_id text NOT NULL,
    idempotency_key text NOT NULL,
    canonical_payload_hash text NOT NULL,
    run_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE relay.idempotency_records ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.idempotency_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.job_attempts (
    id bigint NOT NULL,
    job_id bigint NOT NULL,
    attempt_number integer NOT NULL,
    lease_epoch bigint NOT NULL,
    submission_state text NOT NULL,
    provider_idempotency_key text,
    provider_operation_id text,
    routing_decision_id bigint,
    actual_model_version text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    heartbeat_at timestamp with time zone,
    finished_at timestamp with time zone,
    outcome text,
    retry_classification text,
    sanitized_error text
);

ALTER TABLE relay.job_attempts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.job_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.legal_acceptances (
    id bigint NOT NULL,
    accepted_by_user_id text NOT NULL,
    workspace_id text,
    acceptance_scope text NOT NULL,
    legal_document_id bigint NOT NULL,
    document_type text NOT NULL,
    version text NOT NULL,
    revision integer NOT NULL,
    content_sha256 text NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text,
    user_agent text,
    CONSTRAINT legal_acceptances_acceptance_scope_check CHECK ((acceptance_scope = ANY (ARRAY['user'::text, 'workspace'::text]))),
    CONSTRAINT legal_acceptances_content_sha256_check CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT legal_acceptances_scope_subject_check CHECK ((((acceptance_scope = 'user'::text) AND (workspace_id IS NULL)) OR ((acceptance_scope = 'workspace'::text) AND (workspace_id IS NOT NULL))))
);

ALTER TABLE relay.legal_acceptances ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.legal_acceptances_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.legal_document_publication_events (
    id bigint NOT NULL,
    document_type text NOT NULL,
    document_id bigint NOT NULL,
    action text NOT NULL,
    superseded_document_id bigint,
    actor_user_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    request_id text,
    trace_id text,
    CONSTRAINT legal_document_publication_events_action_check CHECK ((action = ANY (ARRAY['publish'::text, 'supersede'::text, 'unpublish'::text])))
);

ALTER TABLE relay.legal_document_publication_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.legal_document_publication_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.legal_documents (
    id bigint NOT NULL,
    document_type text NOT NULL,
    version text NOT NULL,
    revision integer NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    canonical_url text NOT NULL,
    content_sha256 text NOT NULL,
    requires_acceptance boolean NOT NULL,
    acceptance_scope text NOT NULL,
    record_sha256 text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT legal_documents_acceptance_scope_check CHECK ((acceptance_scope = ANY (ARRAY['user'::text, 'workspace'::text]))),
    CONSTRAINT legal_documents_content_sha256_check CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT legal_documents_record_sha256_check CHECK ((record_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT legal_documents_revision_check CHECK ((revision > 0))
);

ALTER TABLE relay.legal_documents ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.legal_documents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.meter_policies (
    id text NOT NULL,
    policy_key text NOT NULL,
    revision integer NOT NULL,
    document jsonb NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    immutable_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meter_policies_check CHECK (((expires_at IS NULL) OR (expires_at > effective_at))),
    CONSTRAINT meter_policies_document_check CHECK ((jsonb_typeof(document) = 'object'::text)),
    CONSTRAINT meter_policies_immutable_hash_check CHECK ((immutable_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT meter_policies_revision_check CHECK ((revision > 0))
);

CREATE TABLE relay.outbox_events (
    id bigint NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    aggregate_version bigint NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    eligible_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    published_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    failed_at timestamp with time zone,
    deduplication_key text,
    CONSTRAINT outbox_events_attempt_count_nonnegative_check CHECK ((attempt_count >= 0)),
    CONSTRAINT outbox_events_last_error_length_check CHECK (((last_error IS NULL) OR (char_length(last_error) <= 512))),
    CONSTRAINT outbox_events_single_terminal_state_check CHECK (((published_at IS NULL) OR (failed_at IS NULL)))
);

ALTER TABLE relay.outbox_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.outbox_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.output_items (
    id bigint NOT NULL,
    workspace_id text NOT NULL,
    output_set_id text NOT NULL,
    name text NOT NULL,
    ordinal integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    artifact_version_id text,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT output_items_error_code_check CHECK (((error_code IS NULL) OR (error_code ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT output_items_name_check CHECK ((((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 255)) AND (name !~ '[[:cntrl:]]'::text) AND (name !~* '[a-z][a-z0-9+.-]*://'::text))),
    CONSTRAINT output_items_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT output_items_state_check CHECK ((((status = 'pending'::text) AND (artifact_version_id IS NULL) AND (error_code IS NULL) AND (completed_at IS NULL)) OR ((status = 'succeeded'::text) AND (artifact_version_id IS NOT NULL) AND (error_code IS NULL) AND (completed_at IS NOT NULL)) OR ((status = 'failed'::text) AND (artifact_version_id IS NULL) AND (error_code IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT output_items_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text])))
);

ALTER TABLE relay.output_items ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.output_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.output_sets (
    id text NOT NULL,
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    requested_count integer NOT NULL,
    produced_count integer DEFAULT 0 NOT NULL,
    completeness text DEFAULT 'pending'::text NOT NULL,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    finalized_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT output_sets_check CHECK (((produced_count >= 0) AND (produced_count <= requested_count))),
    CONSTRAINT output_sets_completeness_check CHECK ((completeness = ANY (ARRAY['pending'::text, 'complete'::text, 'partial'::text, 'failed'::text]))),
    CONSTRAINT output_sets_finalization_check CHECK ((((completeness = 'pending'::text) AND (finalized_at IS NULL)) OR ((completeness <> 'pending'::text) AND (finalized_at IS NOT NULL)))),
    CONSTRAINT output_sets_id_check CHECK ((id ~ '^outset_[0-9a-f]{32}$'::text)),
    CONSTRAINT output_sets_requested_count_check CHECK ((requested_count > 0)),
    CONSTRAINT output_sets_warnings_check CHECK (((jsonb_typeof(warnings) = 'array'::text) AND (NOT relay.jsonb_contains_raw_url(warnings))))
);

CREATE TABLE relay.personal_workspaces (
    user_id text NOT NULL,
    organization_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE relay.pricing_policies (
    id text NOT NULL,
    policy_key text NOT NULL,
    revision integer NOT NULL,
    document jsonb NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    immutable_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pricing_policies_check CHECK (((expires_at IS NULL) OR (expires_at > effective_at))),
    CONSTRAINT pricing_policies_document_check CHECK ((jsonb_typeof(document) = 'object'::text)),
    CONSTRAINT pricing_policies_immutable_hash_check CHECK ((immutable_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT pricing_policies_revision_check CHECK ((revision > 0))
);

CREATE TABLE relay.privileged_operation_idempotency (
    operation text NOT NULL,
    operator_user_id text NOT NULL,
    idempotency_key_hash text NOT NULL,
    target_user_id text NOT NULL,
    result text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT privileged_operation_idempotency_idempotency_key_hash_check CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT privileged_operation_idempotency_operation_check CHECK ((operation = ANY (ARRAY['bootstrap'::text, 'grant'::text, 'revoke'::text]))),
    CONSTRAINT privileged_operation_idempotency_result_check CHECK ((result = ANY (ARRAY['changed'::text, 'unchanged'::text, 'last_superadmin'::text])))
);

CREATE TABLE relay.provider_cost_events (
    id text NOT NULL,
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    attempt_id bigint,
    provider_model_id bigint NOT NULL,
    actual_model_version text,
    normalized_usage jsonb NOT NULL,
    cost_components jsonb NOT NULL,
    cost_amount numeric(38,9) NOT NULL,
    currency text NOT NULL,
    pricing_policy_id text NOT NULL,
    pricing_policy_key text NOT NULL,
    pricing_policy_revision integer NOT NULL,
    pricing_policy_hash text NOT NULL,
    pricing_policy_snapshot jsonb NOT NULL,
    idempotency_key_hash text NOT NULL,
    request_hash text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_cost_events_cost_amount_check CHECK ((cost_amount >= (0)::numeric)),
    CONSTRAINT provider_cost_events_cost_components_check CHECK ((jsonb_typeof(cost_components) = 'array'::text)),
    CONSTRAINT provider_cost_events_idempotency_key_hash_check CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT provider_cost_events_normalized_usage_check CHECK ((jsonb_typeof(normalized_usage) = 'object'::text)),
    CONSTRAINT provider_cost_events_pricing_policy_hash_check CHECK ((pricing_policy_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT provider_cost_events_pricing_policy_snapshot_check CHECK ((jsonb_typeof(pricing_policy_snapshot) = 'object'::text)),
    CONSTRAINT provider_cost_events_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE relay.provider_models (
    id bigint NOT NULL,
    provider_id bigint NOT NULL,
    key text NOT NULL,
    display_name text NOT NULL,
    capability_schema jsonb,
    pricing_policy_id text,
    lifecycle text NOT NULL,
    region_constraints jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_models_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['draft'::text, 'internal'::text, 'published'::text, 'deprecated'::text, 'retired'::text, 'disabled'::text])))
);

ALTER TABLE relay.provider_models ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.provider_models_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.providers (
    id bigint NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    lifecycle text NOT NULL,
    configuration_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT providers_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['draft'::text, 'internal'::text, 'published'::text, 'deprecated'::text, 'retired'::text, 'disabled'::text])))
);

ALTER TABLE relay.providers ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.providers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.routing_decisions (
    id bigint NOT NULL,
    tool_run_id text NOT NULL,
    routing_policy_id bigint,
    routing_policy_revision integer,
    selected_binding_id bigint NOT NULL,
    provider_id bigint NOT NULL,
    provider_model_id bigint NOT NULL,
    requested_model_version text,
    fallback_used boolean DEFAULT false NOT NULL,
    fallback_reason text,
    selected_at timestamp with time zone DEFAULT now() NOT NULL,
    tool_id text NOT NULL,
    tool_version_id text NOT NULL,
    tool_version_immutable_hash text NOT NULL,
    handler_key text NOT NULL,
    input_schema_version integer NOT NULL,
    handler_version text NOT NULL,
    capacity_pool_id bigint NOT NULL,
    routing_order integer NOT NULL,
    routing_policy_immutable_hash text,
    CONSTRAINT routing_decisions_fallback_metadata_check CHECK (((fallback_used AND (fallback_reason IS NOT NULL)) OR ((NOT fallback_used) AND (fallback_reason IS NULL)))),
    CONSTRAINT routing_decisions_handler_version_check CHECK ((char_length(handler_version) > 0)),
    CONSTRAINT routing_decisions_input_schema_version_check CHECK ((input_schema_version > 0))
);

ALTER TABLE relay.routing_decisions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.routing_decisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.routing_policies (
    id bigint NOT NULL,
    revision integer NOT NULL,
    policy jsonb NOT NULL,
    effective_at timestamp with time zone DEFAULT now() NOT NULL,
    immutable_hash text NOT NULL,
    CONSTRAINT routing_policies_document_check CHECK (((jsonb_typeof(policy) = 'object'::text) AND ((NOT (policy ? 'fallback'::text)) OR ((jsonb_typeof((policy -> 'fallback'::text)) = 'object'::text) AND ((NOT ((policy -> 'fallback'::text) ? 'mode'::text)) OR (COALESCE((policy #>> '{fallback,mode}'::text[]), ''::text) = ANY (ARRAY['none'::text, 'ordered'::text]))))))),
    CONSTRAINT routing_policies_immutable_hash_length_check CHECK ((char_length(immutable_hash) = 64))
);

ALTER TABLE relay.routing_policies ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.routing_policies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.scheduler_classes (
    class_key text NOT NULL,
    weight numeric NOT NULL,
    max_share numeric,
    enabled boolean DEFAULT true NOT NULL,
    policy_version integer NOT NULL,
    CONSTRAINT scheduler_classes_check CHECK ((((class_key = 'internal'::text) AND (max_share IS NOT NULL)) OR ((class_key <> 'internal'::text) AND (max_share IS NULL)))),
    CONSTRAINT scheduler_classes_class_key_check CHECK ((class_key = ANY (ARRAY['standard'::text, 'paid'::text, 'enterprise'::text, 'internal'::text]))),
    CONSTRAINT scheduler_classes_max_share_check CHECK (((max_share IS NULL) OR ((max_share > (0)::numeric) AND (max_share < (1)::numeric)))),
    CONSTRAINT scheduler_classes_policy_version_check CHECK ((policy_version > 0)),
    CONSTRAINT scheduler_classes_weight_check CHECK ((weight > (0)::numeric))
);

CREATE TABLE relay.share_links (
    id text NOT NULL,
    workspace_id text NOT NULL,
    artifact_id text NOT NULL,
    artifact_version_id text,
    token_hash text NOT NULL,
    follow_current boolean NOT NULL,
    expires_at timestamp with time zone,
    max_resolutions integer,
    resolution_count integer DEFAULT 0 NOT NULL,
    require_auth boolean DEFAULT false NOT NULL,
    content_disposition text NOT NULL,
    revoked_at timestamp with time zone,
    last_resolved_at timestamp with time zone,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT share_links_check CHECK (((resolution_count >= 0) AND ((max_resolutions IS NULL) OR (resolution_count <= max_resolutions)))),
    CONSTRAINT share_links_content_disposition_check CHECK ((content_disposition = ANY (ARRAY['attachment'::text, 'inline'::text]))),
    CONSTRAINT share_links_expiry_check CHECK (((expires_at IS NULL) OR (expires_at > created_at))),
    CONSTRAINT share_links_id_check CHECK ((id ~ '^share_[0-9a-f]{32}$'::text)),
    CONSTRAINT share_links_max_resolutions_check CHECK ((max_resolutions > 0)),
    CONSTRAINT share_links_resolution_state_check CHECK ((((resolution_count = 0) AND (last_resolved_at IS NULL)) OR ((resolution_count > 0) AND (last_resolved_at IS NOT NULL) AND (last_resolved_at >= created_at)))),
    CONSTRAINT share_links_revocation_time_check CHECK (((revoked_at IS NULL) OR (revoked_at >= created_at))),
    CONSTRAINT share_links_target_check CHECK (((follow_current AND (artifact_version_id IS NULL)) OR ((NOT follow_current) AND (artifact_version_id IS NOT NULL)))),
    CONSTRAINT share_links_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE relay.subscription_snapshots (
    id text NOT NULL,
    workspace_id text NOT NULL,
    source_key text NOT NULL,
    subscription_key text NOT NULL,
    revision integer NOT NULL,
    state text NOT NULL,
    catalog_item_key text,
    catalog_revision integer,
    snapshot jsonb NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    immutable_hash text NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_snapshots_check CHECK (((expires_at IS NULL) OR (expires_at > effective_at))),
    CONSTRAINT subscription_snapshots_check1 CHECK ((((catalog_item_key IS NULL) AND (catalog_revision IS NULL)) OR ((catalog_item_key IS NOT NULL) AND (catalog_revision > 0)))),
    CONSTRAINT subscription_snapshots_immutable_hash_check CHECK ((immutable_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT subscription_snapshots_revision_check CHECK ((revision > 0)),
    CONSTRAINT subscription_snapshots_snapshot_check CHECK ((jsonb_typeof(snapshot) = 'object'::text))
);

CREATE TABLE relay.system_role_assignments (
    id bigint NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL,
    granted_by text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_by text,
    revoked_at timestamp with time zone,
    CONSTRAINT system_role_assignments_role_check CHECK ((role = 'superadmin'::text))
);

ALTER TABLE relay.system_role_assignments ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.system_role_assignments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.tool_provider_bindings (
    id bigint NOT NULL,
    tool_version_id text NOT NULL,
    provider_model_id bigint NOT NULL,
    capacity_pool_id bigint NOT NULL,
    routing_order integer NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    routing_policy_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE relay.tool_provider_bindings ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.tool_provider_bindings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.tool_queue_counters (
    tool_id text NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    running_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tool_queue_counters_nonnegative_check CHECK (((queued_count >= 0) AND (running_count >= 0)))
);

CREATE TABLE relay.tool_runs (
    id text NOT NULL,
    workspace_id text NOT NULL,
    tool_version_id text NOT NULL,
    status text NOT NULL,
    result_completeness text,
    input jsonb NOT NULL,
    output_set_id text,
    reservation_id text,
    idempotency_record_id bigint,
    created_by text NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    terminal_at timestamp with time zone,
    CONSTRAINT tool_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancel_requested'::text, 'cancelled'::text])))
);

CREATE TABLE relay.tool_versions (
    id text NOT NULL,
    tool_id text NOT NULL,
    version integer NOT NULL,
    input_schema jsonb NOT NULL,
    output_schema jsonb NOT NULL,
    handler_key text NOT NULL,
    execution_mode text NOT NULL,
    max_duration_seconds integer NOT NULL,
    meter_policy_id text,
    entitlement_key text,
    compatibility_metadata jsonb,
    published_at timestamp with time zone,
    deprecated_at timestamp with time zone,
    retired_at timestamp with time zone,
    immutable_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    input_schema_version integer DEFAULT 1 NOT NULL,
    handler_version text DEFAULT '1'::text NOT NULL,
    CONSTRAINT tool_versions_handler_version_check CHECK ((char_length(handler_version) > 0)),
    CONSTRAINT tool_versions_input_schema_version_check CHECK ((input_schema_version > 0))
);

CREATE TABLE relay.tools (
    id text NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    category text,
    summary text,
    lifecycle text NOT NULL,
    active_version_id text,
    visibility text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    readiness_critical boolean DEFAULT false NOT NULL,
    CONSTRAINT tools_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['draft'::text, 'internal'::text, 'published'::text, 'deprecated'::text, 'retired'::text, 'disabled'::text]))),
    CONSTRAINT tools_serving_lifecycle_has_active_version_check CHECK (((lifecycle <> ALL (ARRAY['published'::text, 'deprecated'::text])) OR (active_version_id IS NOT NULL)))
);

CREATE TABLE relay.usage_adjustments (
    id text NOT NULL,
    workspace_id text NOT NULL,
    usage_event_id text NOT NULL,
    adjusted_by_user_id text NOT NULL,
    bucket_id bigint NOT NULL,
    metric_key text NOT NULL,
    unit text NOT NULL,
    quantity_delta numeric(38,9) NOT NULL,
    reason text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    meter_policy_id text NOT NULL,
    meter_policy_key text NOT NULL,
    meter_policy_revision integer NOT NULL,
    meter_policy_hash text NOT NULL,
    meter_policy_snapshot jsonb NOT NULL,
    entitlement_snapshot jsonb NOT NULL,
    idempotency_key_hash text NOT NULL,
    request_hash text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_adjustments_entitlement_snapshot_check CHECK ((jsonb_typeof(entitlement_snapshot) = 'object'::text)),
    CONSTRAINT usage_adjustments_idempotency_key_hash_check CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT usage_adjustments_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT usage_adjustments_meter_policy_hash_check CHECK ((meter_policy_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT usage_adjustments_meter_policy_snapshot_check CHECK ((jsonb_typeof(meter_policy_snapshot) = 'object'::text)),
    CONSTRAINT usage_adjustments_quantity_delta_check CHECK ((quantity_delta <> (0)::numeric)),
    CONSTRAINT usage_adjustments_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE relay.usage_buckets (
    id bigint NOT NULL,
    workspace_id text NOT NULL,
    metric_key text NOT NULL,
    unit text NOT NULL,
    period text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    consumed_amount numeric(38,9) DEFAULT 0 NOT NULL,
    reserved_amount numeric(38,9) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_buckets_check CHECK ((period_end > period_start)),
    CONSTRAINT usage_buckets_consumed_amount_check CHECK ((consumed_amount >= (0)::numeric)),
    CONSTRAINT usage_buckets_period_check CHECK ((period = ANY (ARRAY['calendar_day'::text, 'calendar_month'::text, 'lifetime'::text]))),
    CONSTRAINT usage_buckets_reserved_amount_check CHECK ((reserved_amount >= (0)::numeric))
);

ALTER TABLE relay.usage_buckets ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relay.usage_buckets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE relay.usage_events (
    id text NOT NULL,
    workspace_id text NOT NULL,
    reservation_id text NOT NULL,
    bucket_id bigint NOT NULL,
    metric_key text NOT NULL,
    unit text NOT NULL,
    quantity numeric(38,9) NOT NULL,
    outcome text NOT NULL,
    meter_policy_id text NOT NULL,
    meter_policy_key text NOT NULL,
    meter_policy_revision integer NOT NULL,
    meter_policy_hash text NOT NULL,
    meter_policy_snapshot jsonb NOT NULL,
    entitlement_snapshot jsonb NOT NULL,
    idempotency_key_hash text NOT NULL,
    request_hash text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_events_entitlement_snapshot_check CHECK ((jsonb_typeof(entitlement_snapshot) = 'object'::text)),
    CONSTRAINT usage_events_idempotency_key_hash_check CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT usage_events_meter_policy_hash_check CHECK ((meter_policy_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT usage_events_meter_policy_snapshot_check CHECK ((jsonb_typeof(meter_policy_snapshot) = 'object'::text)),
    CONSTRAINT usage_events_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'partial_output'::text, 'validation_rejected'::text, 'safety_rejected'::text, 'provider_failure'::text, 'cancelled'::text, 'timed_out'::text, 'storage_failure'::text]))),
    CONSTRAINT usage_events_quantity_check CHECK ((quantity >= (0)::numeric)),
    CONSTRAINT usage_events_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE relay.usage_reservations (
    id text NOT NULL,
    workspace_id text NOT NULL,
    bucket_id bigint NOT NULL,
    tool_version_id text NOT NULL,
    provider_model_id bigint NOT NULL,
    capability_key text NOT NULL,
    metric_key text NOT NULL,
    unit text NOT NULL,
    period text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    estimate_measures jsonb NOT NULL,
    estimated_minimum numeric(38,9) NOT NULL,
    estimated_expected numeric(38,9) NOT NULL,
    estimated_maximum numeric(38,9) NOT NULL,
    reserved_amount numeric(38,9) NOT NULL,
    committed_amount numeric(38,9) DEFAULT 0 NOT NULL,
    released_amount numeric(38,9) DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    meter_policy_id text NOT NULL,
    meter_policy_key text NOT NULL,
    meter_policy_revision integer NOT NULL,
    meter_policy_hash text NOT NULL,
    meter_policy_snapshot jsonb NOT NULL,
    entitlement_snapshot jsonb NOT NULL,
    limit_amount_snapshot numeric(38,9),
    reserve_idempotency_key_hash text NOT NULL,
    reserve_request_hash text NOT NULL,
    finalization_operation text,
    finalization_outcome text,
    finalization_idempotency_key_hash text,
    finalization_request_hash text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    CONSTRAINT usage_reservations_check CHECK ((period_end > period_start)),
    CONSTRAINT usage_reservations_check1 CHECK (((expires_at > created_at) AND (expires_at <= period_end))),
    CONSTRAINT usage_reservations_check2 CHECK (((estimated_minimum <= estimated_expected) AND (estimated_expected <= estimated_maximum) AND (estimated_maximum <= reserved_amount))),
    CONSTRAINT usage_reservations_check3 CHECK ((((status = 'active'::text) AND (committed_amount = (0)::numeric) AND (released_amount = (0)::numeric) AND (finalization_operation IS NULL) AND (finalization_outcome IS NULL) AND (finalization_idempotency_key_hash IS NULL) AND (finalization_request_hash IS NULL) AND (finalized_at IS NULL)) OR ((status = 'committed'::text) AND (finalization_operation = 'commit'::text) AND (finalization_outcome IS NOT NULL) AND (finalization_idempotency_key_hash IS NOT NULL) AND (finalization_request_hash IS NOT NULL) AND (finalized_at IS NOT NULL) AND (committed_amount <= reserved_amount) AND ((committed_amount + released_amount) = reserved_amount)) OR ((status = 'released'::text) AND (finalization_operation = 'release'::text) AND (finalization_outcome IS NOT NULL) AND (finalization_idempotency_key_hash IS NOT NULL) AND (finalization_request_hash IS NOT NULL) AND (finalized_at IS NOT NULL) AND (committed_amount = (0)::numeric) AND (released_amount = reserved_amount)) OR ((status = 'expired'::text) AND (finalization_operation = 'expire'::text) AND (finalization_outcome IS NOT NULL) AND (finalization_idempotency_key_hash IS NOT NULL) AND (finalization_request_hash IS NOT NULL) AND (finalized_at IS NOT NULL) AND (committed_amount = (0)::numeric) AND (released_amount = reserved_amount)))),
    CONSTRAINT usage_reservations_committed_amount_check CHECK ((committed_amount >= (0)::numeric)),
    CONSTRAINT usage_reservations_entitlement_snapshot_check CHECK ((jsonb_typeof(entitlement_snapshot) = 'object'::text)),
    CONSTRAINT usage_reservations_estimate_measures_check CHECK ((jsonb_typeof(estimate_measures) = 'object'::text)),
    CONSTRAINT usage_reservations_estimated_expected_check CHECK ((estimated_expected >= (0)::numeric)),
    CONSTRAINT usage_reservations_estimated_maximum_check CHECK ((estimated_maximum >= (0)::numeric)),
    CONSTRAINT usage_reservations_estimated_minimum_check CHECK ((estimated_minimum >= (0)::numeric)),
    CONSTRAINT usage_reservations_finalization_idempotency_key_hash_check CHECK ((finalization_idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT usage_reservations_finalization_operation_check CHECK ((finalization_operation = ANY (ARRAY['commit'::text, 'release'::text, 'expire'::text]))),
    CONSTRAINT usage_reservations_finalization_request_hash_check CHECK ((finalization_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT usage_reservations_limit_amount_snapshot_check CHECK (((limit_amount_snapshot IS NULL) OR (limit_amount_snapshot >= (0)::numeric))),
    CONSTRAINT usage_reservations_meter_policy_hash_check CHECK ((meter_policy_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT usage_reservations_meter_policy_snapshot_check CHECK ((jsonb_typeof(meter_policy_snapshot) = 'object'::text)),
    CONSTRAINT usage_reservations_period_check CHECK ((period = ANY (ARRAY['calendar_day'::text, 'calendar_month'::text, 'lifetime'::text]))),
    CONSTRAINT usage_reservations_released_amount_check CHECK ((released_amount >= (0)::numeric)),
    CONSTRAINT usage_reservations_reserve_idempotency_key_hash_check CHECK ((reserve_idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT usage_reservations_reserve_request_hash_check CHECK ((reserve_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT usage_reservations_reserved_amount_check CHECK ((reserved_amount >= (0)::numeric)),
    CONSTRAINT usage_reservations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'committed'::text, 'released'::text, 'expired'::text])))
);

CREATE TABLE relay.workspace_queue_counters (
    workspace_id text NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    running_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_queue_counters_nonnegative_check CHECK (((queued_count >= 0) AND (running_count >= 0)))
);

CREATE TABLE relay.workspace_scheduling_profiles (
    workspace_id text NOT NULL,
    class_key text NOT NULL,
    policy_version integer NOT NULL,
    granted_by text,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT workspace_scheduling_profiles_check CHECK (((expires_at IS NULL) OR (expires_at > granted_at))),
    CONSTRAINT workspace_scheduling_profiles_policy_version_check CHECK ((policy_version > 0))
);

CREATE TABLE relay.workspace_tool_queue_counters (
    workspace_id text NOT NULL,
    tool_id text NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    running_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_tool_queue_counters_nonnegative_check CHECK (((queued_count >= 0) AND (running_count >= 0)))
);

ALTER TABLE ONLY relay.execution_jobs ALTER COLUMN fifo_sequence SET DEFAULT nextval('relay.execution_jobs_fifo_sequence_seq'::regclass);

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.invitation
    ADD CONSTRAINT invitation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.jwks
    ADD CONSTRAINT jwks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_token_key" UNIQUE (token);

ALTER TABLE ONLY auth."oauthClient"
    ADD CONSTRAINT "oauthClient_clientId_key" UNIQUE ("clientId");

ALTER TABLE ONLY auth."oauthClient"
    ADD CONSTRAINT "oauthClient_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthClientAssertion"
    ADD CONSTRAINT "oauthClientAssertion_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthConsent"
    ADD CONSTRAINT "oauthConsent_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_token_key" UNIQUE (token);

ALTER TABLE ONLY auth."oauthResource"
    ADD CONSTRAINT "oauthResource_identifier_key" UNIQUE (identifier);

ALTER TABLE ONLY auth."oauthResource"
    ADD CONSTRAINT "oauthResource_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth.member
    ADD CONSTRAINT member_organization_id_user_id_key UNIQUE ("organizationId", "userId");

ALTER TABLE ONLY auth.member
    ADD CONSTRAINT member_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.organization
    ADD CONSTRAINT organization_slug_key UNIQUE (slug);

ALTER TABLE ONLY auth."rateLimit"
    ADD CONSTRAINT "rateLimit_key_key" UNIQUE (key);

ALTER TABLE ONLY auth."rateLimit"
    ADD CONSTRAINT "rateLimit_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_token_key UNIQUE (token);

ALTER TABLE ONLY auth."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);

ALTER TABLE ONLY auth."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.artifact_uploads
    ADD CONSTRAINT artifact_uploads_artifact_version_id_key UNIQUE (artifact_version_id);

ALTER TABLE ONLY relay.artifact_uploads
    ADD CONSTRAINT artifact_uploads_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY relay.artifact_uploads
    ADD CONSTRAINT artifact_uploads_output_item_id_key UNIQUE (output_item_id);

ALTER TABLE ONLY relay.artifact_uploads
    ADD CONSTRAINT artifact_uploads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.artifact_versions
    ADD CONSTRAINT artifact_versions_artifact_id_sequence_key UNIQUE (artifact_id, sequence);

ALTER TABLE ONLY relay.artifact_versions
    ADD CONSTRAINT artifact_versions_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY relay.artifact_versions
    ADD CONSTRAINT artifact_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.artifact_versions
    ADD CONSTRAINT artifact_versions_workspace_id_artifact_id_id_key UNIQUE (workspace_id, artifact_id, id);

ALTER TABLE ONLY relay.artifact_versions
    ADD CONSTRAINT artifact_versions_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY relay.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.artifacts
    ADD CONSTRAINT artifacts_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY relay.audit_event_idempotency
    ADD CONSTRAINT audit_event_idempotency_pkey PRIMARY KEY (scope_hash, idempotency_key_hash);

ALTER TABLE ONLY relay.audit_events
    ADD CONSTRAINT audit_events_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY relay.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.capacity_policies
    ADD CONSTRAINT capacity_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.capacity_policies
    ADD CONSTRAINT capacity_policies_scope_type_scope_id_revision_key UNIQUE (scope_type, scope_id, revision);

ALTER TABLE ONLY relay.capacity_pools
    ADD CONSTRAINT capacity_pools_key_key UNIQUE (key);

ALTER TABLE ONLY relay.capacity_pools
    ADD CONSTRAINT capacity_pools_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.changelog_items
    ADD CONSTRAINT changelog_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.changelog_items
    ADD CONSTRAINT changelog_items_release_id_revision_sort_order_key UNIQUE (release_id, revision, sort_order);

ALTER TABLE ONLY relay.changelog_publication_events
    ADD CONSTRAINT changelog_publication_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.changelog_releases
    ADD CONSTRAINT changelog_releases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.changelog_releases
    ADD CONSTRAINT changelog_releases_slug_key UNIQUE (slug);

ALTER TABLE ONLY relay.changelog_releases
    ADD CONSTRAINT changelog_releases_version_key UNIQUE (version);

ALTER TABLE ONLY relay.changelog_revisions
    ADD CONSTRAINT changelog_revisions_pkey PRIMARY KEY (release_id, revision);

ALTER TABLE ONLY relay.entitlement_grants
    ADD CONSTRAINT entitlement_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.execution_capacity_leases
    ADD CONSTRAINT execution_capacity_leases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.execution_jobs
    ADD CONSTRAINT execution_jobs_fifo_sequence_key UNIQUE (fifo_sequence);

ALTER TABLE ONLY relay.execution_jobs
    ADD CONSTRAINT execution_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.governance_operation_idempotency
    ADD CONSTRAINT governance_operation_idempotency_pkey PRIMARY KEY (operation, operator_user_id, idempotency_key_hash);

ALTER TABLE ONLY relay.idempotency_records
    ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.idempotency_records
    ADD CONSTRAINT idempotency_records_workspace_id_idempotency_key_key UNIQUE (workspace_id, idempotency_key);

ALTER TABLE ONLY relay.job_attempts
    ADD CONSTRAINT job_attempts_job_id_attempt_number_key UNIQUE (job_id, attempt_number);

ALTER TABLE ONLY relay.job_attempts
    ADD CONSTRAINT job_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.legal_acceptances
    ADD CONSTRAINT legal_acceptances_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.legal_document_publication_events
    ADD CONSTRAINT legal_document_publication_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.legal_documents
    ADD CONSTRAINT legal_documents_document_type_version_revision_key UNIQUE (document_type, version, revision);

ALTER TABLE ONLY relay.legal_documents
    ADD CONSTRAINT legal_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.meter_policies
    ADD CONSTRAINT meter_policies_id_revision_immutable_hash_key UNIQUE (id, revision, immutable_hash);

ALTER TABLE ONLY relay.meter_policies
    ADD CONSTRAINT meter_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.meter_policies
    ADD CONSTRAINT meter_policies_policy_key_revision_key UNIQUE (policy_key, revision);

ALTER TABLE ONLY relay.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.output_items
    ADD CONSTRAINT output_items_output_set_id_ordinal_key UNIQUE (output_set_id, ordinal);

ALTER TABLE ONLY relay.output_items
    ADD CONSTRAINT output_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.output_items
    ADD CONSTRAINT output_items_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY relay.output_sets
    ADD CONSTRAINT output_sets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.output_sets
    ADD CONSTRAINT output_sets_run_id_key UNIQUE (run_id);

ALTER TABLE ONLY relay.output_sets
    ADD CONSTRAINT output_sets_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY relay.output_sets
    ADD CONSTRAINT output_sets_workspace_id_run_id_id_key UNIQUE (workspace_id, run_id, id);

ALTER TABLE ONLY relay.personal_workspaces
    ADD CONSTRAINT personal_workspaces_organization_id_key UNIQUE (organization_id);

ALTER TABLE ONLY relay.personal_workspaces
    ADD CONSTRAINT personal_workspaces_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY relay.pricing_policies
    ADD CONSTRAINT pricing_policies_id_revision_immutable_hash_key UNIQUE (id, revision, immutable_hash);

ALTER TABLE ONLY relay.pricing_policies
    ADD CONSTRAINT pricing_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.pricing_policies
    ADD CONSTRAINT pricing_policies_policy_key_revision_key UNIQUE (policy_key, revision);

ALTER TABLE ONLY relay.privileged_operation_idempotency
    ADD CONSTRAINT privileged_operation_idempotency_pkey PRIMARY KEY (operation, operator_user_id, idempotency_key_hash);

ALTER TABLE ONLY relay.provider_cost_events
    ADD CONSTRAINT provider_cost_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.provider_cost_events
    ADD CONSTRAINT provider_cost_events_workspace_id_idempotency_key_hash_key UNIQUE (workspace_id, idempotency_key_hash);

ALTER TABLE ONLY relay.provider_models
    ADD CONSTRAINT provider_models_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.provider_models
    ADD CONSTRAINT provider_models_provider_id_id_key UNIQUE (provider_id, id);

ALTER TABLE ONLY relay.provider_models
    ADD CONSTRAINT provider_models_provider_id_key_key UNIQUE (provider_id, key);

ALTER TABLE ONLY relay.providers
    ADD CONSTRAINT providers_key_key UNIQUE (key);

ALTER TABLE ONLY relay.providers
    ADD CONSTRAINT providers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_run_provider_model_key UNIQUE (tool_run_id, provider_model_id);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_tool_run_id_key UNIQUE (tool_run_id);

ALTER TABLE ONLY relay.routing_policies
    ADD CONSTRAINT routing_policies_id_revision_hash_key UNIQUE (id, revision, immutable_hash);

ALTER TABLE ONLY relay.routing_policies
    ADD CONSTRAINT routing_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.routing_policies
    ADD CONSTRAINT routing_policies_revision_key UNIQUE (revision);

ALTER TABLE ONLY relay.scheduler_classes
    ADD CONSTRAINT scheduler_classes_class_key_policy_version_key UNIQUE (class_key, policy_version);

ALTER TABLE ONLY relay.scheduler_classes
    ADD CONSTRAINT scheduler_classes_pkey PRIMARY KEY (class_key);

ALTER TABLE ONLY relay.share_links
    ADD CONSTRAINT share_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.share_links
    ADD CONSTRAINT share_links_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY relay.share_links
    ADD CONSTRAINT share_links_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY relay.subscription_snapshots
    ADD CONSTRAINT subscription_snapshots_id_workspace_id_key UNIQUE (id, workspace_id);

ALTER TABLE ONLY relay.subscription_snapshots
    ADD CONSTRAINT subscription_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.subscription_snapshots
    ADD CONSTRAINT subscription_snapshots_workspace_id_source_key_subscription_key UNIQUE (workspace_id, source_key, subscription_key, revision);

ALTER TABLE ONLY relay.system_role_assignments
    ADD CONSTRAINT system_role_assignments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.tool_provider_bindings
    ADD CONSTRAINT tool_provider_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.tool_provider_bindings
    ADD CONSTRAINT tool_provider_bindings_route_snapshot_key UNIQUE (id, tool_version_id, provider_model_id, capacity_pool_id, routing_order);

ALTER TABLE ONLY relay.tool_provider_bindings
    ADD CONSTRAINT tool_provider_bindings_tool_version_id_provider_model_id_key UNIQUE (tool_version_id, provider_model_id);

ALTER TABLE ONLY relay.tool_provider_bindings
    ADD CONSTRAINT tool_provider_bindings_tool_version_routing_order_key UNIQUE (tool_version_id, routing_order);

ALTER TABLE ONLY relay.tool_queue_counters
    ADD CONSTRAINT tool_queue_counters_pkey PRIMARY KEY (tool_id);

ALTER TABLE ONLY relay.tool_runs
    ADD CONSTRAINT tool_runs_id_tool_version_id_key UNIQUE (id, tool_version_id);

ALTER TABLE ONLY relay.tool_runs
    ADD CONSTRAINT tool_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.tool_runs
    ADD CONSTRAINT tool_runs_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY relay.tool_versions
    ADD CONSTRAINT tool_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.tool_versions
    ADD CONSTRAINT tool_versions_tool_id_id_key UNIQUE (tool_id, id);

ALTER TABLE ONLY relay.tool_versions
    ADD CONSTRAINT tool_versions_tool_id_version_key UNIQUE (tool_id, version);

ALTER TABLE ONLY relay.tools
    ADD CONSTRAINT tools_key_key UNIQUE (key);

ALTER TABLE ONLY relay.tools
    ADD CONSTRAINT tools_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.usage_adjustments
    ADD CONSTRAINT usage_adjustments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.usage_adjustments
    ADD CONSTRAINT usage_adjustments_workspace_id_adjusted_by_user_id_idempote_key UNIQUE (workspace_id, adjusted_by_user_id, idempotency_key_hash);

ALTER TABLE ONLY relay.usage_buckets
    ADD CONSTRAINT usage_buckets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.usage_buckets
    ADD CONSTRAINT usage_buckets_reservation_dimensions_key UNIQUE (workspace_id, id, metric_key, unit, period, period_start, period_end);

ALTER TABLE ONLY relay.usage_buckets
    ADD CONSTRAINT usage_buckets_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY relay.usage_buckets
    ADD CONSTRAINT usage_buckets_workspace_id_metric_key_unit_period_period_st_key UNIQUE (workspace_id, metric_key, unit, period, period_start, period_end);

ALTER TABLE ONLY relay.usage_events
    ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.usage_events
    ADD CONSTRAINT usage_events_reservation_id_key UNIQUE (reservation_id);

ALTER TABLE ONLY relay.usage_events
    ADD CONSTRAINT usage_events_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY relay.usage_events
    ADD CONSTRAINT usage_events_workspace_id_idempotency_key_hash_key UNIQUE (workspace_id, idempotency_key_hash);

ALTER TABLE ONLY relay.usage_reservations
    ADD CONSTRAINT usage_reservations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.usage_reservations
    ADD CONSTRAINT usage_reservations_run_context_key UNIQUE (id, workspace_id, tool_version_id);

ALTER TABLE ONLY relay.usage_reservations
    ADD CONSTRAINT usage_reservations_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY relay.usage_reservations
    ADD CONSTRAINT usage_reservations_workspace_id_reserve_idempotency_key_has_key UNIQUE (workspace_id, reserve_idempotency_key_hash);

ALTER TABLE ONLY relay.workspace_queue_counters
    ADD CONSTRAINT workspace_queue_counters_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY relay.workspace_scheduling_profiles
    ADD CONSTRAINT workspace_scheduling_profiles_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY relay.workspace_tool_queue_counters
    ADD CONSTRAINT workspace_tool_queue_counters_pkey PRIMARY KEY (workspace_id, tool_id);

CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON auth.account USING btree (issuer, "accountId");

CREATE INDEX "account_userId_idx" ON auth.account USING btree ("userId");

CREATE INDEX invitation_email_idx ON auth.invitation USING btree (email);

CREATE INDEX "invitation_organizationId_idx" ON auth.invitation USING btree ("organizationId");

CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON auth."oauthAccessToken" USING btree ("authorizationCodeId");

CREATE INDEX "oauthAccessToken_clientId_idx" ON auth."oauthAccessToken" USING btree ("clientId");

CREATE INDEX "oauthAccessToken_refreshId_idx" ON auth."oauthAccessToken" USING btree ("refreshId");

CREATE INDEX "oauthAccessToken_sessionId_idx" ON auth."oauthAccessToken" USING btree ("sessionId");

CREATE INDEX "oauthAccessToken_userId_idx" ON auth."oauthAccessToken" USING btree ("userId");

CREATE INDEX "oauthClient_userId_idx" ON auth."oauthClient" USING btree ("userId");

CREATE INDEX "oauthClientResource_clientId_idx" ON auth."oauthClientResource" USING btree ("clientId");

CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON auth."oauthClientResource" USING btree ("clientId", "resourceId");

CREATE INDEX "oauthClientResource_resourceId_idx" ON auth."oauthClientResource" USING btree ("resourceId");

CREATE INDEX "oauthConsent_clientId_idx" ON auth."oauthConsent" USING btree ("clientId");

CREATE INDEX "oauthConsent_userId_idx" ON auth."oauthConsent" USING btree ("userId");

CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON auth."oauthRefreshToken" USING btree ("authorizationCodeId");

CREATE INDEX "oauthRefreshToken_clientId_idx" ON auth."oauthRefreshToken" USING btree ("clientId");

CREATE INDEX "oauthRefreshToken_sessionId_idx" ON auth."oauthRefreshToken" USING btree ("sessionId");

CREATE INDEX "oauthRefreshToken_userId_idx" ON auth."oauthRefreshToken" USING btree ("userId");

CREATE INDEX "member_organizationId_idx" ON auth.member USING btree ("organizationId");

CREATE INDEX "member_userId_idx" ON auth.member USING btree ("userId");

CREATE INDEX "session_userId_idx" ON auth.session USING btree ("userId");

CREATE INDEX verification_identifier_idx ON auth.verification USING btree (identifier);

CREATE INDEX artifact_uploads_cleanup_idx ON relay.artifact_uploads USING btree (cleanup_available_at, created_at) WHERE (cleanup_status = 'pending'::text);

CREATE INDEX artifact_uploads_expiry_idx ON relay.artifact_uploads USING btree (expires_at) WHERE (status = 'pending'::text);

CREATE INDEX artifact_versions_artifact_sequence_idx ON relay.artifact_versions USING btree (artifact_id, sequence DESC);

CREATE INDEX artifact_versions_source_run_idx ON relay.artifact_versions USING btree (workspace_id, source_run_id) WHERE (source_run_id IS NOT NULL);

CREATE INDEX artifacts_purge_due_idx ON relay.artifacts USING btree (purge_status, purge_after, purge_claimed_at) WHERE (purge_status = ANY (ARRAY['pending'::text, 'claimed'::text, 'deleting_pending'::text, 'deleting'::text]));

CREATE INDEX artifacts_workspace_active_idx ON relay.artifacts USING btree (workspace_id, created_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX artifacts_workspace_created_idx ON relay.artifacts USING btree (workspace_id, created_at DESC);

CREATE INDEX audit_events_action_idx ON relay.audit_events USING btree (action);

CREATE INDEX audit_events_actor_user_id_idx ON relay.audit_events USING btree (actor_user_id);

CREATE INDEX audit_events_occurred_at_idx ON relay.audit_events USING btree (occurred_at);

CREATE INDEX audit_events_workspace_id_idx ON relay.audit_events USING btree (workspace_id);

CREATE INDEX capacity_policies_scope_idx ON relay.capacity_policies USING btree (scope_type, scope_id, effective_at);

CREATE INDEX changelog_public_released_order_idx ON relay.changelog_revisions USING btree (released_at DESC, release_id DESC);

CREATE INDEX changelog_publication_events_release_idx ON relay.changelog_publication_events USING btree (release_id, id DESC);

CREATE INDEX entitlement_grants_active_lookup_idx ON relay.entitlement_grants USING btree (workspace_id, entitlement_key, grant_kind, effective_at);

CREATE INDEX entitlement_grants_subscription_snapshot_idx ON relay.entitlement_grants USING btree (subscription_snapshot_id) WHERE (subscription_snapshot_id IS NOT NULL);

CREATE INDEX execution_capacity_leases_active_idx ON relay.execution_capacity_leases USING btree (capacity_pool_id) WHERE (released_at IS NULL);

CREATE UNIQUE INDEX execution_capacity_leases_job_epoch_idx ON relay.execution_capacity_leases USING btree (job_id, lease_epoch);

CREATE INDEX execution_capacity_leases_job_id_idx ON relay.execution_capacity_leases USING btree (job_id);

CREATE UNIQUE INDEX execution_capacity_leases_redis_lease_id_idx ON relay.execution_capacity_leases USING btree (redis_lease_id) WHERE (redis_lease_id IS NOT NULL);

CREATE INDEX execution_jobs_capacity_pool_id_idx ON relay.execution_jobs USING btree (capacity_pool_id);

CREATE INDEX execution_jobs_run_id_idx ON relay.execution_jobs USING btree (run_id);

CREATE INDEX execution_jobs_scheduler_backlog_idx ON relay.execution_jobs USING btree (eligible_at, fifo_sequence) WHERE (status = 'queued'::text);

CREATE INDEX execution_jobs_status_idx ON relay.execution_jobs USING btree (status);

CREATE UNIQUE INDEX job_attempts_job_epoch_idx ON relay.job_attempts USING btree (job_id, lease_epoch);

CREATE INDEX job_attempts_job_id_idx ON relay.job_attempts USING btree (job_id);

CREATE INDEX legal_acceptances_user_subject_idx ON relay.legal_acceptances USING btree (accepted_by_user_id, legal_document_id);

CREATE UNIQUE INDEX legal_acceptances_user_subject_uidx ON relay.legal_acceptances USING btree (accepted_by_user_id, legal_document_id) WHERE (acceptance_scope = 'user'::text);

CREATE INDEX legal_acceptances_workspace_subject_idx ON relay.legal_acceptances USING btree (workspace_id, legal_document_id);

CREATE UNIQUE INDEX legal_acceptances_workspace_subject_uidx ON relay.legal_acceptances USING btree (workspace_id, legal_document_id) WHERE (acceptance_scope = 'workspace'::text);

CREATE INDEX legal_document_publication_current_idx ON relay.legal_document_publication_events USING btree (document_type, id DESC);

CREATE INDEX legal_document_publication_document_idx ON relay.legal_document_publication_events USING btree (document_id, id DESC);

CREATE INDEX outbox_events_aggregate_idx ON relay.outbox_events USING btree (aggregate_type, aggregate_id);

CREATE UNIQUE INDEX outbox_events_deduplication_key_idx ON relay.outbox_events USING btree (deduplication_key) WHERE (deduplication_key IS NOT NULL);

CREATE INDEX outbox_events_retryable_idx ON relay.outbox_events USING btree (eligible_at) WHERE ((published_at IS NULL) AND (failed_at IS NULL));

CREATE INDEX outbox_events_unpublished_idx ON relay.outbox_events USING btree (eligible_at) WHERE (published_at IS NULL);

CREATE UNIQUE INDEX output_items_artifact_version_idx ON relay.output_items USING btree (artifact_version_id) WHERE (artifact_version_id IS NOT NULL);

CREATE INDEX provider_cost_events_run_idx ON relay.provider_cost_events USING btree (run_id, occurred_at);

CREATE INDEX provider_cost_events_workspace_occurred_idx ON relay.provider_cost_events USING btree (workspace_id, occurred_at DESC);

CREATE INDEX provider_models_provider_id_idx ON relay.provider_models USING btree (provider_id);

CREATE INDEX share_links_workspace_created_idx ON relay.share_links USING btree (workspace_id, created_at DESC);

CREATE UNIQUE INDEX system_role_assignments_one_active_per_user_idx ON relay.system_role_assignments USING btree (user_id) WHERE (revoked_at IS NULL);

CREATE INDEX tool_provider_bindings_tool_version_id_idx ON relay.tool_provider_bindings USING btree (tool_version_id);

CREATE UNIQUE INDEX tool_runs_reservation_id_idx ON relay.tool_runs USING btree (reservation_id) WHERE (reservation_id IS NOT NULL);

CREATE INDEX tool_runs_status_idx ON relay.tool_runs USING btree (status);

CREATE INDEX tool_runs_workspace_id_idx ON relay.tool_runs USING btree (workspace_id, accepted_at);

CREATE INDEX tool_versions_tool_id_idx ON relay.tool_versions USING btree (tool_id);

CREATE INDEX tools_lifecycle_idx ON relay.tools USING btree (lifecycle);

CREATE INDEX usage_adjustments_workspace_occurred_idx ON relay.usage_adjustments USING btree (workspace_id, occurred_at DESC);

CREATE INDEX usage_events_workspace_occurred_idx ON relay.usage_events USING btree (workspace_id, occurred_at DESC);

CREATE INDEX usage_reservations_active_expiry_idx ON relay.usage_reservations USING btree (expires_at, id) WHERE (status = 'active'::text);

CREATE UNIQUE INDEX usage_reservations_finalization_idempotency_idx ON relay.usage_reservations USING btree (workspace_id, finalization_idempotency_key_hash) WHERE (finalization_idempotency_key_hash IS NOT NULL);

CREATE INDEX usage_reservations_workspace_created_idx ON relay.usage_reservations USING btree (workspace_id, created_at DESC);

CREATE INDEX workspace_scheduling_profiles_class_idx ON relay.workspace_scheduling_profiles USING btree (class_key);

CREATE INDEX workspace_scheduling_profiles_expiry_idx ON relay.workspace_scheduling_profiles USING btree (expires_at) WHERE (expires_at IS NOT NULL);

CREATE TRIGGER organization_default_scheduling_profile AFTER INSERT ON auth.organization FOR EACH ROW EXECUTE FUNCTION relay.create_default_workspace_scheduling_profile();

CREATE TRIGGER reject_active_superadmin_user_delete BEFORE DELETE ON auth."user" FOR EACH ROW EXECUTE FUNCTION relay.reject_active_superadmin_user_delete();

CREATE TRIGGER artifact_uploads_valid BEFORE INSERT OR UPDATE ON relay.artifact_uploads FOR EACH ROW EXECUTE FUNCTION relay.validate_artifact_upload();

CREATE TRIGGER artifact_versions_protected BEFORE DELETE OR UPDATE ON relay.artifact_versions FOR EACH ROW EXECUTE FUNCTION relay.protect_artifact_version();

CREATE TRIGGER artifacts_delete_protected BEFORE DELETE ON relay.artifacts FOR EACH ROW EXECUTE FUNCTION relay.reject_artifact_delete();

CREATE TRIGGER artifacts_head_valid BEFORE UPDATE ON relay.artifacts FOR EACH ROW EXECUTE FUNCTION relay.validate_artifact_head();

CREATE TRIGGER capacity_pools_bindings_consistent BEFORE UPDATE OF provider_model_id ON relay.capacity_pools FOR EACH ROW EXECUTE FUNCTION relay.validate_capacity_pool_binding_consistency();

CREATE TRIGGER changelog_items_immutable BEFORE DELETE OR UPDATE ON relay.changelog_items FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_governance_row();

CREATE TRIGGER changelog_publication_events_immutable BEFORE DELETE OR UPDATE ON relay.changelog_publication_events FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_governance_row();

CREATE TRIGGER changelog_releases_no_delete BEFORE DELETE ON relay.changelog_releases FOR EACH ROW EXECUTE FUNCTION relay.reject_changelog_release_delete();

CREATE TRIGGER changelog_revisions_immutable BEFORE DELETE OR UPDATE ON relay.changelog_revisions FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_governance_row();

CREATE TRIGGER entitlement_grants_mutation_guard BEFORE DELETE OR UPDATE ON relay.entitlement_grants FOR EACH ROW EXECUTE FUNCTION relay.enforce_entitlement_grant_mutation();

CREATE TRIGGER execution_jobs_server_owned_scheduling_profile BEFORE INSERT OR UPDATE OF workspace_id, scheduling_class, scheduling_policy_version ON relay.execution_jobs FOR EACH ROW EXECUTE FUNCTION relay.enforce_execution_job_scheduling_profile();

CREATE TRIGGER governance_operation_idempotency_immutable BEFORE DELETE OR UPDATE ON relay.governance_operation_idempotency FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_governance_row();

CREATE TRIGGER legal_acceptances_immutable BEFORE DELETE OR UPDATE ON relay.legal_acceptances FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_governance_row();

CREATE TRIGGER legal_document_publication_events_immutable BEFORE DELETE OR UPDATE ON relay.legal_document_publication_events FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_governance_row();

CREATE TRIGGER legal_documents_immutable BEFORE DELETE OR UPDATE ON relay.legal_documents FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_governance_row();

CREATE TRIGGER meter_policies_canonical_hash BEFORE INSERT ON relay.meter_policies FOR EACH ROW EXECUTE FUNCTION relay.set_meter_policy_immutable_hash();

CREATE TRIGGER meter_policies_immutable BEFORE DELETE OR UPDATE ON relay.meter_policies FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_metering_record();

CREATE TRIGGER output_items_protected BEFORE UPDATE ON relay.output_items FOR EACH ROW EXECUTE FUNCTION relay.protect_output_item();

CREATE TRIGGER output_sets_protected BEFORE UPDATE ON relay.output_sets FOR EACH ROW EXECUTE FUNCTION relay.protect_output_set();

CREATE TRIGGER pricing_policies_canonical_hash BEFORE INSERT ON relay.pricing_policies FOR EACH ROW EXECUTE FUNCTION relay.set_pricing_policy_immutable_hash();

CREATE TRIGGER pricing_policies_immutable BEFORE DELETE OR UPDATE ON relay.pricing_policies FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_metering_record();

CREATE TRIGGER provider_cost_events_immutable BEFORE DELETE OR UPDATE ON relay.provider_cost_events FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_metering_record();

CREATE TRIGGER provider_cost_events_snapshot_valid BEFORE INSERT ON relay.provider_cost_events FOR EACH ROW EXECUTE FUNCTION relay.validate_provider_cost_snapshot();

CREATE TRIGGER routing_decisions_consistent BEFORE INSERT ON relay.routing_decisions FOR EACH ROW EXECUTE FUNCTION relay.validate_routing_decision_consistency();

CREATE TRIGGER routing_decisions_immutable BEFORE DELETE OR UPDATE ON relay.routing_decisions FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_routing_record();

CREATE TRIGGER routing_decisions_reservation_valid BEFORE INSERT OR UPDATE ON relay.routing_decisions FOR EACH ROW EXECUTE FUNCTION relay.validate_routing_decision_reservation();

CREATE TRIGGER routing_policies_canonical_hash BEFORE INSERT OR UPDATE ON relay.routing_policies FOR EACH ROW EXECUTE FUNCTION relay.set_routing_policy_immutable_hash();

CREATE TRIGGER routing_policies_immutable BEFORE DELETE OR UPDATE ON relay.routing_policies FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_routing_record();

CREATE TRIGGER scheduler_classes_revision_guard BEFORE DELETE OR UPDATE ON relay.scheduler_classes FOR EACH ROW EXECUTE FUNCTION relay.enforce_scheduler_class_revision();

CREATE TRIGGER share_links_policy_protected BEFORE DELETE OR UPDATE ON relay.share_links FOR EACH ROW EXECUTE FUNCTION relay.protect_share_link_policy();

CREATE TRIGGER subscription_snapshots_canonical_hash BEFORE INSERT ON relay.subscription_snapshots FOR EACH ROW EXECUTE FUNCTION relay.set_subscription_snapshot_immutable_hash();

CREATE TRIGGER subscription_snapshots_immutable BEFORE DELETE OR UPDATE ON relay.subscription_snapshots FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_metering_record();

CREATE TRIGGER system_role_assignments_immutable_except_revoke BEFORE UPDATE ON relay.system_role_assignments FOR EACH ROW EXECUTE FUNCTION relay.reject_system_role_assignment_mutation();

CREATE TRIGGER tool_provider_bindings_consistent BEFORE INSERT OR UPDATE ON relay.tool_provider_bindings FOR EACH ROW EXECUTE FUNCTION relay.validate_tool_provider_binding_consistency();

CREATE TRIGGER tool_provider_bindings_structure_immutable BEFORE UPDATE ON relay.tool_provider_bindings FOR EACH ROW EXECUTE FUNCTION relay.reject_tool_provider_binding_structure_mutation();

CREATE CONSTRAINT TRIGGER tool_runs_complete_metering_route AFTER INSERT OR UPDATE ON relay.tool_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION relay.require_complete_tool_run_metering_route();

CREATE TRIGGER tool_runs_reservation_context_valid BEFORE INSERT OR UPDATE OF workspace_id, tool_version_id, reservation_id ON relay.tool_runs FOR EACH ROW EXECUTE FUNCTION relay.validate_tool_run_reservation_context();

CREATE TRIGGER tool_versions_contract_hash_valid BEFORE INSERT OR UPDATE ON relay.tool_versions FOR EACH ROW EXECUTE FUNCTION relay.maintain_tool_version_immutable_hash();

CREATE TRIGGER tool_versions_immutable_after_publish BEFORE UPDATE ON relay.tool_versions FOR EACH ROW EXECUTE FUNCTION relay.reject_tool_version_mutation_after_publish();

CREATE TRIGGER tool_versions_immutable_delete_after_publish BEFORE DELETE ON relay.tool_versions FOR EACH ROW EXECUTE FUNCTION relay.reject_tool_version_deletion_after_publish();

CREATE TRIGGER tools_active_version_consistent BEFORE INSERT OR UPDATE OF id, active_version_id, lifecycle ON relay.tools FOR EACH ROW EXECUTE FUNCTION relay.validate_tool_active_version();

CREATE TRIGGER usage_adjustments_immutable BEFORE DELETE OR UPDATE ON relay.usage_adjustments FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_metering_record();

CREATE TRIGGER usage_adjustments_snapshot_valid BEFORE INSERT ON relay.usage_adjustments FOR EACH ROW EXECUTE FUNCTION relay.validate_usage_adjustment_snapshot();

CREATE TRIGGER usage_events_immutable BEFORE DELETE OR UPDATE ON relay.usage_events FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_metering_record();

CREATE TRIGGER usage_events_snapshot_valid BEFORE INSERT ON relay.usage_events FOR EACH ROW EXECUTE FUNCTION relay.validate_usage_event_snapshot();

CREATE TRIGGER usage_reservations_context_valid BEFORE INSERT ON relay.usage_reservations FOR EACH ROW EXECUTE FUNCTION relay.validate_usage_reservation_context();

CREATE TRIGGER usage_reservations_transition_guard BEFORE DELETE OR UPDATE ON relay.usage_reservations FOR EACH ROW EXECUTE FUNCTION relay.enforce_usage_reservation_transition();

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth.invitation
    ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth.invitation
    ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES auth.organization(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth.member
    ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES auth.organization(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth.member
    ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId") ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES auth."oauthRefreshToken"(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES auth.session(id) ON DELETE SET NULL;

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthClient"
    ADD CONSTRAINT "oauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId") ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES auth."oauthResource"(identifier) ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthConsent"
    ADD CONSTRAINT "oauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId") ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthConsent"
    ADD CONSTRAINT "oauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId") ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES auth.session(id) ON DELETE SET NULL;

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY relay.artifact_uploads
    ADD CONSTRAINT artifact_uploads_artifact_fkey FOREIGN KEY (workspace_id, artifact_id) REFERENCES relay.artifacts(workspace_id, id);

ALTER TABLE ONLY relay.artifact_uploads
    ADD CONSTRAINT artifact_uploads_output_item_fkey FOREIGN KEY (workspace_id, output_item_id) REFERENCES relay.output_items(workspace_id, id);

ALTER TABLE ONLY relay.artifact_uploads
    ADD CONSTRAINT artifact_uploads_previous_version_fkey FOREIGN KEY (workspace_id, artifact_id, expected_previous_version_id) REFERENCES relay.artifact_versions(workspace_id, artifact_id, id);

ALTER TABLE ONLY relay.artifact_uploads
    ADD CONSTRAINT artifact_uploads_version_fkey FOREIGN KEY (workspace_id, artifact_id, artifact_version_id) REFERENCES relay.artifact_versions(workspace_id, artifact_id, id);

ALTER TABLE ONLY relay.artifact_versions
    ADD CONSTRAINT artifact_versions_artifact_fkey FOREIGN KEY (workspace_id, artifact_id) REFERENCES relay.artifacts(workspace_id, id);

ALTER TABLE ONLY relay.artifact_versions
    ADD CONSTRAINT artifact_versions_parent_fkey FOREIGN KEY (workspace_id, artifact_id, parent_version_id) REFERENCES relay.artifact_versions(workspace_id, artifact_id, id);

ALTER TABLE ONLY relay.artifact_versions
    ADD CONSTRAINT artifact_versions_source_run_fkey FOREIGN KEY (workspace_id, source_run_id) REFERENCES relay.tool_runs(workspace_id, id);

ALTER TABLE ONLY relay.artifacts
    ADD CONSTRAINT artifacts_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY relay.artifacts
    ADD CONSTRAINT artifacts_current_version_fkey FOREIGN KEY (workspace_id, id, current_version_id) REFERENCES relay.artifact_versions(workspace_id, artifact_id, id);

ALTER TABLE ONLY relay.artifacts
    ADD CONSTRAINT artifacts_source_run_fkey FOREIGN KEY (workspace_id, source_run_id) REFERENCES relay.tool_runs(workspace_id, id);

ALTER TABLE ONLY relay.artifacts
    ADD CONSTRAINT artifacts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.audit_events
    ADD CONSTRAINT audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth."user"(id) ON DELETE SET NULL;

ALTER TABLE ONLY relay.capacity_pools
    ADD CONSTRAINT capacity_pools_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES relay.provider_models(id);

ALTER TABLE ONLY relay.changelog_items
    ADD CONSTRAINT changelog_items_release_id_revision_fkey FOREIGN KEY (release_id, revision) REFERENCES relay.changelog_revisions(release_id, revision);

ALTER TABLE ONLY relay.changelog_publication_events
    ADD CONSTRAINT changelog_publication_events_release_id_revision_fkey FOREIGN KEY (release_id, revision) REFERENCES relay.changelog_revisions(release_id, revision);

ALTER TABLE ONLY relay.changelog_publication_events
    ADD CONSTRAINT changelog_publication_events_release_id_superseded_revisio_fkey FOREIGN KEY (release_id, superseded_revision) REFERENCES relay.changelog_revisions(release_id, revision);

ALTER TABLE ONLY relay.changelog_releases
    ADD CONSTRAINT changelog_releases_latest_revision_fkey FOREIGN KEY (id, latest_revision) REFERENCES relay.changelog_revisions(release_id, revision) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY relay.changelog_releases
    ADD CONSTRAINT changelog_releases_published_revision_fkey FOREIGN KEY (id, published_revision) REFERENCES relay.changelog_revisions(release_id, revision) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY relay.changelog_revisions
    ADD CONSTRAINT changelog_revisions_release_id_fkey FOREIGN KEY (release_id) REFERENCES relay.changelog_releases(id);

ALTER TABLE ONLY relay.entitlement_grants
    ADD CONSTRAINT entitlement_grants_subscription_snapshot_id_workspace_id_fkey FOREIGN KEY (subscription_snapshot_id, workspace_id) REFERENCES relay.subscription_snapshots(id, workspace_id);

ALTER TABLE ONLY relay.entitlement_grants
    ADD CONSTRAINT entitlement_grants_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.execution_capacity_leases
    ADD CONSTRAINT execution_capacity_leases_capacity_pool_id_fkey FOREIGN KEY (capacity_pool_id) REFERENCES relay.capacity_pools(id);

ALTER TABLE ONLY relay.execution_capacity_leases
    ADD CONSTRAINT execution_capacity_leases_job_id_fkey FOREIGN KEY (job_id) REFERENCES relay.execution_jobs(id);

ALTER TABLE ONLY relay.execution_capacity_leases
    ADD CONSTRAINT execution_capacity_leases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.execution_jobs
    ADD CONSTRAINT execution_jobs_capacity_lease_id_fkey FOREIGN KEY (capacity_lease_id) REFERENCES relay.execution_capacity_leases(id);

ALTER TABLE ONLY relay.execution_jobs
    ADD CONSTRAINT execution_jobs_capacity_pool_id_fkey FOREIGN KEY (capacity_pool_id) REFERENCES relay.capacity_pools(id);

ALTER TABLE ONLY relay.execution_jobs
    ADD CONSTRAINT execution_jobs_run_id_fkey FOREIGN KEY (run_id) REFERENCES relay.tool_runs(id);

ALTER TABLE ONLY relay.execution_jobs
    ADD CONSTRAINT execution_jobs_scheduling_class_fkey FOREIGN KEY (scheduling_class) REFERENCES relay.scheduler_classes(class_key);

ALTER TABLE ONLY relay.execution_jobs
    ADD CONSTRAINT execution_jobs_tool_version_id_fkey FOREIGN KEY (tool_version_id) REFERENCES relay.tool_versions(id);

ALTER TABLE ONLY relay.execution_jobs
    ADD CONSTRAINT execution_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.idempotency_records
    ADD CONSTRAINT idempotency_records_run_id_fkey FOREIGN KEY (run_id) REFERENCES relay.tool_runs(id);

ALTER TABLE ONLY relay.idempotency_records
    ADD CONSTRAINT idempotency_records_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.job_attempts
    ADD CONSTRAINT job_attempts_job_id_fkey FOREIGN KEY (job_id) REFERENCES relay.execution_jobs(id);

ALTER TABLE ONLY relay.job_attempts
    ADD CONSTRAINT job_attempts_routing_decision_id_fkey FOREIGN KEY (routing_decision_id) REFERENCES relay.routing_decisions(id);

ALTER TABLE ONLY relay.legal_acceptances
    ADD CONSTRAINT legal_acceptances_legal_document_id_fkey FOREIGN KEY (legal_document_id) REFERENCES relay.legal_documents(id);

ALTER TABLE ONLY relay.legal_document_publication_events
    ADD CONSTRAINT legal_document_publication_events_document_id_fkey FOREIGN KEY (document_id) REFERENCES relay.legal_documents(id);

ALTER TABLE ONLY relay.legal_document_publication_events
    ADD CONSTRAINT legal_document_publication_events_superseded_document_id_fkey FOREIGN KEY (superseded_document_id) REFERENCES relay.legal_documents(id);

ALTER TABLE ONLY relay.output_items
    ADD CONSTRAINT output_items_artifact_version_fkey FOREIGN KEY (workspace_id, artifact_version_id) REFERENCES relay.artifact_versions(workspace_id, id);

ALTER TABLE ONLY relay.output_items
    ADD CONSTRAINT output_items_output_set_fkey FOREIGN KEY (workspace_id, output_set_id) REFERENCES relay.output_sets(workspace_id, id);

ALTER TABLE ONLY relay.output_sets
    ADD CONSTRAINT output_sets_run_fkey FOREIGN KEY (workspace_id, run_id) REFERENCES relay.tool_runs(workspace_id, id);

ALTER TABLE ONLY relay.personal_workspaces
    ADD CONSTRAINT personal_workspaces_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;

ALTER TABLE ONLY relay.personal_workspaces
    ADD CONSTRAINT personal_workspaces_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY relay.provider_cost_events
    ADD CONSTRAINT provider_cost_events_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES relay.job_attempts(id);

ALTER TABLE ONLY relay.provider_cost_events
    ADD CONSTRAINT provider_cost_events_pricing_policy_id_pricing_policy_revi_fkey FOREIGN KEY (pricing_policy_id, pricing_policy_revision, pricing_policy_hash) REFERENCES relay.pricing_policies(id, revision, immutable_hash);

ALTER TABLE ONLY relay.provider_cost_events
    ADD CONSTRAINT provider_cost_events_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES relay.provider_models(id);

ALTER TABLE ONLY relay.provider_cost_events
    ADD CONSTRAINT provider_cost_events_routing_model_fkey FOREIGN KEY (run_id, provider_model_id) REFERENCES relay.routing_decisions(tool_run_id, provider_model_id);

ALTER TABLE ONLY relay.provider_cost_events
    ADD CONSTRAINT provider_cost_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES relay.tool_runs(id);

ALTER TABLE ONLY relay.provider_cost_events
    ADD CONSTRAINT provider_cost_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.provider_models
    ADD CONSTRAINT provider_models_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES relay.providers(id);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_binding_snapshot_fkey FOREIGN KEY (selected_binding_id, tool_version_id, provider_model_id, capacity_pool_id, routing_order) REFERENCES relay.tool_provider_bindings(id, tool_version_id, provider_model_id, capacity_pool_id, routing_order);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_capacity_pool_id_fkey FOREIGN KEY (capacity_pool_id) REFERENCES relay.capacity_pools(id);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_policy_revision_fkey FOREIGN KEY (routing_policy_id, routing_policy_revision, routing_policy_immutable_hash) REFERENCES relay.routing_policies(id, revision, immutable_hash) MATCH FULL;

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES relay.providers(id);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES relay.provider_models(id);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_provider_model_provider_fkey FOREIGN KEY (provider_id, provider_model_id) REFERENCES relay.provider_models(provider_id, id);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_routing_policy_id_fkey FOREIGN KEY (routing_policy_id) REFERENCES relay.routing_policies(id);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_run_tool_version_fkey FOREIGN KEY (tool_run_id, tool_version_id) REFERENCES relay.tool_runs(id, tool_version_id);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_selected_binding_id_fkey FOREIGN KEY (selected_binding_id) REFERENCES relay.tool_provider_bindings(id);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_tool_run_id_fkey FOREIGN KEY (tool_run_id) REFERENCES relay.tool_runs(id);

ALTER TABLE ONLY relay.routing_decisions
    ADD CONSTRAINT routing_decisions_tool_version_tool_fkey FOREIGN KEY (tool_id, tool_version_id) REFERENCES relay.tool_versions(tool_id, id);

ALTER TABLE ONLY relay.share_links
    ADD CONSTRAINT share_links_artifact_fkey FOREIGN KEY (workspace_id, artifact_id) REFERENCES relay.artifacts(workspace_id, id);

ALTER TABLE ONLY relay.share_links
    ADD CONSTRAINT share_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY relay.share_links
    ADD CONSTRAINT share_links_version_fkey FOREIGN KEY (workspace_id, artifact_id, artifact_version_id) REFERENCES relay.artifact_versions(workspace_id, artifact_id, id);

ALTER TABLE ONLY relay.subscription_snapshots
    ADD CONSTRAINT subscription_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.system_role_assignments
    ADD CONSTRAINT system_role_assignments_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY relay.system_role_assignments
    ADD CONSTRAINT system_role_assignments_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY relay.system_role_assignments
    ADD CONSTRAINT system_role_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY relay.tool_provider_bindings
    ADD CONSTRAINT tool_provider_bindings_capacity_pool_id_fkey FOREIGN KEY (capacity_pool_id) REFERENCES relay.capacity_pools(id);

ALTER TABLE ONLY relay.tool_provider_bindings
    ADD CONSTRAINT tool_provider_bindings_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES relay.provider_models(id);

ALTER TABLE ONLY relay.tool_provider_bindings
    ADD CONSTRAINT tool_provider_bindings_routing_policy_id_fkey FOREIGN KEY (routing_policy_id) REFERENCES relay.routing_policies(id);

ALTER TABLE ONLY relay.tool_provider_bindings
    ADD CONSTRAINT tool_provider_bindings_tool_version_id_fkey FOREIGN KEY (tool_version_id) REFERENCES relay.tool_versions(id);

ALTER TABLE ONLY relay.tool_queue_counters
    ADD CONSTRAINT tool_queue_counters_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES relay.tools(id);

ALTER TABLE ONLY relay.tool_runs
    ADD CONSTRAINT tool_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY relay.tool_runs
    ADD CONSTRAINT tool_runs_output_set_belongs_to_run_fkey FOREIGN KEY (workspace_id, id, output_set_id) REFERENCES relay.output_sets(workspace_id, run_id, id);

ALTER TABLE ONLY relay.tool_runs
    ADD CONSTRAINT tool_runs_reservation_context_fkey FOREIGN KEY (reservation_id, workspace_id, tool_version_id) REFERENCES relay.usage_reservations(id, workspace_id, tool_version_id);

ALTER TABLE ONLY relay.tool_runs
    ADD CONSTRAINT tool_runs_tool_version_id_fkey FOREIGN KEY (tool_version_id) REFERENCES relay.tool_versions(id);

ALTER TABLE ONLY relay.tool_runs
    ADD CONSTRAINT tool_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.tool_versions
    ADD CONSTRAINT tool_versions_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES relay.tools(id);

ALTER TABLE ONLY relay.tools
    ADD CONSTRAINT tools_active_version_belongs_to_tool_fkey FOREIGN KEY (id, active_version_id) REFERENCES relay.tool_versions(tool_id, id);

ALTER TABLE ONLY relay.usage_adjustments
    ADD CONSTRAINT usage_adjustments_adjusted_by_user_id_fkey FOREIGN KEY (adjusted_by_user_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY relay.usage_adjustments
    ADD CONSTRAINT usage_adjustments_meter_policy_id_meter_policy_revision_me_fkey FOREIGN KEY (meter_policy_id, meter_policy_revision, meter_policy_hash) REFERENCES relay.meter_policies(id, revision, immutable_hash);

ALTER TABLE ONLY relay.usage_adjustments
    ADD CONSTRAINT usage_adjustments_workspace_id_bucket_id_fkey FOREIGN KEY (workspace_id, bucket_id) REFERENCES relay.usage_buckets(workspace_id, id);

ALTER TABLE ONLY relay.usage_adjustments
    ADD CONSTRAINT usage_adjustments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.usage_adjustments
    ADD CONSTRAINT usage_adjustments_workspace_id_usage_event_id_fkey FOREIGN KEY (workspace_id, usage_event_id) REFERENCES relay.usage_events(workspace_id, id);

ALTER TABLE ONLY relay.usage_buckets
    ADD CONSTRAINT usage_buckets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.usage_events
    ADD CONSTRAINT usage_events_meter_policy_id_meter_policy_revision_meter_p_fkey FOREIGN KEY (meter_policy_id, meter_policy_revision, meter_policy_hash) REFERENCES relay.meter_policies(id, revision, immutable_hash);

ALTER TABLE ONLY relay.usage_events
    ADD CONSTRAINT usage_events_workspace_id_bucket_id_fkey FOREIGN KEY (workspace_id, bucket_id) REFERENCES relay.usage_buckets(workspace_id, id);

ALTER TABLE ONLY relay.usage_events
    ADD CONSTRAINT usage_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.usage_events
    ADD CONSTRAINT usage_events_workspace_id_reservation_id_fkey FOREIGN KEY (workspace_id, reservation_id) REFERENCES relay.usage_reservations(workspace_id, id);

ALTER TABLE ONLY relay.usage_reservations
    ADD CONSTRAINT usage_reservations_bucket_dimensions_fkey FOREIGN KEY (workspace_id, bucket_id, metric_key, unit, period, period_start, period_end) REFERENCES relay.usage_buckets(workspace_id, id, metric_key, unit, period, period_start, period_end);

ALTER TABLE ONLY relay.usage_reservations
    ADD CONSTRAINT usage_reservations_meter_policy_id_meter_policy_revision_m_fkey FOREIGN KEY (meter_policy_id, meter_policy_revision, meter_policy_hash) REFERENCES relay.meter_policies(id, revision, immutable_hash);

ALTER TABLE ONLY relay.usage_reservations
    ADD CONSTRAINT usage_reservations_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES relay.provider_models(id);

ALTER TABLE ONLY relay.usage_reservations
    ADD CONSTRAINT usage_reservations_tool_version_id_fkey FOREIGN KEY (tool_version_id) REFERENCES relay.tool_versions(id);

ALTER TABLE ONLY relay.usage_reservations
    ADD CONSTRAINT usage_reservations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.workspace_queue_counters
    ADD CONSTRAINT workspace_queue_counters_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

ALTER TABLE ONLY relay.workspace_scheduling_profiles
    ADD CONSTRAINT workspace_scheduling_profiles_class_key_policy_version_fkey FOREIGN KEY (class_key, policy_version) REFERENCES relay.scheduler_classes(class_key, policy_version) ON UPDATE CASCADE;

ALTER TABLE ONLY relay.workspace_scheduling_profiles
    ADD CONSTRAINT workspace_scheduling_profiles_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES auth."user"(id) ON DELETE SET NULL;

ALTER TABLE ONLY relay.workspace_scheduling_profiles
    ADD CONSTRAINT workspace_scheduling_profiles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id) ON DELETE CASCADE;

ALTER TABLE ONLY relay.workspace_tool_queue_counters
    ADD CONSTRAINT workspace_tool_queue_counters_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES relay.tools(id);

ALTER TABLE ONLY relay.workspace_tool_queue_counters
    ADD CONSTRAINT workspace_tool_queue_counters_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id);

INSERT INTO relay.scheduler_classes
  (class_key, weight, max_share, enabled, policy_version)
VALUES
  ('standard', 1, null, true, 1),
  ('paid', 2, null, true, 1),
  ('enterprise', 4, null, true, 1),
  ('internal', 1, 0.10, true, 1);

-- Infrastructure grants broad defaults only so Better Auth can evolve its auth
-- schema. Reset every Relay object before applying the explicit least-privilege
-- ACLs from this baseline.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA relay FROM relay_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA relay FROM relay_app;
GRANT SELECT ON TABLE relay.schema_migrations TO relay_app;

GRANT USAGE ON SCHEMA auth TO relay_app;
GRANT USAGE ON SCHEMA auth TO relay_migrator;

GRANT USAGE ON SCHEMA relay TO relay_app;
GRANT USAGE ON SCHEMA relay TO relay_migrator;

REVOKE ALL ON FUNCTION relay.accept_legal_document(p_session_id text, p_acceptance_scope text, p_workspace_id text, p_document_type text, p_version text, p_revision integer, p_content_sha256 text, p_ip_address text, p_user_agent text, p_request_id text, p_trace_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.accept_legal_document(p_session_id text, p_acceptance_scope text, p_workspace_id text, p_document_type text, p_version text, p_revision integer, p_content_sha256 text, p_ip_address text, p_user_agent text, p_request_id text, p_trace_id text) TO relay_app;

REVOKE ALL ON FUNCTION relay.adjust_customer_usage(p_adjustment_id text, p_operator_session_id text, p_workspace_id text, p_usage_event_id text, p_idempotency_key_hash text, p_request_hash text, p_quantity_delta numeric, p_reason text, p_metadata jsonb, p_request_id text, p_trace_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.adjust_customer_usage(p_adjustment_id text, p_operator_session_id text, p_workspace_id text, p_usage_event_id text, p_idempotency_key_hash text, p_request_hash text, p_quantity_delta numeric, p_reason text, p_metadata jsonb, p_request_id text, p_trace_id text) TO relay_app;

REVOKE ALL ON FUNCTION relay.append_changelog_revision(p_release_id bigint, p_version text, p_slug text, p_title text, p_summary text, p_git_tag text, p_commit_sha text, p_released_at timestamp with time zone, p_items jsonb, p_changed_by text) FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.append_legal_document(p_document_type text, p_version text, p_effective_at timestamp with time zone, p_canonical_url text, p_content_sha256 text, p_requires_acceptance boolean, p_acceptance_scope text, p_created_by text) FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.bootstrap_superadmin(p_target_user_id text, p_idempotency_key_hash text) FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.build_changelog_snapshot(p_version text, p_slug text, p_title text, p_summary text, p_git_tag text, p_commit_sha text, p_released_at timestamp with time zone, p_items jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.complete_governance_mutation(p_operation text, p_operator_user_id text, p_idempotency_key_hash text, p_request_fingerprint text, p_response jsonb, p_action text, p_target_type text, p_target_id text, p_outcome text, p_reason_code text, p_before_snapshot jsonb, p_after_snapshot jsonb, p_request_id text, p_trace_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.create_default_workspace_scheduling_profile() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.current_legal_publications() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.enforce_entitlement_grant_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.enforce_execution_job_scheduling_profile() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.enforce_scheduler_class_revision() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.enforce_usage_reservation_transition() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.get_admin_changelog(p_operator_session_id text, p_release_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.get_admin_changelog(p_operator_session_id text, p_release_id bigint) TO relay_app;

REVOKE ALL ON FUNCTION relay.get_public_changelog(p_slug text) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.get_public_changelog(p_slug text) TO relay_app;

REVOKE ALL ON FUNCTION relay.governance_replay(p_operation text, p_operator_user_id text, p_idempotency_key_hash text, p_request_fingerprint text) FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.grant_superadmin(p_target_user_id text, p_operator_session_id text, p_idempotency_key_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.grant_superadmin(p_target_user_id text, p_operator_session_id text, p_idempotency_key_hash text) TO relay_app;

REVOKE ALL ON FUNCTION relay.is_safe_legal_canonical_url(p_url text) FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.list_admin_changelog(p_operator_session_id text, p_limit integer, p_before_release_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.list_admin_changelog(p_operator_session_id text, p_limit integer, p_before_release_id bigint) TO relay_app;

REVOKE ALL ON FUNCTION relay.list_admin_changelog_revisions(p_operator_session_id text, p_release_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.list_admin_changelog_revisions(p_operator_session_id text, p_release_id bigint) TO relay_app;

REVOKE ALL ON FUNCTION relay.list_admin_legal_documents(p_operator_session_id text, p_document_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.list_admin_legal_documents(p_operator_session_id text, p_document_type text) TO relay_app;

REVOKE ALL ON FUNCTION relay.list_pending_legal_documents(p_session_id text, p_workspace_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.list_pending_legal_documents(p_session_id text, p_workspace_id text) TO relay_app;

REVOKE ALL ON FUNCTION relay.list_public_changelog(p_limit integer, p_cursor_released_at timestamp with time zone, p_cursor_release_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.list_public_changelog(p_limit integer, p_cursor_released_at timestamp with time zone, p_cursor_release_id bigint) TO relay_app;

REVOKE ALL ON FUNCTION relay.list_public_legal_documents() FROM PUBLIC;
GRANT ALL ON FUNCTION relay.list_public_legal_documents() TO relay_app;

REVOKE ALL ON FUNCTION relay.mutate_changelog(p_operation text, p_operator_session_id text, p_idempotency_key_hash text, p_payload jsonb, p_request_id text, p_trace_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.mutate_changelog(p_operation text, p_operator_session_id text, p_idempotency_key_hash text, p_payload jsonb, p_request_id text, p_trace_id text) TO relay_app;

REVOKE ALL ON FUNCTION relay.mutate_legal_document(p_operation text, p_operator_session_id text, p_idempotency_key_hash text, p_payload jsonb, p_request_id text, p_trace_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.mutate_legal_document(p_operation text, p_operator_session_id text, p_idempotency_key_hash text, p_payload jsonb, p_request_id text, p_trace_id text) TO relay_app;

REVOKE ALL ON FUNCTION relay.record_audit_event(p_actor_type text, p_actor_user_id text, p_oauth_client_id text, p_workspace_id text, p_action text, p_target_type text, p_target_id text, p_outcome text, p_reason_code text, p_before_snapshot jsonb, p_after_snapshot jsonb, p_request_id text, p_trace_id text, p_ip_hash_or_policy_value text, p_user_agent_summary text, p_idempotency_scope_hash text, p_idempotency_key_hash text, p_event_fingerprint text) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.record_audit_event(p_actor_type text, p_actor_user_id text, p_oauth_client_id text, p_workspace_id text, p_action text, p_target_type text, p_target_id text, p_outcome text, p_reason_code text, p_before_snapshot jsonb, p_after_snapshot jsonb, p_request_id text, p_trace_id text, p_ip_hash_or_policy_value text, p_user_agent_summary text, p_idempotency_scope_hash text, p_idempotency_key_hash text, p_event_fingerprint text) TO relay_app;

REVOKE ALL ON FUNCTION relay.reject_active_superadmin_user_delete() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.reject_changelog_release_delete() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.reject_immutable_governance_row() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.reject_immutable_metering_record() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.require_complete_tool_run_metering_route() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.require_current_user_session(p_session_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.require_fresh_superadmin_session(p_operator_session_id text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay.require_fresh_superadmin_session(p_operator_session_id text) TO relay_app;

REVOKE ALL ON FUNCTION relay.revoke_superadmin(p_target_user_id text, p_operator_session_id text, p_idempotency_key_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION relay.revoke_superadmin(p_target_user_id text, p_operator_session_id text, p_idempotency_key_hash text) TO relay_app;

REVOKE ALL ON FUNCTION relay.set_meter_policy_immutable_hash() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.set_pricing_policy_immutable_hash() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.set_subscription_snapshot_immutable_hash() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.set_workspace_scheduling_profile(p_workspace_id text, p_class_key text, p_granted_by text, p_expires_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.validate_provider_cost_snapshot() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.validate_routing_decision_reservation() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.validate_tool_run_reservation_context() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.validate_usage_adjustment_snapshot() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.validate_usage_event_snapshot() FROM PUBLIC;

REVOKE ALL ON FUNCTION relay.validate_usage_reservation_context() FROM PUBLIC;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.account TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.invitation TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.jwks TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.member TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth."oauthAccessToken" TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth."oauthClient" TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth."oauthClientAssertion" TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth."oauthClientResource" TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth."oauthConsent" TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth."oauthRefreshToken" TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth."oauthResource" TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.organization TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth."rateLimit" TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.session TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth."user" TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.verification TO relay_app;

GRANT SELECT,INSERT,UPDATE ON TABLE relay.artifact_uploads TO relay_app;

GRANT SELECT,INSERT,UPDATE ON TABLE relay.artifact_versions TO relay_app;

GRANT SELECT,INSERT,UPDATE ON TABLE relay.artifacts TO relay_app;

GRANT SELECT ON TABLE relay.audit_events TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.audit_events_id_seq TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.capacity_policies TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.capacity_policies_id_seq TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.capacity_pools TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.capacity_pools_id_seq TO relay_app;

GRANT SELECT,INSERT ON TABLE relay.entitlement_grants TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.execution_capacity_leases TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.execution_capacity_leases_id_seq TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.execution_jobs TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.execution_jobs_fifo_sequence_seq TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.execution_jobs_id_seq TO relay_app;

GRANT SELECT,INSERT ON TABLE relay.governance_operation_idempotency TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.idempotency_records TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.idempotency_records_id_seq TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.job_attempts TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.job_attempts_id_seq TO relay_app;

GRANT SELECT ON TABLE relay.meter_policies TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.outbox_events TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.outbox_events_id_seq TO relay_app;

GRANT SELECT,INSERT,UPDATE ON TABLE relay.output_items TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.output_items_id_seq TO relay_app;

GRANT SELECT,INSERT,UPDATE ON TABLE relay.output_sets TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.personal_workspaces TO relay_app;

GRANT SELECT ON TABLE relay.pricing_policies TO relay_app;

GRANT SELECT,INSERT ON TABLE relay.provider_cost_events TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.provider_models TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.provider_models_id_seq TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.providers TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.providers_id_seq TO relay_app;

GRANT SELECT,INSERT ON TABLE relay.routing_decisions TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.routing_decisions_id_seq TO relay_app;

GRANT SELECT,INSERT ON TABLE relay.routing_policies TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.routing_policies_id_seq TO relay_app;

GRANT SELECT ON TABLE relay.scheduler_classes TO relay_app;

GRANT SELECT,INSERT,UPDATE ON TABLE relay.share_links TO relay_app;

GRANT SELECT ON TABLE relay.subscription_snapshots TO relay_app;

GRANT SELECT ON TABLE relay.system_role_assignments TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.system_role_assignments_id_seq TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.tool_provider_bindings TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.tool_provider_bindings_id_seq TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.tool_queue_counters TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.tool_runs TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.tool_versions TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.tools TO relay_app;

GRANT SELECT ON TABLE relay.usage_adjustments TO relay_app;

GRANT SELECT,INSERT,UPDATE ON TABLE relay.usage_buckets TO relay_app;

GRANT SELECT,USAGE ON SEQUENCE relay.usage_buckets_id_seq TO relay_app;

GRANT SELECT,INSERT ON TABLE relay.usage_events TO relay_app;

GRANT SELECT,INSERT,UPDATE ON TABLE relay.usage_reservations TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.workspace_queue_counters TO relay_app;

GRANT SELECT ON TABLE relay.workspace_scheduling_profiles TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE relay.workspace_tool_queue_counters TO relay_app;

ALTER DEFAULT PRIVILEGES FOR ROLE relay_owner IN SCHEMA auth GRANT SELECT,USAGE ON SEQUENCES TO relay_app;

ALTER DEFAULT PRIVILEGES FOR ROLE relay_owner IN SCHEMA auth GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO relay_app;

ALTER DEFAULT PRIVILEGES FOR ROLE relay_owner IN SCHEMA relay REVOKE ALL ON SEQUENCES FROM relay_app;

ALTER DEFAULT PRIVILEGES FOR ROLE relay_owner IN SCHEMA relay REVOKE ALL ON TABLES FROM relay_app;

-- Pre-0.1.0 Relay MVP additions consolidated into the initial baseline.
CREATE TABLE relay.artifact_storage_accounts (
    workspace_id text NOT NULL,
    limit_bytes bigint NOT NULL,
    reserved_bytes bigint DEFAULT 0 NOT NULL,
    committed_bytes bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT artifact_storage_accounts_limit_bytes_check CHECK ((limit_bytes >= 0)),
    CONSTRAINT artifact_storage_accounts_reserved_bytes_check CHECK ((reserved_bytes >= 0)),
    CONSTRAINT artifact_storage_accounts_committed_bytes_check CHECK ((committed_bytes >= 0)),
    CONSTRAINT artifact_storage_accounts_capacity_check CHECK ((((reserved_bytes)::numeric + (committed_bytes)::numeric) <= (limit_bytes)::numeric)),
    CONSTRAINT artifact_storage_accounts_updated_at_check CHECK ((updated_at >= created_at))
);

ALTER TABLE ONLY relay.artifact_storage_accounts
    ADD CONSTRAINT artifact_storage_accounts_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY relay.artifact_storage_accounts
    ADD CONSTRAINT artifact_storage_accounts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id) ON DELETE CASCADE;

CREATE TABLE relay.artifact_storage_reservations (
    id text NOT NULL,
    workspace_id text NOT NULL,
    operation_id text NOT NULL,
    reserved_bytes bigint NOT NULL,
    status text DEFAULT 'reserved'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone,
    released_at timestamp with time zone,
    decremented_at timestamp with time zone,
    CONSTRAINT artifact_storage_reservations_id_check CHECK ((id ~ '^aqr_[0-9a-f]{32}$'::text)),
    CONSTRAINT artifact_storage_reservations_operation_id_check CHECK (((char_length(btrim(operation_id)) >= 1) AND (char_length(btrim(operation_id)) <= 255) AND (operation_id !~ '[[:cntrl:]]'::text) AND (operation_id !~* '[a-z][a-z0-9+.-]*://'::text))),
    CONSTRAINT artifact_storage_reservations_reserved_bytes_check CHECK ((reserved_bytes >= 0)),
    CONSTRAINT artifact_storage_reservations_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'committed'::text, 'released'::text, 'decremented'::text]))),
    CONSTRAINT artifact_storage_reservations_state_check CHECK ((((status = 'reserved'::text) AND (committed_at IS NULL) AND (released_at IS NULL) AND (decremented_at IS NULL)) OR ((status = 'committed'::text) AND (committed_at IS NOT NULL) AND (released_at IS NULL) AND (decremented_at IS NULL)) OR ((status = 'released'::text) AND (committed_at IS NULL) AND (released_at IS NOT NULL) AND (decremented_at IS NULL)) OR ((status = 'decremented'::text) AND (committed_at IS NOT NULL) AND (released_at IS NULL) AND (decremented_at IS NOT NULL) AND (decremented_at >= committed_at))))
);

ALTER TABLE ONLY relay.artifact_storage_reservations
    ADD CONSTRAINT artifact_storage_reservations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY relay.artifact_storage_reservations
    ADD CONSTRAINT artifact_storage_reservations_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY relay.artifact_storage_reservations
    ADD CONSTRAINT artifact_storage_reservations_workspace_operation_key UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY relay.artifact_storage_reservations
    ADD CONSTRAINT artifact_storage_reservations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES relay.artifact_storage_accounts(workspace_id) ON DELETE RESTRICT;

CREATE INDEX artifact_storage_reservations_active_idx ON relay.artifact_storage_reservations USING btree (workspace_id, created_at, id) WHERE (status = 'reserved'::text);

CREATE TABLE relay.artifact_mutation_idempotency (
    workspace_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation text NOT NULL,
    idempotency_key_hash text NOT NULL,
    request_hash text NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT artifact_mutation_idempotency_operation_check CHECK ((operation = ANY (ARRAY['create_upload'::text, 'complete_upload'::text, 'create_share'::text, 'revoke_share'::text]))),
    CONSTRAINT artifact_mutation_idempotency_key_hash_check CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT artifact_mutation_idempotency_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT artifact_mutation_idempotency_response_check CHECK (((jsonb_typeof(response) = 'object'::text) AND (NOT relay.jsonb_contains_raw_url(response))))
);

ALTER TABLE ONLY relay.artifact_mutation_idempotency
    ADD CONSTRAINT artifact_mutation_idempotency_pkey PRIMARY KEY (workspace_id, actor_user_id, operation, idempotency_key_hash);

ALTER TABLE ONLY relay.artifact_mutation_idempotency
    ADD CONSTRAINT artifact_mutation_idempotency_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY relay.artifact_mutation_idempotency
    ADD CONSTRAINT artifact_mutation_idempotency_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES auth.organization(id) ON DELETE CASCADE;

-- Existing random-token links remain resolvable by hash but are not replayable.
-- New deterministic links always set an explicit signing-key version.
ALTER TABLE relay.share_links
    ADD COLUMN token_key_version integer;

ALTER TABLE relay.share_links
    ADD CONSTRAINT share_links_token_key_version_check CHECK ((token_key_version > 0));

ALTER TABLE relay.artifacts
    ADD COLUMN purge_available_at timestamp with time zone;

UPDATE relay.artifacts
   SET purge_available_at = purge_after
 WHERE purge_status IN ('pending', 'claimed', 'deleting_pending', 'deleting');

CREATE INDEX artifacts_purge_retry_idx ON relay.artifacts USING btree (purge_available_at, created_at) WHERE (purge_status = 'deleting_pending'::text);

ALTER TABLE relay.job_attempts
    ADD COLUMN failure_code text;

ALTER TABLE relay.job_attempts
    ADD CONSTRAINT job_attempts_failure_code_check CHECK (((failure_code IS NULL) OR (failure_code ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'::text)));

ALTER TABLE relay.job_attempts
    ADD CONSTRAINT job_attempts_submission_state_check CHECK ((submission_state = ANY (ARRAY['pending'::text, 'submitting'::text, 'submitted'::text, 'completed'::text, 'interrupted'::text, 'cancelled'::text, 'ambiguous'::text])));

ALTER TABLE relay.job_attempts
    ADD CONSTRAINT job_attempts_provider_idempotency_key_check CHECK (((provider_idempotency_key IS NULL) OR (((char_length(provider_idempotency_key) >= 1) AND (char_length(provider_idempotency_key) <= 512)) AND (provider_idempotency_key !~ '[[:cntrl:]]'::text) AND (provider_idempotency_key !~* '[a-z][a-z0-9+.-]*://'::text))));

ALTER TABLE relay.job_attempts
    ADD CONSTRAINT job_attempts_provider_operation_id_check CHECK (((provider_operation_id IS NULL) OR (((char_length(provider_operation_id) >= 1) AND (char_length(provider_operation_id) <= 512)) AND (provider_operation_id !~ '[[:cntrl:]]'::text) AND (provider_operation_id !~* '[a-z][a-z0-9+.-]*://'::text))));

ALTER TABLE relay.job_attempts
    ADD CONSTRAINT job_attempts_submission_evidence_check CHECK (((submission_state <> 'submitted'::text) OR (provider_operation_id IS NOT NULL)));

ALTER TABLE relay.job_attempts
    ADD CONSTRAINT job_attempts_terminal_state_check CHECK ((((finished_at IS NULL) AND (outcome IS NULL) AND (retry_classification IS NULL) AND (failure_code IS NULL) AND (submission_state = ANY (ARRAY['pending'::text, 'submitting'::text, 'submitted'::text]))) OR ((finished_at IS NOT NULL) AND (outcome IS NOT NULL) AND (submission_state = ANY (ARRAY['completed'::text, 'interrupted'::text, 'cancelled'::text, 'ambiguous'::text])))));

ALTER TABLE relay.job_attempts
    ADD CONSTRAINT job_attempts_ambiguous_terminal_check CHECK (((submission_state <> 'ambiguous'::text) OR ((outcome = 'failed'::text) AND (retry_classification = 'submission_ambiguous'::text) AND (failure_code = 'provider_submission_ambiguous'::text) AND (provider_operation_id IS NULL))));

ALTER TABLE relay.job_attempts
    ADD CONSTRAINT job_attempts_ambiguous_retry_check CHECK ((NOT (((outcome = 'retry_scheduled'::text) AND (retry_classification = 'submission_ambiguous'::text)) AND (provider_operation_id IS NULL))));

CREATE FUNCTION relay.reject_immutable_artifact_record() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  raise exception 'relay.% rows are immutable', TG_TABLE_NAME
    using errcode = '55000';
end;
$$;

CREATE FUNCTION relay.enforce_artifact_storage_reservation_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if row(
    NEW.id,
    NEW.workspace_id,
    NEW.operation_id,
    NEW.reserved_bytes,
    NEW.created_at
  ) is distinct from row(
    OLD.id,
    OLD.workspace_id,
    OLD.operation_id,
    OLD.reserved_bytes,
    OLD.created_at
  ) then
    raise exception 'relay.artifact_storage_reservations identity is immutable'
      using errcode = '55000';
  end if;

  if NEW.status is not distinct from OLD.status then
    if row(NEW.committed_at, NEW.released_at, NEW.decremented_at) is distinct from
       row(OLD.committed_at, OLD.released_at, OLD.decremented_at)
    then
      raise exception 'artifact storage reservation evidence may only change with status'
        using errcode = '55000';
    end if;
  elsif not (
    (OLD.status = 'reserved' and NEW.status in ('committed', 'released'))
    or (OLD.status = 'committed' and NEW.status = 'decremented')
  ) then
    raise exception 'invalid artifact storage reservation transition'
      using errcode = '55000';
  end if;

  return NEW;
end;
$$;

CREATE OR REPLACE FUNCTION relay.protect_share_link_policy() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'relay.share_links policies cannot be deleted'
      using errcode = '55000';
  end if;

  if row(
    NEW.id,
    NEW.workspace_id,
    NEW.artifact_id,
    NEW.artifact_version_id,
    NEW.token_hash,
    NEW.token_key_version,
    NEW.follow_current,
    NEW.expires_at,
    NEW.max_resolutions,
    NEW.require_auth,
    NEW.content_disposition,
    NEW.created_by,
    NEW.created_at
  ) is distinct from row(
    OLD.id,
    OLD.workspace_id,
    OLD.artifact_id,
    OLD.artifact_version_id,
    OLD.token_hash,
    OLD.token_key_version,
    OLD.follow_current,
    OLD.expires_at,
    OLD.max_resolutions,
    OLD.require_auth,
    OLD.content_disposition,
    OLD.created_by,
    OLD.created_at
  ) then
    raise exception 'relay.share_links durable policy is immutable'
      using errcode = '55000';
  end if;

  if NEW.resolution_count = OLD.resolution_count then
    if NEW.last_resolved_at is distinct from OLD.last_resolved_at then
      raise exception 'share-link resolution timestamp requires a counted resolution'
        using errcode = '55000';
    end if;
  elsif NEW.resolution_count = OLD.resolution_count + 1 then
    if OLD.revoked_at is not null
      or NEW.last_resolved_at is null
      or (
        OLD.last_resolved_at is not null
        and NEW.last_resolved_at < OLD.last_resolved_at
      )
    then
      raise exception 'share-link resolution cannot advance after revocation or move backward'
        using errcode = '55000';
    end if;
  else
    raise exception 'share-link resolution count must advance atomically'
      using errcode = '55000';
  end if;

  if NEW.revoked_at is distinct from OLD.revoked_at and not (
    OLD.revoked_at is null and NEW.revoked_at is not null
  ) then
    raise exception 'share-link revocation is irreversible'
      using errcode = '55000';
  end if;

  return NEW;
end;
$$;

CREATE TRIGGER artifact_storage_reservations_transition_guard BEFORE DELETE OR UPDATE ON relay.artifact_storage_reservations FOR EACH ROW EXECUTE FUNCTION relay.enforce_artifact_storage_reservation_transition();

CREATE TRIGGER artifact_mutation_idempotency_immutable BEFORE DELETE OR UPDATE ON relay.artifact_mutation_idempotency FOR EACH ROW EXECUTE FUNCTION relay.reject_immutable_artifact_record();

REVOKE ALL ON FUNCTION relay.enforce_artifact_storage_reservation_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION relay.reject_immutable_artifact_record() FROM PUBLIC;

-- Fixed public IDs are SHA-256-derived opaque identifiers for the stable keys.
INSERT INTO relay.providers
  (id, key, name, lifecycle, configuration_reference, created_at)
OVERRIDING SYSTEM VALUE
VALUES
  (7200200100000001, 'azure-gpt-image-2', 'Azure GPT Image 2', 'published', 'azure-gpt-image-2', timestamp with time zone '2026-08-25 00:00:00+00'),
  (7200200100000002, 'azure-flux-2-pro', 'Azure FLUX.2 Pro', 'published', 'azure-flux-2-pro', timestamp with time zone '2026-08-25 00:00:00+00'),
  (7200200100000003, 'azure-mistral-ocr', 'Azure Mistral OCR', 'published', 'azure-mistral-ocr', timestamp with time zone '2026-08-25 00:00:00+00');

INSERT INTO relay.tools
  (id, key, name, category, summary, lifecycle, active_version_id, visibility, created_at, updated_at, readiness_critical)
VALUES
  ('tool_d84ca194052d72d603485742598726c3', 'image.generate.gpt-image-2', 'GPT Image 2', 'image', 'Generate images with GPT Image 2 on Azure.', 'internal', null, 'public', timestamp with time zone '2026-08-25 00:00:00+00', timestamp with time zone '2026-08-25 00:00:00+00', false),
  ('tool_0cd15820ee05ddd83c2734d174f01d7b', 'image.generate.flux-2-pro', 'FLUX.2 Pro', 'image', 'Generate images with FLUX.2 Pro on Azure.', 'internal', null, 'public', timestamp with time zone '2026-08-25 00:00:00+00', timestamp with time zone '2026-08-25 00:00:00+00', false),
  ('tool_9c347a9a7f4202d9ec92941ca4532809', 'document.ocr', 'Document OCR', 'document', 'Extract text and structured content from a Relay artifact with Mistral OCR on Azure.', 'internal', null, 'public', timestamp with time zone '2026-08-25 00:00:00+00', timestamp with time zone '2026-08-25 00:00:00+00', false);

WITH seeded_meter_policies (
  id, policy_key, revision, document, effective_at, expires_at
) AS (
  VALUES
  (
    'meter_c4cb2884f8474160fa2b61d5c6fb9c46'::text,
    'images.generated'::text,
    1,
    $json$ {
      "schemaVersion": 1,
      "metric": "images.generated",
      "unit": "image",
      "period": "calendar_month",
      "estimate": {
        "base": "0",
        "terms": [{ "measure": "requested_units", "rate": "1" }]
      },
      "reservation": { "multiplier": "1", "minimum": "0" },
      "settlement": {
        "success": "commit_actual",
        "partial_output": "commit_actual",
        "validation_rejected": "release",
        "safety_rejected": "release",
        "provider_failure": "release",
        "cancelled": "release",
        "timed_out": "release",
        "storage_failure": "release"
      }
    }$json$::jsonb,
    timestamp with time zone '2026-08-25 00:00:00+00',
    null::timestamp with time zone
  ),
  (
    'meter_ebafb531114359dfe541f419b0c5bc13'::text,
    'ocr.requests'::text,
    1,
    $json$ {
      "schemaVersion": 1,
      "metric": "ocr.requests",
      "unit": "request",
      "period": "calendar_month",
      "estimate": {
        "base": "0",
        "terms": [{ "measure": "requested_units", "rate": "1" }]
      },
      "reservation": { "multiplier": "1", "minimum": "0" },
      "settlement": {
        "success": "commit_actual",
        "partial_output": "commit_actual",
        "validation_rejected": "release",
        "safety_rejected": "release",
        "provider_failure": "release",
        "cancelled": "release",
        "timed_out": "release",
        "storage_failure": "release"
      }
    }$json$::jsonb,
    timestamp with time zone '2026-08-25 00:00:00+00',
    null::timestamp with time zone
  )
)
INSERT INTO relay.meter_policies (
  id, policy_key, revision, document, effective_at, expires_at, immutable_hash,
  created_at
)
SELECT
  id, policy_key, revision, document, effective_at, expires_at,
  relay.compute_meter_policy_immutable_hash(
    id, policy_key, revision, document, effective_at, expires_at
  ),
  timestamp with time zone '2026-08-25 00:00:00+00'
FROM seeded_meter_policies;

INSERT INTO relay.entitlement_grants (
  id, workspace_id, entitlement_key, grant_kind, capability_enabled,
  limit_amount, unit, period, source_kind, source_reference,
  subscription_snapshot_id, effective_at, expires_at, revoked_at, metadata,
  created_at
)
SELECT
  'grant_' || pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        'relay:mvp-entitlement:v1:' || organization.id || ':' ||
          grant_definition.entitlement_key || ':' || grant_definition.grant_kind,
        'UTF8'
      )
    ),
    'hex'
  ),
  organization.id,
  grant_definition.entitlement_key,
  grant_definition.grant_kind,
  grant_definition.capability_enabled,
  grant_definition.limit_amount,
  grant_definition.unit,
  grant_definition.period,
  'system',
  'relay.mvp.defaults.v1',
  null,
  timestamp with time zone '2026-08-25 00:00:00+00',
  null,
  null,
  $json$ {"seed":"relay.mvp.defaults.v1"}$json$::jsonb,
  timestamp with time zone '2026-08-25 00:00:00+00'
FROM auth.organization AS organization
CROSS JOIN (
  VALUES
    ('tools.execute'::text, 'capability'::text, true, null::numeric, null::text, null::text),
    ('images.generated'::text, 'limit'::text, null::boolean, null::numeric, 'image'::text, 'calendar_month'::text),
    ('ocr.requests'::text, 'limit'::text, null::boolean, null::numeric, 'request'::text, 'calendar_month'::text)
) AS grant_definition(
  entitlement_key, grant_kind, capability_enabled, limit_amount, unit, period
)
ORDER BY organization.id, grant_definition.entitlement_key,
         grant_definition.grant_kind;

WITH seeded_versions (
  id, tool_id, version, input_schema, output_schema, handler_key,
  input_schema_version, handler_version, execution_mode,
  max_duration_seconds, meter_policy_id, entitlement_key,
  compatibility_metadata, published_at, created_at
) AS (
  VALUES
  (
    'tver_11916cf469e30a49a4becb0ca4b994a5'::text,
    'tool_d84ca194052d72d603485742598726c3'::text,
    1,
    $json$ {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:relay:tool:image.generate.gpt-image-2:input:1",
      "title": "GPT Image 2 input",
      "type": "object",
      "additionalProperties": false,
      "required": ["prompt"],
      "properties": {
        "prompt": { "type": "string", "minLength": 1, "maxLength": 32000 },
        "n": { "type": "integer", "minimum": 1, "maximum": 10 },
        "size": { "type": "string", "maxLength": 9, "pattern": "^(auto|[1-9][0-9]{0,3}x[1-9][0-9]{0,3})$" },
        "quality": { "type": "string", "enum": ["low", "medium", "high"] },
        "outputFormat": { "type": "string", "enum": ["png", "jpeg"] },
        "outputCompression": { "type": "integer", "minimum": 0, "maximum": 100 },
        "background": { "type": "string", "enum": ["auto", "transparent", "opaque"] },
        "moderation": { "type": "string", "enum": ["auto", "low"] }
      },
      "allOf": [
        {
          "if": { "required": ["outputCompression"] },
          "then": {
            "required": ["outputFormat"],
            "properties": { "outputFormat": { "const": "jpeg" } }
          }
        },
        {
          "if": {
            "required": ["background"],
            "properties": { "background": { "const": "transparent" } }
          },
          "then": { "properties": { "outputFormat": { "const": "png" } } }
        }
      ],
      "x-relay-size-constraints": {
        "multipleOf": 16,
        "minimumPixels": 655360,
        "maximumPixels": 8294400,
        "maximumEdge": 3840,
        "maximumAspectRatio": 3
      }
    }$json$::jsonb,
    $json$ {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:relay:tool:image.generate.gpt-image-2:output:1",
      "title": "GPT Image 2 output",
      "type": "object",
      "additionalProperties": false,
      "required": ["artifacts"],
      "properties": {
        "artifacts": {
          "type": "array",
          "minItems": 1,
          "maxItems": 10,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["artifactId", "artifactVersionId", "mimeType", "width", "height", "sha256"],
            "properties": {
              "artifactId": { "type": "string", "pattern": "^art_[0-9a-f]{32}$" },
              "artifactVersionId": { "type": "string", "pattern": "^aver_[0-9a-f]{32}$" },
              "mimeType": { "type": "string", "enum": ["image/png", "image/jpeg"] },
              "width": { "type": "integer", "minimum": 1 },
              "height": { "type": "integer", "minimum": 1 },
              "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
            }
          }
        },
        "revisedPrompt": { "type": ["string", "null"] }
      }
    }$json$::jsonb,
    'image.generate.azure-openai.gpt-image-2.v1'::text,
    1,
    '1'::text,
    'async'::text,
    300,
    'meter_c4cb2884f8474160fa2b61d5c6fb9c46'::text,
    'tools.execute'::text,
    $json$ {"handler":{"key":"image.generate.azure-openai.gpt-image-2.v1","inputSchemaVersion":1,"handlerVersion":"1"},"submission":{"providerIdempotency":"unsupported","operationLookup":false,"ambiguousRetry":"forbidden"},"routing":{"fallback":"none"}}$json$::jsonb,
    timestamp with time zone '2026-08-25 00:00:00+00',
    timestamp with time zone '2026-08-25 00:00:00+00'
  ),
  (
    'tver_d1136a97173f7ba1f2bf117a86dfa98e'::text,
    'tool_0cd15820ee05ddd83c2734d174f01d7b'::text,
    1,
    $json$ {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:relay:tool:image.generate.flux-2-pro:input:1",
      "title": "FLUX.2 Pro input",
      "type": "object",
      "additionalProperties": false,
      "required": ["prompt"],
      "properties": {
        "prompt": { "type": "string", "minLength": 1, "maxLength": 32000 },
        "disablePromptUpsampling": { "type": "boolean" },
        "inputArtifactVersionIds": {
          "type": "array",
          "minItems": 1,
          "maxItems": 8,
          "uniqueItems": true,
          "items": { "type": "string", "pattern": "^aver_[0-9a-f]{32}$" }
        },
        "seed": { "type": "integer", "minimum": -9007199254740991, "maximum": 9007199254740991 },
        "width": { "type": "integer", "minimum": 64, "maximum": 65536 },
        "height": { "type": "integer", "minimum": 64, "maximum": 65536 },
        "safetyTolerance": { "type": "integer", "minimum": 0, "maximum": 5 },
        "outputFormat": { "type": "string", "enum": ["jpeg", "png", "webp"] }
      },
      "x-relay-maximum-pixels": 4194304
    }$json$::jsonb,
    $json$ {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:relay:tool:image.generate.flux-2-pro:output:1",
      "title": "FLUX.2 Pro output",
      "type": "object",
      "additionalProperties": false,
      "required": ["artifacts"],
      "properties": {
        "artifacts": {
          "type": "array",
          "minItems": 1,
          "maxItems": 1,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["artifactId", "artifactVersionId", "mimeType", "width", "height", "sha256"],
            "properties": {
              "artifactId": { "type": "string", "pattern": "^art_[0-9a-f]{32}$" },
              "artifactVersionId": { "type": "string", "pattern": "^aver_[0-9a-f]{32}$" },
              "mimeType": { "type": "string", "enum": ["image/jpeg", "image/png", "image/webp"] },
              "width": { "type": "integer", "minimum": 1 },
              "height": { "type": "integer", "minimum": 1 },
              "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
            }
          }
        },
        "seed": { "type": "integer", "minimum": -9007199254740991, "maximum": 9007199254740991 }
      }
    }$json$::jsonb,
    'image.generate.azure-flux.flux-2-pro.v1'::text,
    1,
    '1'::text,
    'async'::text,
    300,
    'meter_c4cb2884f8474160fa2b61d5c6fb9c46'::text,
    'tools.execute'::text,
    $json$ {"handler":{"key":"image.generate.azure-flux.flux-2-pro.v1","inputSchemaVersion":1,"handlerVersion":"1"},"submission":{"providerIdempotency":"unsupported","operationLookup":false,"ambiguousRetry":"forbidden"},"routing":{"fallback":"none"}}$json$::jsonb,
    timestamp with time zone '2026-08-25 00:00:00+00',
    timestamp with time zone '2026-08-25 00:00:00+00'
  ),
  (
    'tver_4ce03a4c68bb39f4be709e76360eb277'::text,
    'tool_9c347a9a7f4202d9ec92941ca4532809'::text,
    1,
    $json$ {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:relay:tool:document.ocr:input:1",
      "title": "Document OCR input",
      "type": "object",
      "additionalProperties": false,
      "oneOf": [
        { "required": ["sourceArtifactId"] },
        { "required": ["sourceArtifactVersionId"] }
      ],
      "properties": {
        "sourceArtifactId": { "type": "string", "pattern": "^art_[0-9a-f]{32}$" },
        "sourceArtifactVersionId": { "type": "string", "pattern": "^aver_[0-9a-f]{32}$" },
        "pages": {
          "oneOf": [
            { "type": "string", "minLength": 1, "maxLength": 4096, "pattern": "^[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*$" },
            {
              "type": "array",
              "minItems": 1,
              "maxItems": 1000,
              "uniqueItems": true,
              "items": { "type": "integer", "minimum": 0, "maximum": 99999 }
            }
          ]
        },
        "includeImages": { "type": "boolean" },
        "imageLimit": { "type": "integer", "minimum": 0, "maximum": 10000 },
        "imageMinSize": { "type": "integer", "minimum": 0, "maximum": 100000 },
        "imageAnnotationSchema": { "type": "object", "maxProperties": 256 },
        "extractionSchema": { "type": "object", "maxProperties": 256 },
        "extractionPrompt": { "type": "string", "minLength": 1, "maxLength": 32000 },
        "tableFormat": { "type": "string", "enum": ["markdown", "html"] },
        "extractHeader": { "type": "boolean" },
        "extractFooter": { "type": "boolean" },
        "confidenceGranularity": { "type": "string", "enum": ["word", "page"] }
      },
      "dependentRequired": {
        "extractionPrompt": ["extractionSchema"]
      }
    }$json$::jsonb,
    $json$ {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:relay:tool:document.ocr:output:1",
      "title": "Document OCR output",
      "type": "object",
      "additionalProperties": false,
      "required": ["sourceArtifactVersionId", "pages", "images"],
      "properties": {
        "sourceArtifactId": { "type": "string", "pattern": "^art_[0-9a-f]{32}$" },
        "sourceArtifactVersionId": { "type": "string", "pattern": "^aver_[0-9a-f]{32}$" },
        "pages": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["pageNumber", "markdown"],
            "properties": {
              "pageNumber": { "type": "integer", "minimum": 0 },
              "markdown": { "type": "string" },
              "header": { "type": ["string", "null"] },
              "footer": { "type": ["string", "null"] },
              "confidence": { "type": ["number", "null"], "minimum": 0, "maximum": 1 }
            }
          }
        },
        "images": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["artifactId", "artifactVersionId", "mimeType", "sha256"],
            "properties": {
              "artifactId": { "type": "string", "pattern": "^art_[0-9a-f]{32}$" },
              "artifactVersionId": { "type": "string", "pattern": "^aver_[0-9a-f]{32}$" },
              "mimeType": { "type": "string", "minLength": 1, "maxLength": 255 },
              "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
              "pageNumber": { "type": "integer", "minimum": 0 }
            }
          }
        },
        "extractedData": { "type": ["object", "array", "string", "number", "boolean", "null"] },
        "warnings": { "type": "array", "items": { "type": "string" } }
      }
    }$json$::jsonb,
    'document.ocr.azure-mistral.v1'::text,
    1,
    '1'::text,
    'async'::text,
    600,
    'meter_ebafb531114359dfe541f419b0c5bc13'::text,
    'tools.execute'::text,
    $json$ {"handler":{"key":"document.ocr.azure-mistral.v1","inputSchemaVersion":1,"handlerVersion":"1"},"submission":{"providerIdempotency":"unsupported","operationLookup":false,"ambiguousRetry":"forbidden"},"routing":{"fallback":"none"}}$json$::jsonb,
    timestamp with time zone '2026-08-25 00:00:00+00',
    timestamp with time zone '2026-08-25 00:00:00+00'
  )
)
INSERT INTO relay.tool_versions (
  id, tool_id, version, input_schema, output_schema, handler_key,
  input_schema_version, handler_version, execution_mode,
  max_duration_seconds, meter_policy_id, entitlement_key,
  compatibility_metadata, published_at, immutable_hash, created_at
)
SELECT
  id, tool_id, version, input_schema, output_schema, handler_key,
  input_schema_version, handler_version, execution_mode,
  max_duration_seconds, meter_policy_id, entitlement_key,
  compatibility_metadata, published_at,
  relay.compute_tool_version_immutable_hash(
    id, tool_id, version, input_schema, output_schema, handler_key,
    input_schema_version, handler_version, execution_mode,
    max_duration_seconds, meter_policy_id, entitlement_key,
    compatibility_metadata
  ),
  created_at
FROM seeded_versions;

INSERT INTO relay.provider_models
  (id, provider_id, key, display_name, capability_schema, pricing_policy_id, lifecycle, region_constraints, created_at)
OVERRIDING SYSTEM VALUE
SELECT seeded.id,
       seeded.provider_id,
       seeded.key,
       seeded.display_name,
       version.input_schema,
       null,
       'published',
       null,
       timestamp with time zone '2026-08-25 00:00:00+00'
FROM (
  VALUES
    (7200200200000001::bigint, 7200200100000001::bigint, 'gpt-image-2'::text, 'GPT Image 2'::text, 'tver_11916cf469e30a49a4becb0ca4b994a5'::text),
    (7200200200000002::bigint, 7200200100000002::bigint, 'FLUX.2-pro'::text, 'FLUX.2 Pro'::text, 'tver_d1136a97173f7ba1f2bf117a86dfa98e'::text),
    (7200200200000003::bigint, 7200200100000003::bigint, 'mistral-ocr-4-0'::text, 'Mistral OCR 4.0'::text, 'tver_4ce03a4c68bb39f4be709e76360eb277'::text)
) AS seeded(id, provider_id, key, display_name, tool_version_id)
JOIN relay.tool_versions AS version ON version.id = seeded.tool_version_id;

INSERT INTO relay.capacity_pools
  (id, key, provider_model_id, region, execution_class, enabled)
OVERRIDING SYSTEM VALUE
VALUES
  (7200200300000001, 'azure-gpt-image-2', 7200200200000001, null, 'standard', true),
  (7200200300000002, 'azure-flux-2-pro', 7200200200000002, null, 'standard', true),
  (7200200300000003, 'azure-mistral-ocr', 7200200200000003, null, 'standard', true);

-- Each version has exactly one route and no routing policy, so fallback is not possible.
INSERT INTO relay.tool_provider_bindings
  (id, tool_version_id, provider_model_id, capacity_pool_id, routing_order, enabled, routing_policy_id, created_at)
OVERRIDING SYSTEM VALUE
VALUES
  (7200200400000001, 'tver_11916cf469e30a49a4becb0ca4b994a5', 7200200200000001, 7200200300000001, 1, true, null, timestamp with time zone '2026-08-25 00:00:00+00'),
  (7200200400000002, 'tver_d1136a97173f7ba1f2bf117a86dfa98e', 7200200200000002, 7200200300000002, 1, true, null, timestamp with time zone '2026-08-25 00:00:00+00'),
  (7200200400000003, 'tver_4ce03a4c68bb39f4be709e76360eb277', 7200200200000003, 7200200300000003, 1, true, null, timestamp with time zone '2026-08-25 00:00:00+00');

-- These operational defaults are deliberately editable capacity policies.
-- Provider rates stay hard-limited while execution and queue depth start from
-- conservative defaults; provider pricing remains unknown and unseeded.
INSERT INTO relay.capacity_policies
  (id, scope_type, scope_id, revision, configuration, effective_at, expires_at)
OVERRIDING SYSTEM VALUE
VALUES
  (7200200500000001, 'capacity_pool', '7200200300000001', 1, $json$ {"submissionRateDefaults":{"providerPerMinute":12},"executionConcurrency":{"globalTool":1,"pool":1,"workspaceTotal":1,"workspaceTool":1}}$json$::jsonb, timestamp with time zone '2026-08-25 00:00:00+00', null),
  (7200200500000002, 'capacity_pool', '7200200300000002', 1, $json$ {"submissionRateDefaults":{"providerPerMinute":4},"executionConcurrency":{"globalTool":1,"pool":1,"workspaceTotal":1,"workspaceTool":1}}$json$::jsonb, timestamp with time zone '2026-08-25 00:00:00+00', null),
  (7200200500000003, 'capacity_pool', '7200200300000003', 1, $json$ {"submissionRateDefaults":{"providerPerMinute":50},"executionConcurrency":{"globalTool":1,"pool":1,"workspaceTotal":1,"workspaceTool":1}}$json$::jsonb, timestamp with time zone '2026-08-25 00:00:00+00', null),
  (7200200500000004, 'tool', 'tool_d84ca194052d72d603485742598726c3', 1, $json$ {"globalTool":50,"workspaceTotal":20,"workspaceTool":5}$json$::jsonb, timestamp with time zone '2026-08-25 00:00:00+00', null),
  (7200200500000005, 'tool', 'tool_0cd15820ee05ddd83c2734d174f01d7b', 1, $json$ {"globalTool":50,"workspaceTotal":20,"workspaceTool":5}$json$::jsonb, timestamp with time zone '2026-08-25 00:00:00+00', null),
  (7200200500000006, 'tool', 'tool_9c347a9a7f4202d9ec92941ca4532809', 1, $json$ {"globalTool":50,"workspaceTotal":20,"workspaceTool":5}$json$::jsonb, timestamp with time zone '2026-08-25 00:00:00+00', null);

UPDATE relay.tools AS tool
   SET lifecycle = 'published',
       active_version_id = seeded.tool_version_id,
       updated_at = timestamp with time zone '2026-08-25 00:00:00+00'
  FROM (
    VALUES
      ('tool_d84ca194052d72d603485742598726c3'::text, 'tver_11916cf469e30a49a4becb0ca4b994a5'::text),
      ('tool_0cd15820ee05ddd83c2734d174f01d7b'::text, 'tver_d1136a97173f7ba1f2bf117a86dfa98e'::text),
      ('tool_9c347a9a7f4202d9ec92941ca4532809'::text, 'tver_4ce03a4c68bb39f4be709e76360eb277'::text)
  ) AS seeded(tool_id, tool_version_id)
 WHERE tool.id = seeded.tool_id;

REVOKE ALL ON TABLE relay.artifact_storage_accounts FROM PUBLIC;
REVOKE ALL ON TABLE relay.artifact_storage_accounts FROM relay_app;
GRANT SELECT, INSERT, UPDATE ON TABLE relay.artifact_storage_accounts TO relay_app;

REVOKE ALL ON TABLE relay.artifact_storage_reservations FROM PUBLIC;
REVOKE ALL ON TABLE relay.artifact_storage_reservations FROM relay_app;
GRANT SELECT, INSERT, UPDATE ON TABLE relay.artifact_storage_reservations TO relay_app;

REVOKE ALL ON TABLE relay.artifact_mutation_idempotency FROM PUBLIC;
REVOKE ALL ON TABLE relay.artifact_mutation_idempotency FROM relay_app;
GRANT SELECT, INSERT ON TABLE relay.artifact_mutation_idempotency TO relay_app;`;

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0001_relay_baseline",
  checksumSha256:
    "2e4e429c7dc182511fe76c1d4f0ee43dc2e92a33bb6f4bdbd12a1e6030fa51f5",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
