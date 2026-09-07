import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createDatabasePool } from "@relay/database";
import {
  createManagedWorkspace,
  listManagedWorkspaces,
  parseWorkspaceDetails,
  proposeWorkspaceDetails,
  updateManagedWorkspace,
  WorkspaceManagementError,
} from "./workspace-management.ts";
import {
  ensurePersonalWorkspace,
  suggestWorkspaceDetails,
} from "./workspaces.ts";

Deno.test("workspace labels are editable bounded text, and cannot carry privilege fields", () => {
  assertEquals(
    parseWorkspaceDetails({ name: "  Studio North  ", slug: "STUDIO-NORTH" }),
    {
      name: "Studio North",
      slug: "studio-north",
    },
  );
  for (
    const value of [
      null,
      [],
      {},
      { name: "x", slug: "studio" },
      { name: "Studio", slug: "../admin" },
      { name: "Studio", slug: "two--hyphens" },
      { name: "Studio\nNorth", slug: "studio" },
      { name: "Studio", slug: "studio", role: "owner" },
    ]
  ) assertThrows(() => parseWorkspaceDetails(value), WorkspaceManagementError);
  const proposed = suggestWorkspaceDetails();
  assertEquals(/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(proposed.name), true);
  assertEquals(/^[a-z]+-[a-z]+-\d{4}$/.test(proposed.slug), true);
});

const url = Deno.env.get("DATABASE_URL");
Deno.test({
  name:
    "workspace creation, retries and renaming preserve membership and explicit allowances",
  ignore: !url,
  fn: async () => {
    const pool = createDatabasePool({
      url: new URL(url!),
      poolMax: 5,
      connectTimeoutMs: 5000,
      statementTimeoutMs: 30000,
    }, "relay-api");
    const suffix = crypto.randomUUID();
    const users = [`workspace-owner-${suffix}`, `workspace-other-${suffix}`];
    const sessions = users.map((user) => `session-${user}`);
    const organizations: string[] = [];
    try {
      for (let index = 0; index < users.length; index++) {
        await pool.query(
          'insert into auth."user"(id,name,email,"emailVerified") values($1,$1,$2,true)',
          [users[index], `${users[index]}@example.test`],
        );
        await pool.query(
          'insert into auth.session(id,"userId",token,"expiresAt","createdAt","updatedAt") values($1,$2,$1,now()+interval \'1 day\',now(),now())',
          [sessions[index], users[index]],
        );
      }
      const personalId = await ensurePersonalWorkspace(pool, users[0]);
      organizations.push(personalId);
      const proposed = await proposeWorkspaceDetails(pool, sessions[0]);
      assertEquals(/^[a-z]+-[a-z]+-\d{4}$/.test(proposed.slug), true);
      const details = { name: "Shared studio", slug: `studio-${suffix}` };
      const [created, retried] = await Promise.all([
        createManagedWorkspace(pool, sessions[0], details, `create-${suffix}`),
        createManagedWorkspace(pool, sessions[0], details, `create-${suffix}`),
      ]);
      organizations.push(created.workspace.id);
      assertEquals(created.workspace.id, retried.workspace.id);
      assertEquals([created.replayed, retried.replayed].sort(), [false, true]);
      assertEquals(created.workspace.role, "owner");
      assertEquals(created.workspace.personal, false);
      assertEquals(
        (await pool.query(
          "select id from relay.entitlement_grants where workspace_id=$1",
          [created.workspace.id],
        )).rows,
        [],
      );
      const list = await listManagedWorkspaces(pool, sessions[0]);
      assertEquals(list.length, 2);
      assertEquals(list.find((item) => item.id === personalId)?.personal, true);
      assertEquals(await listManagedWorkspaces(pool, sessions[1]), []);

      await assertRejects(
        () =>
          createManagedWorkspace(pool, sessions[0], {
            ...details,
            name: "Changed retry",
          }, `create-${suffix}`),
        WorkspaceManagementError,
        "idempotency_conflict",
      );
      await assertRejects(
        () =>
          createManagedWorkspace(pool, sessions[1], details, `other-${suffix}`),
        WorkspaceManagementError,
        "slug_taken",
      );
      await assertRejects(
        () =>
          updateManagedWorkspace(
            pool,
            sessions[1],
            created.workspace.id,
            details,
          ),
        WorkspaceManagementError,
        "not_found",
      );
      await pool.query(
        'insert into auth.member(id,"organizationId","userId",role,"createdAt") values(gen_random_uuid()::text,$1,$2,\'member\',now())',
        [created.workspace.id, users[1]],
      );
      await assertRejects(
        () =>
          updateManagedWorkspace(
            pool,
            sessions[1],
            created.workspace.id,
            details,
          ),
        WorkspaceManagementError,
        "owner_required",
      );
      const renamed = await updateManagedWorkspace(
        pool,
        sessions[0],
        created.workspace.id,
        { name: "North studio", slug: `north-${suffix}` },
      );
      assertEquals(renamed.id, created.workspace.id);
      assertEquals(renamed.slug, `north-${suffix}`);
      assertEquals(
        (await pool.query(
          'select role from auth.member where "organizationId"=$1 order by role',
          [renamed.id],
        )).rows,
        [{ role: "member" }, { role: "owner" }],
      );
      const personal = await updateManagedWorkspace(
        pool,
        sessions[0],
        personalId,
        { name: "My research", slug: `research-${suffix}` },
      );
      assertEquals(personal.personal, true);
      assertEquals(await ensurePersonalWorkspace(pool, users[0]), personalId);
      assertEquals(
        (await pool.query(
          "select name,slug from auth.organization where id=$1",
          [personalId],
        )).rows,
        [{ name: "My research", slug: `research-${suffix}` }],
      );
      await assertRejects(
        () =>
          updateManagedWorkspace(pool, sessions[0], personalId, {
            name: "Collision",
            slug: renamed.slug,
          }),
        WorkspaceManagementError,
        "slug_taken",
      );
      assertEquals(
        (await pool.query(
          "select id from relay.entitlement_grants where workspace_id=any($1::text[])",
          [organizations],
        )).rows,
        [],
      );
      assertEquals(
        (await pool.query(
          "select action from relay.audit_events where target_id=$1 order by id",
          [created.workspace.id],
        )).rows,
        [{ action: "workspace.create" }, { action: "workspace.update" }],
      );
      await pool.query(
        "update auth.session set \"expiresAt\"=now()-interval '1 second' where id=$1",
        [sessions[0]],
      );
      await assertRejects(
        () => listManagedWorkspaces(pool, sessions[0]),
        WorkspaceManagementError,
        "unauthenticated",
      );
      await pool.query(
        'update auth."user" set "emailVerified"=false where id=$1',
        [users[1]],
      );
      await assertRejects(
        () =>
          createManagedWorkspace(pool, sessions[1], {
            name: "Unverified",
            slug: `other-${suffix}`,
          }, `unverified-${suffix}`),
        WorkspaceManagementError,
        "unauthenticated",
      );
    } finally {
      await pool.query(
        "delete from auth.organization where id=any($1::text[])",
        [organizations],
      );
      await pool.query('delete from auth."user" where id=any($1::text[])', [
        users,
      ]);
      await pool.end();
    }
  },
});
