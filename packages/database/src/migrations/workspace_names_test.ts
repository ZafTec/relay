import { assertEquals } from "@std/assert";
import pg from "pg";
import { personalWorkspaceSlug } from "../../../auth/src/workspaces.ts";
import { CANONICAL_SQL, migration } from "./0007_workspace_names.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("workspace naming migration retains its canonical checksum", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});

const url = Deno.env.get("AUTH_SECURITY_TEST_DATABASE_URL");
Deno.test({
  name:
    "workspace naming migration changes only legacy generated identifiers and handles collisions",
  ignore: !url,
  fn: async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query("begin");
    try {
      await client.query("set local role relay_owner");
      const suffix = crypto.randomUUID();
      const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
      const users = ids.map((_, index) =>
        `workspace-migration-${suffix}-${index}`
      );
      for (let index = 0; index < ids.length; index++) {
        await client.query(
          'insert into auth."user"(id,name,email,"emailVerified") values($1,$1,$2,true)',
          [users[index], `${users[index]}@example.test`],
        );
        const oldSlug = "personal-" +
          (await sha256Hex(`relay-personal-workspace:${users[index]}`)).slice(
            0,
            32,
          );
        await client.query(
          'insert into auth.organization(id,name,slug,"createdAt") values($1,$2,$3,now())',
          [
            ids[index],
            index === 1 ? "Custom research" : "Personal",
            index === 2 ? `custom-${suffix}` : oldSlug,
          ],
        );
        await client.query(
          "insert into relay.personal_workspaces(user_id,organization_id) values($1,$2)",
          [users[index], ids[index]],
        );
        await client.query(
          'insert into auth.member(id,"organizationId","userId",role,"createdAt") values(gen_random_uuid()::text,$1,$2,\'owner\',now())',
          [ids[index], users[index]],
        );
      }
      const proposed = await personalWorkspaceSlug(users[0]);
      await client.query(
        "insert into auth.organization(id,name,slug,\"createdAt\") values($1,'Already reserved',$2,now())",
        [crypto.randomUUID(), proposed],
      );
      await client.query(CANONICAL_SQL);
      const rows: { id: string; name: string; slug: string }[] =
        (await client.query(
          "select id,name,slug from auth.organization where id=any($1::text[])",
          [ids],
        )).rows;
      assertEquals(
        rows.find((row) => row.id === ids[0])?.slug,
        `${proposed}-2`,
      );
      assertEquals(
        rows.find((row) => row.id === ids[0])?.name === "Personal",
        false,
      );
      assertEquals(
        rows.find((row) => row.id === ids[1])?.name,
        "Custom research",
      );
      assertEquals(
        rows.find((row) => row.id === ids[1])?.slug,
        await personalWorkspaceSlug(users[1]),
      );
      assertEquals(rows.find((row) => row.id === ids[2]), {
        id: ids[2],
        name: "Personal",
        slug: `custom-${suffix}`,
      });
      assertEquals(
        (await client.query(
          "select count(*)::integer as count from auth.member where \"organizationId\"=any($1::text[]) and role='owner'",
          [ids],
        )).rows[0].count,
        3,
      );
      assertEquals(
        (await client.query(
          "select id from relay.entitlement_grants where workspace_id=any($1::text[])",
          [ids],
        )).rowCount,
        0,
      );
      await client.query(CANONICAL_SQL);
      assertEquals(
        (await client.query(
          "select count(*)::integer as count from relay.audit_events where action='workspace.readable_identifier' and target_id=any($1::text[])",
          [ids],
        )).rows[0].count,
        2,
      );
    } finally {
      await client.query("rollback");
      await client.end();
    }
  },
});
