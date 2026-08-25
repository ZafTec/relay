import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { canRemoveMember, getMembership } from "./authorization.ts";

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

async function createOrganization(
  pool: DatabasePool,
  label: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into auth.organization (id, name, slug, "createdAt")
     values (gen_random_uuid()::text, 'Test Org', $1, now())
     returning id`,
    [unique(label)],
  );
  return result.rows[0].id;
}

async function addMember(
  pool: DatabasePool,
  organizationId: string,
  userId: string,
  role: string,
): Promise<void> {
  await pool.query(
    `insert into auth.member (id, "organizationId", "userId", role, "createdAt")
     values (gen_random_uuid()::text, $1, $2, $3, now())`,
    [organizationId, userId, role],
  );
}

/**
 * Deletes only the rows this test created -- not a blanket
 * `delete from auth."user"`/`auth.organization`. This package's live
 * tests share one database with packages/catalog's and packages/queue's;
 * a full-table wipe at test start really did delete rows a concurrently
 * running test elsewhere still depended on once `deno task check:live`
 * started running everything together. Organization deletion cascades
 * to `auth.member`; user deletion cascades to `auth.member` and
 * `relay.personal_workspaces` too, but nothing here creates the latter
 * (these tests insert membership rows directly, not through
 * `ensurePersonalWorkspace`).
 */
async function cleanup(
  pool: DatabasePool,
  ids: { userIds?: readonly string[]; organizationIds?: readonly string[] },
): Promise<void> {
  for (const organizationId of ids.organizationIds ?? []) {
    await pool.query("delete from auth.organization where id = $1", [
      organizationId,
    ]);
  }
  for (const userId of ids.userIds ?? []) {
    await pool.query('delete from auth."user" where id = $1', [userId]);
  }
}

Deno.test({
  name:
    "getMembership returns null for a client-supplied workspace the user does not belong to",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    let organizationId: string | undefined;
    try {
      userId = await createUser(pool, "outsider");
      organizationId = await createOrganization(pool, "someone-elses");

      assertEquals(await getMembership(pool, organizationId, userId), null);
    } finally {
      await cleanup(pool, {
        userIds: userId ? [userId] : [],
        organizationIds: organizationId ? [organizationId] : [],
      });
      await pool.end();
    }
  },
});

Deno.test({
  name: "getMembership returns the actual role for a real member",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    let organizationId: string | undefined;
    try {
      userId = await createUser(pool, "member");
      organizationId = await createOrganization(pool, "real-org");
      await addMember(pool, organizationId, userId, "admin");

      assertEquals(
        await getMembership(pool, organizationId, userId),
        "admin",
      );
    } finally {
      await cleanup(pool, {
        userIds: userId ? [userId] : [],
        organizationIds: organizationId ? [organizationId] : [],
      });
      await pool.end();
    }
  },
});

Deno.test({
  name: "canRemoveMember allows removing a non-owner",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let organizationId: string | undefined;
    try {
      organizationId = await createOrganization(pool, "org-a");
      assertEquals(await canRemoveMember(pool, organizationId, "member"), true);
      assertEquals(await canRemoveMember(pool, organizationId, "admin"), true);
    } finally {
      await cleanup(pool, {
        organizationIds: organizationId ? [organizationId] : [],
      });
      await pool.end();
    }
  },
});

Deno.test({
  name: "canRemoveMember refuses to remove the last owner",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    let organizationId: string | undefined;
    try {
      userId = await createUser(pool, "sole-owner");
      organizationId = await createOrganization(pool, "org-b");
      await addMember(pool, organizationId, userId, "owner");

      assertEquals(
        await canRemoveMember(pool, organizationId, "owner"),
        false,
      );
    } finally {
      await cleanup(pool, {
        userIds: userId ? [userId] : [],
        organizationIds: organizationId ? [organizationId] : [],
      });
      await pool.end();
    }
  },
});

Deno.test({
  name: "canRemoveMember allows removing an owner when a second owner exists",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let ownerA: string | undefined;
    let ownerB: string | undefined;
    let organizationId: string | undefined;
    try {
      ownerA = await createUser(pool, "owner-a");
      ownerB = await createUser(pool, "owner-b");
      organizationId = await createOrganization(pool, "org-c");
      await addMember(pool, organizationId, ownerA, "owner");
      await addMember(pool, organizationId, ownerB, "owner");

      assertEquals(
        await canRemoveMember(pool, organizationId, "owner"),
        true,
      );
    } finally {
      await cleanup(pool, {
        userIds: [ownerA, ownerB].filter((id): id is string =>
          id !== undefined
        ),
        organizationIds: organizationId ? [organizationId] : [],
      });
      await pool.end();
    }
  },
});
