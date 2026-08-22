import {
  assertEquals,
  assertExists,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import {
  createAuth,
  createAuthOptions,
  isDeferredOrganizationMutation,
} from "./auth.ts";
import { createTestAuth, TEST_AUTH_CONFIG } from "./test-utils.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const hasDatabase = databaseUrl !== undefined;

function testPool(url = databaseUrl): DatabasePool {
  return createDatabasePool(
    {
      url: new URL(url ?? "postgres://test:test@localhost:5432/relay_test"),
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

function activeOrganizationId(session: unknown): string | null | undefined {
  return (session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
}

async function createTestUser(
  auth: ReturnType<typeof createTestAuth>,
  email: string,
  options: { emailVerified?: boolean } = {},
) {
  const { test } = await auth.$context;
  return await test.saveUser(test.createUser({
    email,
    name: "Test User",
    emailVerified: options.emailVerified ?? true,
  }));
}

async function cleanupUser(pool: DatabasePool, userId: string): Promise<void> {
  const { rows } = await pool.query<{ organization_id: string }>(
    "select organization_id from relay.personal_workspaces where user_id = $1",
    [userId],
  );
  await pool.query('delete from auth."user" where id = $1', [userId]);
  if (rows[0]) {
    await pool.query("delete from auth.organization where id = $1", [
      rows[0].organization_id,
    ]);
  }
}

Deno.test("production auth config contains only Google and GitHub", async () => {
  const pool = testPool();
  try {
    const options = createAuthOptions(pool, TEST_AUTH_CONFIG);
    assertEquals(Object.keys(options.socialProviders).sort(), [
      "github",
      "google",
    ]);
    assertEquals(options.socialProviders.google.requireEmailVerification, true);
    assertEquals(options.socialProviders.github.requireEmailVerification, true);
    assertEquals(options.plugins.map((plugin) => plugin.id), ["organization"]);
  } finally {
    await pool.end();
  }
});

Deno.test("test helpers exist only on the dedicated test auth instance", async () => {
  const pool = testPool();
  try {
    const testAuth = createTestAuth(pool);
    const context = await testAuth.$context;
    assertExists(context.test);
    assertExists(context.test.createOrganization);
    assertEquals(
      context.options.plugins?.map((plugin) => plugin.id),
      ["organization", "test-utils"],
    );
  } finally {
    await pool.end();
  }
});

Deno.test("single-member MVP organization mutation routes are disabled", async () => {
  const mutationPaths = [
    "accept-invitation",
    "add-team-member",
    "cancel-invitation",
    "create",
    "create-team",
    "delete",
    "invite-member",
    "leave",
    "reject-invitation",
    "remove-member",
    "remove-team",
    "remove-team-member",
    "set-active",
    "set-active-team",
    "update",
    "update-member-role",
    "update-team",
  ];
  for (const path of mutationPaths) {
    assertEquals(
      isDeferredOrganizationMutation(
        new Request(`http://localhost:8000/api/auth/organization/${path}`, {
          method: "POST",
        }),
      ),
      true,
      path,
    );
  }

  for (
    const [method, path] of [
      ["GET", "list"],
      ["GET", "get-organization"],
      ["GET", "get-full-organization"],
      ["GET", "get-active-member"],
      ["GET", "get-active-member-role"],
      ["GET", "get-invitation"],
      ["GET", "list-invitations"],
      ["GET", "list-members"],
      ["GET", "list-user-invitations"],
      ["POST", "check-slug"],
      ["POST", "has-permission"],
    ]
  ) {
    assertEquals(
      isDeferredOrganizationMutation(
        new Request(`http://localhost:8000/api/auth/organization/${path}`, {
          method,
        }),
      ),
      false,
      `${method} ${path}`,
    );
  }

  assertEquals(
    isDeferredOrganizationMutation(
      new Request(
        "http://localhost:8000/api/auth/organization/future-mutation",
        { method: "PATCH" },
      ),
    ),
    true,
  );
  assertEquals(
    isDeferredOrganizationMutation(
      new Request("http://localhost:8000/api/auth/get-session"),
    ),
    false,
  );

  const pool = testPool();
  try {
    const auth = createAuth(pool, TEST_AUTH_CONFIG);
    const response = await auth.handler(
      new Request("http://localhost:8000/api/auth/organization/invite-member", {
        method: "POST",
      }),
    );
    assertEquals(response.status, 404);
    assertEquals(await response.json(), {
      error: {
        code: "not_found",
        message: "The requested resource was not found.",
      },
    });
  } finally {
    await pool.end();
  }
});

Deno.test({
  name: "email/password endpoints are unavailable",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      const auth = createAuth(pool, TEST_AUTH_CONFIG);
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
      const auth = createAuth(pool, TEST_AUTH_CONFIG);
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
  name: "a session cannot be created for a user with an unverified email",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      const auth = createTestAuth(pool);
      const user = await createTestUser(
        auth,
        `${unique("unverified")}@example.com`,
        { emailVerified: false },
      );
      userId = user.id;
      const { test } = await auth.$context;

      await assertRejects(() => test.login({ userId: user.id }));

      const workspaces = await pool.query(
        "select 1 from relay.personal_workspaces where user_id = $1",
        [user.id],
      );
      assertEquals(workspaces.rowCount, 0);
    } finally {
      if (userId) await cleanupUser(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name: "first session creates one personal workspace with the user as owner",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      const auth = createTestAuth(pool);
      const user = await createTestUser(auth, `${unique("owner")}@example.com`);
      userId = user.id;
      const { test } = await auth.$context;
      const { session } = await test.login({ userId: user.id });

      const organizationId = activeOrganizationId(session);
      assertNotEquals(organizationId, null);
      assertNotEquals(organizationId, undefined);

      const workspaces = await pool.query<
        { user_id: string; organization_id: string }
      >(
        "select user_id, organization_id from relay.personal_workspaces where user_id = $1",
        [user.id],
      );
      assertEquals(workspaces.rows.length, 1);
      assertEquals(
        workspaces.rows[0].organization_id,
        organizationId,
      );

      const members = await pool.query<{ role: string }>(
        `select role from auth.member where "organizationId" = $1 and "userId" = $2`,
        [organizationId, user.id],
      );
      assertEquals(members.rows, [{ role: "owner" }]);
    } finally {
      if (userId) await cleanupUser(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name: "a second session for the same user reuses the same workspace",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      const auth = createTestAuth(pool);
      const user = await createTestUser(
        auth,
        `${unique("repeat")}@example.com`,
      );
      userId = user.id;
      const { test } = await auth.$context;

      const first = await test.login({ userId: user.id });
      const second = await test.login({ userId: user.id });
      assertEquals(
        activeOrganizationId(first.session),
        activeOrganizationId(second.session),
      );

      const workspaces = await pool.query(
        "select 1 from relay.personal_workspaces where user_id = $1",
        [user.id],
      );
      assertEquals(workspaces.rowCount, 1);
    } finally {
      if (userId) await cleanupUser(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "concurrent first sessions for the same user create one organization and owner",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      const auth = createTestAuth(pool);
      const user = await createTestUser(
        auth,
        `${unique("concurrent")}@example.com`,
      );
      userId = user.id;
      const { test } = await auth.$context;

      const sessions = await Promise.all(
        Array.from({ length: 5 }, () => test.login({ userId: user.id })),
      );
      const organizationIds = new Set(
        sessions.map(({ session }) => activeOrganizationId(session)),
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
      if (userId) await cleanupUser(pool, userId);
      await pool.end();
    }
  },
});
