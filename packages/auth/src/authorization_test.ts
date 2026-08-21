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

async function reset(pool: DatabasePool): Promise<void> {
  await pool.query('delete from auth."user"');
  await pool.query("delete from auth.organization");
}

async function createUser(pool: DatabasePool, email: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into auth."user" (id, name, email, "emailVerified")
     values (gen_random_uuid()::text, 'Test', $1, true)
     returning id`,
    [email],
  );
  return result.rows[0].id;
}

async function createOrganization(
  pool: DatabasePool,
  slug: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into auth.organization (id, name, slug, "createdAt")
     values (gen_random_uuid()::text, 'Test Org', $1, now())
     returning id`,
    [slug],
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

Deno.test({
  name:
    "getMembership returns null for a client-supplied workspace the user does not belong to",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      await reset(pool);
      const userId = await createUser(pool, "outsider@example.com");
      const organizationId = await createOrganization(pool, "someone-elses");

      assertEquals(await getMembership(pool, organizationId, userId), null);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "getMembership returns the actual role for a real member",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      await reset(pool);
      const userId = await createUser(pool, "member@example.com");
      const organizationId = await createOrganization(pool, "real-org");
      await addMember(pool, organizationId, userId, "admin");

      assertEquals(
        await getMembership(pool, organizationId, userId),
        "admin",
      );
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "canRemoveMember allows removing a non-owner",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      await reset(pool);
      const organizationId = await createOrganization(pool, "org-a");
      assertEquals(await canRemoveMember(pool, organizationId, "member"), true);
      assertEquals(await canRemoveMember(pool, organizationId, "admin"), true);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "canRemoveMember refuses to remove the last owner",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      await reset(pool);
      const owner = await createUser(pool, "sole-owner@example.com");
      const organizationId = await createOrganization(pool, "org-b");
      await addMember(pool, organizationId, owner, "owner");

      assertEquals(
        await canRemoveMember(pool, organizationId, "owner"),
        false,
      );
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "canRemoveMember allows removing an owner when a second owner exists",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      await reset(pool);
      const ownerA = await createUser(pool, "owner-a@example.com");
      const ownerB = await createUser(pool, "owner-b@example.com");
      const organizationId = await createOrganization(pool, "org-c");
      await addMember(pool, organizationId, ownerA, "owner");
      await addMember(pool, organizationId, ownerB, "owner");

      assertEquals(
        await canRemoveMember(pool, organizationId, "owner"),
        true,
      );
    } finally {
      await pool.end();
    }
  },
});
