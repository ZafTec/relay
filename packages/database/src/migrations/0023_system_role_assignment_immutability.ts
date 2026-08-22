import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * `relay.system_role_assignments` (0003_system_role_assignments.ts) had
 * no grants beyond the schema-wide default -- `relay_app` (the runtime
 * API/worker role) could freely INSERT, UPDATE, or DELETE superadmin
 * grant rows directly, bypassing `grantSuperadmin`/`revokeSuperadmin`'s
 * audit trail entirely: silently granting superadmin to any user,
 * un-revoking a grant by nulling `revoked_at` back out, backdating
 * `granted_at`, or erasing grant history outright.
 *
 * Unlike `relay.audit_events`/`relay.routing_decisions`/
 * `relay.schema_migrations`, this table isn't purely insert-only --
 * `revokeSuperadmin` legitimately UPDATEs a row to set `revoked_by`/
 * `revoked_at`. So a blanket `revoke update` would break real
 * application behavior; instead a trigger allows exactly one UPDATE
 * shape -- a not-yet-revoked row transitioning to fully revoked, with
 * every other column unchanged -- and rejects everything else.
 * `relay_app` keeps INSERT (`grantSuperadmin` needs it) and loses DELETE
 * outright (nothing legitimate ever deletes a grant row).
 */
const CANONICAL_SQL = `
create function relay.reject_system_role_assignment_mutation()
returns trigger as $$
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
$$ language plpgsql;

create trigger system_role_assignments_immutable_except_revoke
  before update on relay.system_role_assignments
  for each row execute function relay.reject_system_role_assignment_mutation();

revoke delete on relay.system_role_assignments from relay_app;
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0023_system_role_assignment_immutability",
  checksumSha256:
    "4b756a991595ca4cc639daa34158a8d7b06a93bb588cf20bfe7901300d5fb050",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
