import { assertEquals, assertRejects } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import {
  grantSuperadmin,
  isSuperadmin,
  revokeSuperadmin,
} from "./system-roles.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const hasDatabase = databaseUrl !== undefined;

function testPool(): DatabasePool {
  return createDatabasePool(
    {
      url: new URL(databaseUrl!),
      poolMax: 5,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
    },
    "relay-api",
  );
}

function unique(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

async function createUser(pool: DatabasePool, label: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into auth."user" (id, name, email, "emailVerified")
     values (gen_random_uuid()::text, 'Test', $1, true)
     returning id`,
    [`${unique(label)}@example.com`],
  );
  return result.rows[0].id;
}

/**
 * Deletes only the users this test created -- not a blanket
 * `delete from auth."user"`. See authorization_test.ts's `cleanup` for
 * why: this package's live tests share one database with
 * packages/catalog's and packages/queue's, and a full-table wipe here
 * really did delete rows a concurrently running test elsewhere still
 * depended on once `deno task check:live` started running everything
 * together. `relay.audit_events.actor_user_id` is `on delete set null`
 * (the audit trail outlives the account, per
 * 0005_audit_events.ts), so deleting these users never touches the
 * audit rows the tests below assert against.
 */
async function cleanup(
  pool: DatabasePool,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of userIds) {
    await pool.query('delete from auth."user" where id = $1', [userId]);
  }
}

Deno.test({
  name: "a user with no grant is not superadmin",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool, "nobody");
      assertEquals(await isSuperadmin(pool, userId), false);
    } finally {
      await cleanup(pool, userId ? [userId] : []);
      await pool.end();
    }
  },
});

Deno.test({
  name: "granting superadmin takes effect immediately",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    let operatorId: string | undefined;
    try {
      userId = await createUser(pool, "grantee");
      operatorId = await createUser(pool, "operator");

      await grantSuperadmin(pool, userId, operatorId);
      assertEquals(await isSuperadmin(pool, userId), true);
    } finally {
      await cleanup(
        pool,
        [userId, operatorId].filter((id): id is string => id !== undefined),
      );
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "revoking superadmin takes effect immediately, without waiting for expiry",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    let operatorId: string | undefined;
    try {
      userId = await createUser(pool, "revokee");
      operatorId = await createUser(pool, "operator");

      await grantSuperadmin(pool, userId, operatorId);
      assertEquals(await isSuperadmin(pool, userId), true);

      await revokeSuperadmin(pool, userId, operatorId);
      assertEquals(await isSuperadmin(pool, userId), false);
    } finally {
      await cleanup(
        pool,
        [userId, operatorId].filter((id): id is string => id !== undefined),
      );
      await pool.end();
    }
  },
});

Deno.test({
  name: "grant and revoke each record exactly one durable audit event",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    let operatorId: string | undefined;
    try {
      userId = await createUser(pool, "audited");
      operatorId = await createUser(pool, "operator");

      await grantSuperadmin(pool, userId, operatorId);
      await revokeSuperadmin(pool, userId, operatorId);

      const events = await pool.query<
        { action: string; target_id: string; actor_user_id: string }
      >(
        `select action, target_id, actor_user_id from relay.audit_events
         where target_id = $1 order by occurred_at asc`,
        [userId],
      );

      assertEquals(events.rows.length, 2);
      assertEquals(events.rows[0].action, "system_role.superadmin.grant");
      assertEquals(events.rows[1].action, "system_role.superadmin.revoke");
      assertEquals(events.rows[0].actor_user_id, operatorId);
    } finally {
      await cleanup(
        pool,
        [userId, operatorId].filter((id): id is string => id !== undefined),
      );
      await pool.end();
    }
  },
});

Deno.test({
  name: "relay_app cannot update or delete audit events",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    let operatorId: string | undefined;
    try {
      userId = await createUser(pool, "immutable");
      operatorId = await createUser(pool, "operator");
      await grantSuperadmin(pool, userId, operatorId);

      await assertRejects(
        () =>
          pool.query(
            "update relay.audit_events set outcome = 'failure' where target_id = $1",
            [userId],
          ),
        Error,
      );
      await assertRejects(
        () =>
          pool.query(
            "delete from relay.audit_events where target_id = $1",
            [userId],
          ),
        Error,
      );
    } finally {
      await cleanup(
        pool,
        [userId, operatorId].filter((id): id is string => id !== undefined),
      );
      await pool.end();
    }
  },
});
