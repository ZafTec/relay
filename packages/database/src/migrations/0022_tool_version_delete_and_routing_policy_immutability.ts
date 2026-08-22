import { sql } from "kysely";
import type { Migration } from "./types.ts";

/**
 * Two more gaps in "immutable once written" invariants this database
 * already asserts elsewhere:
 *
 * - 0018_tool_version_and_routing_immutability.ts's trigger only fires
 *   `before update`, so a published `relay.tool_versions` row could
 *   still be deleted outright -- erasing, not just failing to mutate,
 *   the exact "immutable once published" record that trigger exists to
 *   protect. A sibling `before delete` trigger closes that.
 * - `relay.routing_policies`'s own comment already says "Revisions are
 *   immutable," matching `relay.routing_decisions`'s "immutable
 *   routing-decision record" -- but only `routing_decisions` actually
 *   got the `revoke update, delete` that makes it true at the database
 *   level. `routing_policies` never did.
 */
const CANONICAL_SQL = `
create function relay.reject_tool_version_deletion_after_publish()
returns trigger as $$
begin
  if OLD.published_at is not null then
    raise exception 'relay.tool_versions "%" is published and immutable (cannot be deleted)', OLD.id;
  end if;
  return OLD;
end;
$$ language plpgsql;

create trigger tool_versions_immutable_delete_after_publish
  before delete on relay.tool_versions
  for each row execute function relay.reject_tool_version_deletion_after_publish();

revoke update, delete on relay.routing_policies from relay_app;
`.trim();

export { CANONICAL_SQL };

export const migration: Migration = {
  id: "0022_tool_version_delete_and_routing_policy_immutability",
  checksumSha256:
    "9aac921db3b64c994179cc64227033d708017e659cedc97bb6b187c3ed2de512",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
