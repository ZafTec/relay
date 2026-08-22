import { assertEquals } from "@std/assert";
import pg from "pg";
import {
  CANONICAL_SQL,
  migration,
} from "./0022_tool_version_delete_and_routing_policy_immutability.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test(
  "0022_tool_version_delete_and_routing_policy_immutability checksum matches its canonical SQL",
  async () => {
    assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
  },
);

const databaseUrl = Deno.env.get("DATABASE_URL");

Deno.test({
  name: "relay_app cannot update or delete relay.routing_policies",
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
      }>(
        `select
           has_table_privilege('relay_app', 'relay.routing_policies', 'UPDATE') as can_update,
           has_table_privilege('relay_app', 'relay.routing_policies', 'DELETE') as can_delete,
           has_table_privilege('relay_app', 'relay.routing_policies', 'INSERT') as can_insert`,
      );
      assertEquals(rows[0].can_update, false);
      assertEquals(rows[0].can_delete, false);
      assertEquals(rows[0].can_insert, true);
    } finally {
      await client.end();
    }
  },
});
