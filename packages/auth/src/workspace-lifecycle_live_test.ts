import { assert, assertEquals, assertRejects } from "@std/assert";
import { createDatabasePool } from "@relay/database";
import { admitToolRun } from "@relay/queue";
import {
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
  TEST_USAGE_PORT,
} from "../../queue/src/test_support.ts";
import {
  createManagedWorkspace,
  deleteManagedWorkspace,
  listManagedWorkspaces,
  updateManagedWorkspace,
  WorkspaceManagementError,
} from "./workspace-management.ts";
import { ensurePersonalWorkspace } from "./workspaces.ts";

const url = Deno.env.get("DATABASE_URL");
Deno.test({
  name:
    "workspace owners manage logos and deletion while personal workspaces, active runs and immutable handles stay protected",
  ignore: !url,
  fn: async () => {
    const pool = createDatabasePool({
      url: new URL(url!),
      poolMax: 5,
      connectTimeoutMs: 5000,
      statementTimeoutMs: 10000,
    }, "relay-api");
    const fixture = await createAdmissibleFixture(pool);
    const session = `lifecycle-${crypto.randomUUID()}`;
    const foreignSession = `lifecycle-${crypto.randomUUID()}`;
    try {
      for (
        const [id, user] of [[session, fixture.createdBy], [
          foreignSession,
          fixture.catalogActorIds[0],
        ]]
      ) {
        await pool.query(
          'insert into auth.session(id,"userId",token,"expiresAt","createdAt","updatedAt") values($1,$2,$1,now()+interval \'1 day\',now(),now())',
          [id, user],
        );
      }
      const personal = await ensurePersonalWorkspace(pool, fixture.createdBy);
      const personalDetails = (await listManagedWorkspaces(pool, session)).find(
        (item) => item.id === personal,
      )!;
      await assertRejects(
        () =>
          deleteManagedWorkspace(pool, session, personal, personalDetails.slug),
        WorkspaceManagementError,
        "personal_workspace",
      );
      const key = crypto.randomUUID();
      const details = { name: "Shared design", slug: `design-${key}` };
      const { workspace } = await createManagedWorkspace(
        pool,
        session,
        details,
        key,
      );
      const logo = "https://images.example.test/team.png";
      assertEquals(
        (await updateManagedWorkspace(pool, session, workspace.id, {
          ...details,
          logo,
        })).logo,
        logo,
      );
      assertEquals(
        (await updateManagedWorkspace(pool, session, workspace.id, {
          ...details,
          name: "Design team",
        })).logo,
        logo,
      );
      assertEquals(
        (await updateManagedWorkspace(pool, session, workspace.id, {
          ...details,
          logo: null,
        })).logo,
        null,
      );
      await assertRejects(
        () =>
          pool.query(
            "update auth.organization set slug='another-handle' where id=$1",
            [workspace.id],
          ),
        Error,
        "handles cannot change",
      );
      await assertRejects(
        () =>
          deleteManagedWorkspace(
            pool,
            foreignSession,
            workspace.id,
            details.slug,
          ),
        WorkspaceManagementError,
        "not_found",
      );
      await assertRejects(
        () => deleteManagedWorkspace(pool, session, workspace.id, "wrong"),
        WorkspaceManagementError,
        "confirmation_required",
      );
      await pool.query(
        'update auth.session set "activeOrganizationId"=$2 where id=$1',
        [session, workspace.id],
      );
      await deleteManagedWorkspace(pool, session, workspace.id, details.slug);
      await deleteManagedWorkspace(pool, session, workspace.id, details.slug);
      assertEquals(
        (await listManagedWorkspaces(pool, session)).some((item) =>
          item.id === workspace.id
        ),
        false,
      );
      assertEquals(
        (await pool.query(
          'select "activeOrganizationId" from auth.session where id=$1',
          [session],
        )).rows[0].activeOrganizationId,
        personal,
      );
      await assertRejects(
        () => createManagedWorkspace(pool, session, details, key),
        WorkspaceManagementError,
        "idempotency_conflict",
      );
      await assertRejects(
        () =>
          pool.query(
            'update auth.organization set "deletedAt"=null where id=$1',
            [workspace.id],
          ),
        Error,
        "deletion is permanent",
      );
      const admitted = await admitToolRun(pool, {
        workspaceId: fixture.workspaceId,
        toolVersionId: fixture.toolVersionId,
        createdBy: fixture.createdBy,
        input: { prompt: "active run" },
        idempotencyKey: crypto.randomUUID(),
        admissionDeadlineMs: 60000,
        runDeadlineMs: 300000,
      }, { handlers: fixture.handlers, usage: TEST_USAGE_PORT });
      assert(admitted.kind === "admitted");
      await pool.query(
        'update auth.member set role=\'owner\' where "organizationId"=$1 and "userId"=$2',
        [fixture.workspaceId, fixture.createdBy],
      );
      const active = (await listManagedWorkspaces(pool, session)).find((item) =>
        item.id === fixture.workspaceId
      )!;
      await assertRejects(
        () =>
          deleteManagedWorkspace(
            pool,
            session,
            fixture.workspaceId,
            active.slug,
          ),
        WorkspaceManagementError,
        "workspace_busy",
      );
    } finally {
      await pool.query("delete from auth.session where id=any($1::text[])", [[
        session,
        foreignSession,
      ]]);
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});
