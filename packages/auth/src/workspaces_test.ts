import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import {
  ensurePersonalWorkspace,
  personalWorkspaceSlug,
} from "./workspaces.ts";

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

async function createUser(pool: DatabasePool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth."user" (id, name, email, "emailVerified")
     values (gen_random_uuid()::text, 'Test', $1, true)
     returning id`,
    [`${unique("user")}@example.com`],
  );
  return rows[0].id;
}

async function cleanup(pool: DatabasePool, userId: string): Promise<void> {
  const { rows } = await pool.query<{ organization_id: string | null }>(
    "select organization_id from relay.personal_workspaces where user_id = $1",
    [userId],
  );
  await pool.query('delete from auth."user" where id = $1', [userId]);
  if (rows[0]?.organization_id) {
    await pool.query("delete from auth.organization where id = $1", [
      rows[0].organization_id,
    ]);
  }
}

Deno.test("personal workspace slugs are stable and opaque", async () => {
  const userId = "user-with-sensitive@example.com";
  const first = await personalWorkspaceSlug(userId);
  const second = await personalWorkspaceSlug(userId);

  assertEquals(first, second);
  assertEquals(first.includes(userId), false);
  assertEquals(/^personal-[0-9a-f]{32}$/.test(first), true);
});

Deno.test({
  name:
    "ensurePersonalWorkspace creates an organization and owner membership for a new user",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);
      const organizationId = await ensurePersonalWorkspace(pool, userId);
      assertExists(organizationId);

      const membership = await pool.query<{ role: string }>(
        `select role from auth.member where "organizationId" = $1 and "userId" = $2`,
        [organizationId, userId],
      );
      assertEquals(membership.rows.length, 1);
      assertEquals(membership.rows[0].role, "owner");
    } finally {
      if (userId) await cleanup(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "ensurePersonalWorkspace is idempotent and returns the same organization",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);

      const first = await ensurePersonalWorkspace(pool, userId);
      const second = await ensurePersonalWorkspace(pool, userId);
      assertEquals(second, first);

      const members = await pool.query(
        `select id from auth.member where "organizationId" = $1 and "userId" = $2`,
        [first, userId],
      );
      assertEquals(
        members.rows.length,
        1,
        "calling it again must not create a second membership row",
      );
    } finally {
      if (userId) await cleanup(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "concurrent ensurePersonalWorkspace calls create one organization and membership",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);

      const results = await Promise.all(
        Array.from(
          { length: 5 },
          () => ensurePersonalWorkspace(pool, userId!),
        ),
      );

      const organizationIds = new Set(results);
      assertEquals(
        organizationIds.size,
        1,
        "every concurrent call must converge on one organization",
      );

      const members = await pool.query(
        `select id from auth.member where "organizationId" = $1 and "userId" = $2`,
        [results[0], userId],
      );
      assertEquals(members.rows.length, 1);

      const organizations = await pool.query(
        "select id from auth.organization where slug = $1",
        [await personalWorkspaceSlug(userId)],
      );
      assertEquals(
        organizations.rows.length,
        1,
        "a losing concurrent caller must not leave an orphan organization",
      );
    } finally {
      if (userId) await cleanup(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name: "ensurePersonalWorkspace heals a missing personal-workspace membership",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);
      const organizationId = await ensurePersonalWorkspace(pool, userId);
      await pool.query(
        `delete from auth.member where "organizationId" = $1 and "userId" = $2`,
        [organizationId, userId],
      );

      assertEquals(await ensurePersonalWorkspace(pool, userId), organizationId);

      const membership = await pool.query<{ role: string }>(
        `select role from auth.member where "organizationId" = $1 and "userId" = $2`,
        [organizationId, userId],
      );
      assertEquals(membership.rows, [{ role: "owner" }]);
    } finally {
      if (userId) await cleanup(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name: "ensurePersonalWorkspace heals a downgraded personal-workspace owner",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);
      const organizationId = await ensurePersonalWorkspace(pool, userId);
      await pool.query(
        `update auth.member set role = 'member'
         where "organizationId" = $1 and "userId" = $2`,
        [organizationId, userId],
      );

      assertEquals(await ensurePersonalWorkspace(pool, userId), organizationId);

      const membership = await pool.query<{ role: string }>(
        `select role from auth.member where "organizationId" = $1 and "userId" = $2`,
        [organizationId, userId],
      );
      assertEquals(membership.rows, [{ role: "owner" }]);
    } finally {
      if (userId) await cleanup(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "failed provisioning rolls the organization back instead of orphaning it",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const missingUserId = unique("missing-user");
    const slug = await personalWorkspaceSlug(missingUserId);
    try {
      await assertRejects(() => ensurePersonalWorkspace(pool, missingUserId));

      const organizations = await pool.query(
        "select 1 from auth.organization where slug = $1",
        [slug],
      );
      assertEquals(organizations.rowCount, 0);
    } finally {
      await pool.query("delete from auth.organization where slug = $1", [slug]);
      await pool.end();
    }
  },
});
