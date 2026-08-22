import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * Two more "immutable once written" invariants, per
 * docs/implementation-handoff/05-domain-storage-metering.md, that were
 * previously enforced only by application convention (packages/catalog
 * never updating a published row) rather than by the database -- the same
 * gap 0005_audit_events.ts closed for the audit log, applied here to the
 * two other domain tables the handoff doc calls immutable:
 *
 * - "Published tool versions are immutable" (0013_tool_registry.ts's own
 *   comment on relay.tool_versions already said so, but noted "the schema
 *   alone can't express 'immutable after this timestamp is set'" -- a
 *   trigger can). Once `published_at` is set, every behavior-defining
 *   column is frozen (schemas, handler, execution mode, duration, meter/
 *   entitlement keys, compatibility metadata, immutable_hash, and
 *   published_at itself, plus tool_id/version identity). `deprecated_at`/
 *   `retired_at` stay updatable after publish -- lifecycle metadata for a
 *   deprecate/retire mutator that doesn't exist yet, not version
 *   behavior -- so this doesn't need revisiting when that's built.
 * - "Every run references an immutable routing-decision record" --
 *   relay.routing_decisions is revoked the same way relay.audit_events
 *   and relay.schema_migrations were: relay_app keeps INSERT/SELECT,
 *   loses UPDATE/DELETE.
 */
const CANONICAL_SQL = `
create function relay.reject_tool_version_mutation_after_publish()
returns trigger as $$
begin
  if OLD.published_at is not null and (
    NEW.tool_id is distinct from OLD.tool_id or
    NEW.version is distinct from OLD.version or
    NEW.input_schema is distinct from OLD.input_schema or
    NEW.output_schema is distinct from OLD.output_schema or
    NEW.handler_key is distinct from OLD.handler_key or
    NEW.execution_mode is distinct from OLD.execution_mode or
    NEW.max_duration_seconds is distinct from OLD.max_duration_seconds or
    NEW.meter_policy_id is distinct from OLD.meter_policy_id or
    NEW.entitlement_key is distinct from OLD.entitlement_key or
    NEW.compatibility_metadata is distinct from OLD.compatibility_metadata or
    NEW.immutable_hash is distinct from OLD.immutable_hash or
    NEW.published_at is distinct from OLD.published_at
  ) then
    raise exception 'relay.tool_versions "%" is published and immutable (only deprecated_at/retired_at may still change)', OLD.id;
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger tool_versions_immutable_after_publish
  before update on relay.tool_versions
  for each row execute function relay.reject_tool_version_mutation_after_publish();

revoke update, delete on relay.routing_decisions from relay_app;
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0018_tool_version_and_routing_immutability",
  checksumSha256:
    "bc5bc97ffe87d266107b1be6eb837c3e18f135b6c7a042c35a58ac4a2fb5f74a",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
