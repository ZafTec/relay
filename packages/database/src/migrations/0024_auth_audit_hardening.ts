import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * Routes audit inserts and superadmin mutations through narrowly scoped
 * database functions. Privileged-operation replay state is stored separately
 * from the app-writable audit API, operator identity is derived from a live
 * Better Auth session, and role authorization is locked through the mutation.
 */
const CANONICAL_SQL = `
do $migration$
begin
  if exists (
    select 1
    from relay.system_role_assignments
    where revoked_at is null
    group by user_id
    having pg_catalog.count(*) > 1
  ) then
    raise exception 'duplicate active superadmin assignments must be reconciled before migration 0024'
      using errcode = '23505';
  end if;
end;
$migration$;

create unique index system_role_assignments_one_active_per_user_idx
  on relay.system_role_assignments (user_id)
  where revoked_at is null;

drop index relay.system_role_assignments_active_idx;

create table relay.audit_event_idempotency (
  scope_hash text not null check (scope_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  event_fingerprint text not null check (event_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (scope_hash, idempotency_key_hash)
);

create table relay.privileged_operation_idempotency (
  operation text not null check (operation in ('bootstrap', 'grant', 'revoke')),
  operator_user_id text not null,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  target_user_id text not null,
  result text not null check (result in ('changed', 'unchanged', 'last_superadmin')),
  created_at timestamptz not null default now(),
  primary key (operation, operator_user_id, idempotency_key_hash)
);

revoke all on relay.audit_event_idempotency from public, relay_app;
revoke all on relay.privileged_operation_idempotency from public, relay_app;
revoke insert, update, delete on relay.system_role_assignments from relay_app;
revoke insert on relay.audit_events from relay_app;

create function relay.record_audit_event(
  p_actor_type text,
  p_actor_user_id text,
  p_oauth_client_id text,
  p_workspace_id text,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_outcome text,
  p_reason_code text,
  p_before_snapshot jsonb,
  p_after_snapshot jsonb,
  p_request_id text,
  p_trace_id text,
  p_ip_hash_or_policy_value text,
  p_user_agent_summary text,
  p_idempotency_scope_hash text,
  p_idempotency_key_hash text,
  p_event_fingerprint text
) returns text
language plpgsql
security definer
set search_path = pg_catalog
as $function$
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

  if p_action like 'system_role.superadmin.%' then
    raise exception 'privileged audit actions require their dedicated mutation function'
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
$function$;

create function relay.require_fresh_superadmin_session(
  p_operator_session_id text
) returns text
language plpgsql
security definer
set search_path = pg_catalog
as $function$
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
$function$;

create function relay.reject_active_superadmin_user_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
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
$function$;

create trigger reject_active_superadmin_user_delete
  before delete on auth."user"
  for each row execute function relay.reject_active_superadmin_user_delete();

create function relay.bootstrap_superadmin(
  p_target_user_id text,
  p_idempotency_key_hash text
) returns text
language plpgsql
security definer
set search_path = pg_catalog
as $function$
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
$function$;

create function relay.grant_superadmin(
  p_target_user_id text,
  p_operator_session_id text,
  p_idempotency_key_hash text
) returns text
language plpgsql
security definer
set search_path = pg_catalog
as $function$
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
$function$;

create function relay.revoke_superadmin(
  p_target_user_id text,
  p_operator_session_id text,
  p_idempotency_key_hash text
) returns text
language plpgsql
security definer
set search_path = pg_catalog
as $function$
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
$function$;

revoke all on function relay.record_audit_event(
  text, text, text, text, text, text, text, text, text, jsonb, jsonb,
  text, text, text, text, text, text, text
) from public;
revoke all on function relay.require_fresh_superadmin_session(text) from public;
revoke all on function relay.reject_active_superadmin_user_delete() from public;
revoke all on function relay.bootstrap_superadmin(text, text) from public;
revoke all on function relay.grant_superadmin(text, text, text) from public;
revoke all on function relay.revoke_superadmin(text, text, text) from public;

grant execute on function relay.record_audit_event(
  text, text, text, text, text, text, text, text, text, jsonb, jsonb,
  text, text, text, text, text, text, text
) to relay_app;
grant execute on function relay.grant_superadmin(text, text, text) to relay_app;
grant execute on function relay.revoke_superadmin(text, text, text) to relay_app;
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0024_auth_audit_hardening",
  checksumSha256:
    "4b1aa79d8d58b73dce58a2351eab0713dc75f2a788c7945b56ee5c5800fe1d3d",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
