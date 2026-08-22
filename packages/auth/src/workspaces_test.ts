import { assertEquals, assertExists } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import {
  type BetterAuthAdapter,
  ensurePersonalWorkspace,
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

/**
 * A real BetterAuthAdapter over the same tables Better Auth's own adapter
 * would write to -- `ensurePersonalWorkspace` doesn't know or care that
 * this isn't the real thing, so this exercises its actual SQL against
 * real `auth.organization`/`auth.member` rows and their real constraints
 * (unique slug, FKs), not a mock that just records calls.
 */
function fakeAdapter(pool: DatabasePool): BetterAuthAdapter {
  return {
    create: async <T>(
      args: { model: string; data: Record<string, unknown> },
    ): Promise<T> => {
      if (args.model === "organization") {
        const { rows } = await pool.query<{ id: string }>(
          `insert into auth.organization (id, name, slug, "createdAt", metadata)
           values (gen_random_uuid()::text, $1, $2, $3, $4)
           returning id`,
          [
            args.data.name,
            args.data.slug,
            args.data.createdAt,
            args.data.metadata,
          ],
        );
        return rows[0] as T;
      }
      if (args.model === "member") {
        const { rows } = await pool.query<{ id: string }>(
          `insert into auth.member (id, "organizationId", "userId", role, "createdAt")
           values (gen_random_uuid()::text, $1, $2, $3, $4)
           returning id`,
          [
            args.data.organizationId,
            args.data.userId,
            args.data.role,
            args.data.createdAt,
          ],
        );
        return rows[0] as T;
      }
      throw new Error(`fakeAdapter: unsupported model "${args.model}"`);
    },
  };
}

async function cleanup(pool: DatabasePool, userId: string): Promise<void> {
  const { rows } = await pool.query<{ organization_id: string | null }>(
    "select organization_id from relay.personal_workspaces where user_id = $1",
    [userId],
  );
  await pool.query("delete from relay.personal_workspaces where user_id = $1", [
    userId,
  ]);
  await pool.query('delete from auth.member where "userId" = $1', [userId]);
  if (rows[0]?.organization_id) {
    await pool.query("delete from auth.organization where id = $1", [
      rows[0].organization_id,
    ]);
  }
  await pool.query('delete from auth."user" where id = $1', [userId]);
}

Deno.test({
  name:
    "ensurePersonalWorkspace creates an organization and owner membership for a new user",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);
      const adapter = fakeAdapter(pool);

      const organizationId = await ensurePersonalWorkspace(
        adapter,
        pool,
        userId,
      );
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
      const adapter = fakeAdapter(pool);

      const first = await ensurePersonalWorkspace(adapter, pool, userId);
      const second = await ensurePersonalWorkspace(adapter, pool, userId);
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
    "ensurePersonalWorkspace heals a personal workspace mapping that lost its membership row",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);
      const adapter = fakeAdapter(pool);

      // Simulate the exact gap this function used to leave open: a
      // personal_workspaces mapping exists (as if the process crashed, or
      // an older version of this function ran, right after claiming the
      // mapping but before creating the membership row) with no
      // corresponding auth.member row.
      const organization = await adapter.create<{ id: string }>({
        model: "organization",
        data: {
          name: "Personal",
          slug: unique("personal"),
          createdAt: new Date(),
          metadata: null,
        },
      });
      await pool.query(
        `insert into relay.personal_workspaces (user_id, organization_id) values ($1, $2)`,
        [userId, organization.id],
      );

      const before = await pool.query(
        `select id from auth.member where "organizationId" = $1 and "userId" = $2`,
        [organization.id, userId],
      );
      assertEquals(
        before.rows.length,
        0,
        "fixture must start with no membership",
      );

      const organizationId = await ensurePersonalWorkspace(
        adapter,
        pool,
        userId,
      );
      assertEquals(
        organizationId,
        organization.id,
        "healing must not create a second organization",
      );

      const after = await pool.query<{ role: string }>(
        `select role from auth.member where "organizationId" = $1 and "userId" = $2`,
        [organization.id, userId],
      );
      assertEquals(
        after.rows.length,
        1,
        "the missing membership row must be healed",
      );
      assertEquals(after.rows[0].role, "owner");
    } finally {
      if (userId) await cleanup(pool, userId);
      await pool.end();
    }
  },
});
