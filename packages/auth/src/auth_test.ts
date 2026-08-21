import { assertEquals, assertNotEquals } from "@std/assert";
import type { AuthConfig } from "@relay/config";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { createAuth } from "./auth.ts";

/**
 * Live-PostgreSQL integration tests, same pattern as
 * packages/database/src/migrator_test.ts: run only when DATABASE_URL is
 * set (compose.dev.yaml), skipped otherwise so `deno task check` stays
 * runnable without live infrastructure.
 *
 * These exercise the workspace-provisioning hook end to end through the
 * real `createAuth`, not a reimplementation of it -- session creation is
 * driven through Better Auth's internalAdapter (see the Auth interface's
 * $context.internalAdapter) rather than a real OAuth round trip, which PR
 * CI never performs against live Google/GitHub per
 * docs/implementation-handoff/03-auth-workspaces.md "Provider callback
 * tests".
 */
const databaseUrl = Deno.env.get("DATABASE_URL");
const hasDatabase = databaseUrl !== undefined;

function testAuthConfig(): AuthConfig {
  return {
    baseUrl: new URL("http://localhost:8000"),
    secret: "test-only-secret-" + "x".repeat(24),
    trustedOrigins: ["http://localhost:8000"],
    google: {
      clientId: "test-google-client-id",
      clientSecret: "test-google-client-secret",
    },
    github: {
      clientId: "test-github-client-id",
      clientSecret: "test-github-client-secret",
    },
  };
}

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

/** Cascades (auth.user/organization -> session/account/member/personal_workspaces) do the rest. */
async function resetAuthState(pool: DatabasePool): Promise<void> {
  await pool.query('delete from auth."user"');
  await pool.query("delete from auth.organization");
}

async function createTestUser(
  auth: Awaited<ReturnType<typeof createAuth>>,
  email: string,
) {
  const ctx = await auth.$context;
  return await ctx.adapter.create<{ id: string }>({
    model: "user",
    data: { email, name: "Test User", emailVerified: true },
  });
}

Deno.test({
  name: "email/password endpoints are unavailable",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      const auth = createAuth(pool, testAuthConfig());
      const response = await auth.handler(
        new Request("http://localhost:8000/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "nope@example.com",
            password: "whatever123",
            name: "Nope",
          }),
        }),
      );
      assertNotEquals(response.status, 200);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "sign-in with a first-party credential is unavailable",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      const auth = createAuth(pool, testAuthConfig());
      const response = await auth.handler(
        new Request("http://localhost:8000/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "nope@example.com",
            password: "whatever123",
          }),
        }),
      );
      assertNotEquals(response.status, 200);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "first session creates one personal workspace with the user as owner",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      await resetAuthState(pool);
      const auth = createAuth(pool, testAuthConfig());
      const user = await createTestUser(auth, "owner@example.com");

      const ctx = await auth.$context;
      const session = await ctx.internalAdapter.createSession(
        user.id,
        undefined,
        false,
        {},
        false,
      );

      assertNotEquals(session.activeOrganizationId, null);
      assertNotEquals(session.activeOrganizationId, undefined);

      const workspaces = await pool.query<
        { user_id: string; organization_id: string }
      >(
        "select user_id, organization_id from relay.personal_workspaces where user_id = $1",
        [user.id],
      );
      assertEquals(workspaces.rows.length, 1);
      assertEquals(
        workspaces.rows[0].organization_id,
        session.activeOrganizationId,
      );

      const members = await pool.query<{ role: string }>(
        `select role from auth.member where "organizationId" = $1 and "userId" = $2`,
        [session.activeOrganizationId, user.id],
      );
      assertEquals(members.rows.length, 1);
      assertEquals(members.rows[0].role, "owner");
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "a second session for the same user reuses the same workspace",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      await resetAuthState(pool);
      const auth = createAuth(pool, testAuthConfig());
      const user = await createTestUser(auth, "repeat@example.com");
      const ctx = await auth.$context;

      const first = await ctx.internalAdapter.createSession(
        user.id,
        undefined,
        false,
        {},
        false,
      );
      const second = await ctx.internalAdapter.createSession(
        user.id,
        undefined,
        false,
        {},
        false,
      );

      assertEquals(first.activeOrganizationId, second.activeOrganizationId);

      const workspaces = await pool.query(
        "select 1 from relay.personal_workspaces where user_id = $1",
        [user.id],
      );
      assertEquals(workspaces.rowCount, 1);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "concurrent first sessions for the same user still create one workspace",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      await resetAuthState(pool);
      const auth = createAuth(pool, testAuthConfig());
      const user = await createTestUser(auth, "concurrent@example.com");
      const ctx = await auth.$context;

      const sessions = await Promise.all(
        Array.from(
          { length: 5 },
          () =>
            ctx.internalAdapter.createSession(
              user.id,
              undefined,
              false,
              {},
              false,
            ),
        ),
      );

      const organizationIds = new Set(
        sessions.map((session) => session.activeOrganizationId),
      );
      assertEquals(organizationIds.size, 1);

      const workspaces = await pool.query(
        "select 1 from relay.personal_workspaces where user_id = $1",
        [user.id],
      );
      assertEquals(workspaces.rowCount, 1);

      const members = await pool.query(
        `select 1 from auth.member where "userId" = $1`,
        [user.id],
      );
      assertEquals(members.rowCount, 1);
    } finally {
      await pool.end();
    }
  },
});
