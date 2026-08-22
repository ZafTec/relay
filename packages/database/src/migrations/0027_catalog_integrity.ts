import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * Makes catalog execution decisions self-contained and keeps every mutable
 * operational switch separate from immutable route identity.
 */
const CANONICAL_SQL = `
alter table relay.tools
  add column readiness_critical boolean not null default false;


alter table relay.tool_versions
  add column input_schema_version integer not null default 1,
  add column handler_version text not null default '1',
  add constraint tool_versions_input_schema_version_check
    check (input_schema_version > 0),
  add constraint tool_versions_handler_version_check
    check (char_length(handler_version) > 0);

create function relay.compute_tool_version_immutable_hash(
  p_id text,
  p_tool_id text,
  p_version integer,
  p_input_schema jsonb,
  p_output_schema jsonb,
  p_handler_key text,
  p_input_schema_version integer,
  p_handler_version text,
  p_execution_mode text,
  p_max_duration_seconds integer,
  p_meter_policy_id text,
  p_entitlement_key text,
  p_compatibility_metadata jsonb
)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $function$
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
$function$;

alter table relay.tool_versions
  disable trigger tool_versions_immutable_after_publish;

update relay.tool_versions
set immutable_hash = relay.compute_tool_version_immutable_hash(
  id,
  tool_id,
  version,
  input_schema,
  output_schema,
  handler_key,
  input_schema_version,
  handler_version,
  execution_mode,
  max_duration_seconds,
  meter_policy_id,
  entitlement_key,
  compatibility_metadata
);

alter table relay.tool_versions
  enable trigger tool_versions_immutable_after_publish;

create function relay.maintain_tool_version_immutable_hash()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
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
$function$;

create trigger tool_versions_contract_hash_valid
  before insert or update on relay.tool_versions
  for each row execute function relay.maintain_tool_version_immutable_hash();

create or replace function relay.reject_tool_version_mutation_after_publish()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
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
$function$;

alter table relay.routing_policies
  add constraint routing_policies_document_check check (
    pg_catalog.jsonb_typeof(policy) = 'object'
    and (
      not (policy ? 'fallback')
      or (
        pg_catalog.jsonb_typeof(policy -> 'fallback') = 'object'
        and (
          not ((policy -> 'fallback') ? 'mode')
          or coalesce(policy #>> '{fallback,mode}', '') in ('none', 'ordered')
        )
      )
    )
  );

create function relay.compute_routing_policy_immutable_hash(
  p_id bigint,
  p_revision integer,
  p_policy jsonb,
  p_effective_at timestamptz
)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $function$
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
$function$;

update relay.routing_policies
set immutable_hash = relay.compute_routing_policy_immutable_hash(
  id,
  revision,
  policy,
  effective_at
);

create function relay.set_routing_policy_immutable_hash()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
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
$function$;

create trigger routing_policies_canonical_hash
  before insert or update on relay.routing_policies
  for each row execute function relay.set_routing_policy_immutable_hash();

alter table relay.tool_versions
  add constraint tool_versions_tool_id_id_key unique (tool_id, id);

alter table relay.tools
  drop constraint tools_active_version_id_fkey,
  add constraint tools_active_version_belongs_to_tool_fkey
    foreign key (id, active_version_id)
    references relay.tool_versions (tool_id, id),
  add constraint tools_serving_lifecycle_has_active_version_check
    check (
      lifecycle not in ('published', 'deprecated')
      or active_version_id is not null
    );

create function relay.validate_tool_active_version()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
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
$function$;

create trigger tools_active_version_consistent
  before insert or update of id, active_version_id, lifecycle on relay.tools
  for each row execute function relay.validate_tool_active_version();

alter table relay.tool_provider_bindings
  add constraint tool_provider_bindings_tool_version_routing_order_key
    unique (tool_version_id, routing_order),
  add constraint tool_provider_bindings_route_snapshot_key
    unique (id, tool_version_id, provider_model_id, capacity_pool_id, routing_order);

create function relay.reject_tool_provider_binding_structure_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
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
$function$;

create trigger tool_provider_bindings_structure_immutable
  before update on relay.tool_provider_bindings
  for each row execute function relay.reject_tool_provider_binding_structure_mutation();

alter table relay.provider_models
  add constraint provider_models_provider_id_id_key unique (provider_id, id);

alter table relay.tool_runs
  add constraint tool_runs_id_tool_version_id_key unique (id, tool_version_id);

alter table relay.routing_policies
  add constraint routing_policies_immutable_hash_length_check
    check (char_length(immutable_hash) = 64),
  add constraint routing_policies_id_revision_hash_key
    unique (id, revision, immutable_hash);

alter table relay.routing_decisions
  add column tool_id text,
  add column tool_version_id text,
  add column tool_version_immutable_hash text,
  add column handler_key text,
  add column input_schema_version integer,
  add column handler_version text,
  add column capacity_pool_id bigint,
  add column routing_order integer,
  add column routing_policy_immutable_hash text;

do $function$
begin
  if exists (
    select 1
    from relay.tools t
    join relay.tool_versions tv on tv.id = t.active_version_id
    where t.active_version_id is not null
      and (tv.tool_id <> t.id or tv.published_at is null)
  ) then
    raise exception 'existing tool active version does not belong to the tool or is unpublished';
  end if;

  if exists (
    select 1
    from relay.tool_provider_bindings tpb
    join relay.capacity_pools cp on cp.id = tpb.capacity_pool_id
    where cp.provider_model_id is not null
      and cp.provider_model_id <> tpb.provider_model_id
  ) then
    raise exception 'existing tool-provider binding conflicts with its capacity-pool provider model';
  end if;

  if exists (
    select 1
    from relay.routing_decisions rd
    join relay.tool_runs tr on tr.id = rd.tool_run_id
    join relay.tool_provider_bindings tpb on tpb.id = rd.selected_binding_id
    join relay.provider_models pm on pm.id = tpb.provider_model_id
    left join relay.routing_policies rp on rp.id = tpb.routing_policy_id
    where tr.tool_version_id <> tpb.tool_version_id
       or rd.provider_model_id <> tpb.provider_model_id
       or rd.provider_id <> pm.provider_id
       or (
         rd.routing_policy_id is not null
         and rd.routing_policy_id is distinct from tpb.routing_policy_id
       )
       or (
         rd.routing_policy_revision is not null
         and rd.routing_policy_revision is distinct from rp.revision
       )
  ) then
    raise exception 'existing routing decision contains contradictory catalog references';
  end if;
end;
$function$;

with decision_snapshots as (
  select rd.id,
         tv.tool_id,
         tr.tool_version_id,
         tv.immutable_hash as tool_version_immutable_hash,
         tv.handler_key,
         tv.input_schema_version,
         tv.handler_version,
         tpb.capacity_pool_id,
         tpb.routing_order,
         tpb.routing_policy_id,
         rp.revision as routing_policy_revision,
         rp.immutable_hash as routing_policy_immutable_hash,
         exists (
           select 1
           from relay.tool_provider_bindings earlier
           where earlier.tool_version_id = tpb.tool_version_id
             and earlier.routing_order < tpb.routing_order
             and earlier.created_at <= rd.selected_at
         ) as derived_fallback_used
  from relay.routing_decisions rd
  join relay.tool_runs tr on tr.id = rd.tool_run_id
  join relay.tool_provider_bindings tpb on tpb.id = rd.selected_binding_id
  join relay.tool_versions tv on tv.id = tr.tool_version_id
  left join relay.routing_policies rp on rp.id = tpb.routing_policy_id
)
update relay.routing_decisions rd
set tool_id = snapshot.tool_id,
    tool_version_id = snapshot.tool_version_id,
    tool_version_immutable_hash = snapshot.tool_version_immutable_hash,
    handler_key = snapshot.handler_key,
    input_schema_version = snapshot.input_schema_version,
    handler_version = snapshot.handler_version,
    capacity_pool_id = snapshot.capacity_pool_id,
    routing_order = snapshot.routing_order,
    routing_policy_id = snapshot.routing_policy_id,
    routing_policy_revision = snapshot.routing_policy_revision,
    routing_policy_immutable_hash = snapshot.routing_policy_immutable_hash,
    fallback_used = snapshot.derived_fallback_used,
    fallback_reason = case
      when snapshot.derived_fallback_used then
        coalesce(rd.fallback_reason, 'higher_priority_route_unavailable')
      else null
    end
from decision_snapshots snapshot
where rd.id = snapshot.id;

do $function$
begin
  if exists (
    select 1
    from relay.routing_decisions rd
    left join relay.routing_policies rp on rp.id = rd.routing_policy_id
    where rd.fallback_used
      and (
        rp.id is null
        or rp.effective_at > rd.selected_at
        or rp.policy #>> '{fallback,mode}' is distinct from 'ordered'
      )
  ) then
    raise exception 'existing routing decision fallback is not authorized by an effective ordered-fallback policy';
  end if;
end;
$function$;

alter table relay.routing_decisions
  alter column tool_id set not null,
  alter column tool_version_id set not null,
  alter column tool_version_immutable_hash set not null,
  alter column handler_key set not null,
  alter column input_schema_version set not null,
  alter column handler_version set not null,
  alter column capacity_pool_id set not null,
  alter column routing_order set not null,
  add constraint routing_decisions_input_schema_version_check
    check (input_schema_version > 0),
  add constraint routing_decisions_handler_version_check
    check (char_length(handler_version) > 0),
  add constraint routing_decisions_fallback_metadata_check
    check (
      (fallback_used and fallback_reason is not null)
      or (not fallback_used and fallback_reason is null)
    ),
  add constraint routing_decisions_run_tool_version_fkey
    foreign key (tool_run_id, tool_version_id)
    references relay.tool_runs (id, tool_version_id),
  add constraint routing_decisions_tool_version_tool_fkey
    foreign key (tool_id, tool_version_id)
    references relay.tool_versions (tool_id, id),
  add constraint routing_decisions_binding_snapshot_fkey
    foreign key (
      selected_binding_id,
      tool_version_id,
      provider_model_id,
      capacity_pool_id,
      routing_order
    ) references relay.tool_provider_bindings (
      id,
      tool_version_id,
      provider_model_id,
      capacity_pool_id,
      routing_order
    ),
  add constraint routing_decisions_provider_model_provider_fkey
    foreign key (provider_id, provider_model_id)
    references relay.provider_models (provider_id, id),
  add constraint routing_decisions_capacity_pool_id_fkey
    foreign key (capacity_pool_id) references relay.capacity_pools (id),
  add constraint routing_decisions_policy_revision_fkey
    foreign key (
      routing_policy_id,
      routing_policy_revision,
      routing_policy_immutable_hash
    ) references relay.routing_policies (id, revision, immutable_hash)
    match full;

create function relay.validate_tool_provider_binding_consistency()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
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
$function$;

create trigger tool_provider_bindings_consistent
  before insert or update on relay.tool_provider_bindings
  for each row execute function relay.validate_tool_provider_binding_consistency();

create function relay.validate_capacity_pool_binding_consistency()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
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
$function$;

create trigger capacity_pools_bindings_consistent
  before update of provider_model_id on relay.capacity_pools
  for each row execute function relay.validate_capacity_pool_binding_consistency();

create function relay.validate_routing_decision_consistency()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
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
$function$;

create trigger routing_decisions_consistent
  before insert on relay.routing_decisions
  for each row execute function relay.validate_routing_decision_consistency();

create function relay.reject_immutable_routing_record()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  raise exception 'relay.% rows are immutable', TG_TABLE_NAME
    using errcode = '55000';
end;
$function$;

create trigger routing_policies_immutable
  before update or delete on relay.routing_policies
  for each row execute function relay.reject_immutable_routing_record();

create trigger routing_decisions_immutable
  before update or delete on relay.routing_decisions
  for each row execute function relay.reject_immutable_routing_record();
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0027_catalog_integrity",
  checksumSha256:
    "acd1f286b865e89634e347fb3f2fa01712c309e4bcbacd7c5eb243bacdd8dfe4",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
