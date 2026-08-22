import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * Durable, server-owned weighted scheduling policy. The execution-job trigger
 * is the hard trust boundary: admission callers may still carry legacy class
 * fields, but PostgreSQL replaces them with the active workspace grant (or the
 * standard fallback) and rejects later attempts to rewrite the snapshot.
 *
 * `relay_app` can read policy but cannot mutate either table or execute the
 * workspace-grant helper. Grant mutation remains owner-only until a privileged,
 * audited authorization API exists. Class policy changes require a strictly
 * newer version, making every published version immutable.
 */
const CANONICAL_SQL = `
create table relay.scheduler_classes (
  class_key text primary key
    check (class_key in ('standard', 'paid', 'enterprise', 'internal')),
  weight numeric not null check (weight > 0),
  max_share numeric,
  enabled boolean not null default true,
  policy_version integer not null check (policy_version > 0),
  unique (class_key, policy_version),
  check (max_share is null or (max_share > 0 and max_share < 1)),
  check (
    (class_key = 'internal' and max_share is not null)
    or (class_key <> 'internal' and max_share is null)
  )
);

insert into relay.scheduler_classes
  (class_key, weight, max_share, enabled, policy_version)
values
  ('standard', 1, null, true, 1),
  ('paid', 2, null, true, 1),
  ('enterprise', 4, null, true, 1),
  ('internal', 1, 0.10, true, 1);

create function relay.enforce_scheduler_class_revision()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
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
$function$;

create trigger scheduler_classes_revision_guard
  before update or delete on relay.scheduler_classes
  for each row execute function relay.enforce_scheduler_class_revision();

create table relay.workspace_scheduling_profiles (
  workspace_id text primary key references auth.organization ("id") on delete cascade,
  class_key text not null,
  policy_version integer not null check (policy_version > 0),
  granted_by text references auth."user" ("id") on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  foreign key (class_key, policy_version)
    references relay.scheduler_classes (class_key, policy_version)
    on update cascade,
  check (expires_at is null or expires_at > granted_at)
);
create index workspace_scheduling_profiles_class_idx
  on relay.workspace_scheduling_profiles (class_key);
create index workspace_scheduling_profiles_expiry_idx
  on relay.workspace_scheduling_profiles (expires_at)
  where expires_at is not null;

insert into relay.workspace_scheduling_profiles
  (workspace_id, class_key, policy_version, granted_by, granted_at)
select organization."id", standard.class_key, standard.policy_version, null, now()
  from auth.organization organization
  cross join relay.scheduler_classes standard
 where standard.class_key = 'standard';

update relay.execution_jobs jobs
   set scheduling_class = standard.class_key,
       scheduling_policy_version = standard.policy_version
  from relay.scheduler_classes standard
 where standard.class_key = 'standard';

alter table relay.execution_jobs
  alter column scheduling_policy_version set not null,
  add constraint execution_jobs_scheduling_class_fkey
    foreign key (scheduling_class) references relay.scheduler_classes (class_key);

create function relay.create_default_workspace_scheduling_profile()
returns trigger as $$
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
$$ language plpgsql security definer
set search_path = pg_catalog;

create trigger organization_default_scheduling_profile
  after insert on auth.organization
  for each row execute function relay.create_default_workspace_scheduling_profile();

create function relay.set_workspace_scheduling_profile(
  p_workspace_id text,
  p_class_key text,
  p_granted_by text,
  p_expires_at timestamptz default null
)
returns void as $$
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
$$ language plpgsql security definer
set search_path = pg_catalog;

create function relay.enforce_execution_job_scheduling_profile()
returns trigger as $$
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
$$ language plpgsql security definer
set search_path = pg_catalog;

create trigger execution_jobs_server_owned_scheduling_profile
  before insert or update of workspace_id, scheduling_class, scheduling_policy_version
  on relay.execution_jobs
  for each row execute function relay.enforce_execution_job_scheduling_profile();

revoke insert, update, delete on relay.scheduler_classes from relay_app;
revoke insert, update, delete on relay.workspace_scheduling_profiles from relay_app;
revoke all on function relay.enforce_scheduler_class_revision() from public;
revoke all on function relay.create_default_workspace_scheduling_profile() from public;
revoke all on function relay.set_workspace_scheduling_profile(text, text, text, timestamptz) from public;
revoke all on function relay.set_workspace_scheduling_profile(text, text, text, timestamptz) from relay_app;
revoke all on function relay.enforce_execution_job_scheduling_profile() from public;
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0025_scheduler_profiles",
  checksumSha256:
    "ad91965d0d84df945d5da63def87330a028f37b877196053e011c9e6eca5d102",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
