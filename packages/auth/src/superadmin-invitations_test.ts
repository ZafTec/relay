import { assertEquals, assertRejects } from "@std/assert";
import pg from "pg";

const url = Deno.env.get("AUTH_SECURITY_TEST_DATABASE_URL");
Deno.test({
  name:
    "superadmin invitations enforce verified email, freshness, expiry, revocation and atomic audit",
  ignore: !url,
  fn: async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query("begin");
    try {
      await client.query("set local role relay_owner");
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const admin = `invite-admin-${suffix}`;
      const target = `invite-target-${suffix}`;
      const other = `invite-other-${suffix}`;
      for (const id of [admin, target, other]) {
        await client.query(
          'insert into auth."user" (id,name,email,"emailVerified") values ($1,$1,$2,true)',
          [id, `${id}@example.test`],
        );
        await client.query(
          'insert into auth."session" (id,"userId",token,"expiresAt","createdAt","updatedAt") values ($1,$2,$1,now()+interval \'1 day\',now(),now())',
          [`session-${id}`, id],
        );
      }
      await client.query(
        "insert into relay.system_role_assignments(user_id,role,granted_by) values ($1,'superadmin',$1)",
        [admin],
      );
      const invitation = `sinv_${suffix}`;
      const reject = async (code: string, sql: string, args: unknown[]) => {
        await client.query("savepoint expected_rejection");
        const error = await assertRejects(() => client.query(sql, args));
        assertEquals((error as { code: string }).code, code);
        await client.query("rollback to savepoint expected_rejection");
      };
      const create =
        "select relay.create_superadmin_invitation($1,$2,$3) as value";
      const accept =
        "select relay.accept_superadmin_invitation($1,$2,$3) as value";
      await reject("42501", create, [
        `session-${other}`,
        invitation,
        `${target}@example.test`,
      ]);
      assertEquals(
        (await client.query(
          "select has_table_privilege('relay_app','relay.superadmin_invitations','INSERT') as allowed",
        )).rows[0].allowed,
        false,
      );
      const result = await client.query(create, [
        `session-${admin}`,
        invitation,
        `${target}@example.test`,
      ]);
      assertEquals(result.rows[0].value.email, `${target}@example.test`);
      await client.query(create, [
        `session-${admin}`,
        invitation,
        `${target}@example.test`,
      ]);
      await reject("RG001", create, [
        `session-${admin}`,
        invitation,
        `${other}@example.test`,
      ]);
      await reject("RA404", accept, [`session-${other}`, invitation, true]);
      assertEquals(
        (await client.query(accept, [`session-${target}`, invitation, false]))
          .rows[0].value.accepted,
        false,
      );
      assertEquals(
        (await client.query(
          "select 1 from relay.system_role_assignments where user_id=$1 and revoked_at is null",
          [target],
        )).rowCount,
        0,
      );
      await client.query("set local role relay_owner");
      await client.query(
        'update auth."user" set "emailVerified"=false where id=$1',
        [target],
      );
      await reject("28000", accept, [`session-${target}`, invitation, true]);
      await client.query("set local role relay_owner");
      await client.query(
        'update auth."user" set "emailVerified"=true where id=$1',
        [target],
      );
      await client.query(
        'update auth."session" set "createdAt"=now()-interval \'16 minutes\' where id=$1',
        [`session-${target}`],
      );
      await reject("55000", accept, [`session-${target}`, invitation, true]);
      await client.query("set local role relay_owner");
      await client.query(
        'update auth."session" set "createdAt"=now() where id=$1',
        [`session-${target}`],
      );
      await client.query(
        "update relay.superadmin_invitations set expires_at=now()-interval '1 second' where id=$1",
        [invitation],
      );
      await reject("RA404", accept, [`session-${target}`, invitation, true]);
      await client.query("set local role relay_owner");
      await client.query(
        "update relay.superadmin_invitations set expires_at=now()+interval '1 day' where id=$1",
        [invitation],
      );
      assertEquals(
        (await client.query(accept, [`session-${target}`, invitation, true]))
          .rows[0].value.accepted,
        true,
      );
      await client.query(accept, [`session-${target}`, invitation, true]);
      assertEquals(
        (await client.query(
          "select 1 from relay.system_role_assignments where user_id=$1 and revoked_at is null",
          [target],
        )).rowCount,
        1,
      );
      const audits = await client.query(
        "select action from relay.audit_events where target_id=$1 order by id",
        [invitation],
      );
      assertEquals(audits.rows.map((row: { action: string }) => row.action), [
        "system_role.invitation.create",
        "system_role.invitation.accept",
      ]);
      const another = `sinv_${crypto.randomUUID().replaceAll("-", "")}`;
      await client.query(create, [
        `session-${admin}`,
        another,
        `${other}@example.test`,
      ]);
      await client.query("select relay.revoke_superadmin_invitation($1,$2)", [
        `session-${admin}`,
        another,
      ]);
      await reject("RA404", accept, [`session-${other}`, another, true]);
      const invalidated = `sinv_${crypto.randomUUID().replaceAll("-", "")}`;
      await client.query(create, [
        `session-${admin}`,
        invalidated,
        `${other}@example.test`,
      ]);
      await client.query(
        "update relay.system_role_assignments set revoked_at=now(),revoked_by=$1 where user_id=$1 and revoked_at is null",
        [admin],
      );
      await reject("RA404", accept, [`session-${other}`, invalidated, true]);
      // A replay cannot restore an independently revoked administrator role.
      await client.query("set local role relay_owner");
      await client.query(
        "update relay.system_role_assignments set revoked_at=now(),revoked_by=$1 where user_id=$2 and revoked_at is null",
        [admin, target],
      );
      await client.query(accept, [`session-${target}`, invitation, true]);
      assertEquals(
        (await client.query(
          "select 1 from relay.system_role_assignments where user_id=$1 and revoked_at is null",
          [target],
        )).rowCount,
        0,
      );
    } finally {
      await client.query("rollback");
      await client.end();
    }
  },
});
