import { assertEquals } from "@std/assert";
import pg from "pg";
import {
  CANONICAL_SQL,
  migration,
} from "./0018_tool_version_and_routing_immutability.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test(
  "0018_tool_version_and_routing_immutability checksum matches its canonical SQL",
  async () => {
    assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
  },
);

/**
 * Live-PostgreSQL check that this migration's `revoke` actually took
 * effect for relay_app, the same way migrator_test.ts verifies the
 * relay.schema_migrations revoke -- a checksum match alone only proves
 * the SQL text is what it always was, not that it ran successfully
 * against a real database. Gated behind DATABASE_URL like the rest of
 * the repo's live-database tests; the tool_versions immutability trigger
 * itself is exercised in packages/catalog/src/tools_test.ts, which
 * already has the fixture chain (a real published version) this would
 * otherwise have to duplicate.
 */
const databaseUrl = Deno.env.get("DATABASE_URL");

Deno.test({
  name: "relay_app cannot update or delete relay.routing_decisions",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const url = new URL(databaseUrl!);
    url.username = "relay_app";
    url.password = "relay_dev_only";
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const { rows } = await client.query<{
        can_update: boolean;
        can_delete: boolean;
        can_insert: boolean;
        can_select: boolean;
      }>(
        `select
           has_table_privilege('relay_app', 'relay.routing_decisions', 'UPDATE') as can_update,
           has_table_privilege('relay_app', 'relay.routing_decisions', 'DELETE') as can_delete,
           has_table_privilege('relay_app', 'relay.routing_decisions', 'INSERT') as can_insert,
           has_table_privilege('relay_app', 'relay.routing_decisions', 'SELECT') as can_select`,
      );
      assertEquals(rows[0].can_update, false);
      assertEquals(rows[0].can_delete, false);
      assertEquals(rows[0].can_insert, true);
      assertEquals(rows[0].can_select, true);
    } finally {
      await client.end();
    }
  },
});
