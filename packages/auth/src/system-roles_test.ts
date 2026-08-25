import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import {
  bootstrapSuperadmin,
  grantSuperadmin,
  isSuperadmin,
  revokeSuperadmin,
  type SuperadminMutationRequest,
  SystemRoleIdempotencyConflictError,
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

async function cleanup(pool: DatabasePool, userId: string | undefined) {
  if (userId) {
    await pool.query('delete from auth."user" where id = $1', [userId]);
  }
}

class FakeRoleDatabase {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  nextResult = "changed";
  nextErrorCode: string | undefined;

  query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    if (sql.includes("select 1 from relay.system_role_assignments")) {
      return Promise.resolve({ rows: [] });
    }
    if (this.nextErrorCode) {
      const error = Object.assign(new Error("database function rejected"), {
        code: this.nextErrorCode,
      });
      this.nextErrorCode = undefined;
      return Promise.reject(error);
    }
    return Promise.resolve({ rows: [{ result: this.nextResult }] as T[] });
  }
}

function mutationRequest(overrides: Partial<SuperadminMutationRequest> = {}) {
  return {
    targetUserId: "target-user",
    operator: { sessionId: "operator-session-0001" },
    idempotencyKey: "role-change-request-0001",
    ...overrides,
  } satisfies SuperadminMutationRequest;
}

Deno.test("the database authoritatively rejects stale or missing operator sessions", async () => {
  for (const code of ["28000", "55000"]) {
    const database = new FakeRoleDatabase();
    database.nextErrorCode = code;
    assertEquals(
      await grantSuperadmin(database, mutationRequest()),
      { kind: "reauthentication_required" },
    );
    assertEquals(database.calls.length, 1);
  }
});

Deno.test("the database authoritatively rejects a non-superadmin operator", async () => {
  const database = new FakeRoleDatabase();
  database.nextErrorCode = "42501";

  assertEquals(
    await grantSuperadmin(database, mutationRequest()),
    { kind: "denied", reason: "operator_not_superadmin" },
  );
  assertEquals(database.calls.length, 1);
});

Deno.test("authorized mutation passes a session ID and hashed idempotency key", async () => {
  const database = new FakeRoleDatabase();

  assertEquals(
    await grantSuperadmin(database, mutationRequest()),
    { kind: "changed" },
  );
  assertEquals(database.calls.length, 1);
  assertEquals(
    database.calls[0].sql.includes("select relay.grant_superadmin"),
    true,
  );
  assertEquals(database.calls[0].params.slice(0, 2), [
    "target-user",
    "operator-session-0001",
  ]);
  const keyHash = String(database.calls[0].params[2]);
  assertNotEquals(keyHash, "role-change-request-0001");
  assertMatch(keyHash, /^[0-9a-f]{64}$/);
});

Deno.test("revoking the final superadmin is a typed denial", async () => {
  const database = new FakeRoleDatabase();
  database.nextResult = "last_superadmin";

  assertEquals(
    await revokeSuperadmin(database, mutationRequest()),
    { kind: "denied", reason: "last_superadmin" },
  );
});

Deno.test("role-service idempotency mismatch is a typed failure", async () => {
  const database = new FakeRoleDatabase();
  database.nextErrorCode = "22023";

  await assertRejects(
    () => revokeSuperadmin(database, mutationRequest()),
    SystemRoleIdempotencyConflictError,
  );
});

Deno.test("superadmin mutations reject weak or unsafe idempotency keys", async () => {
  const database = new FakeRoleDatabase();
  for (
    const idempotencyKey of [
      "short",
      "Bearer secret-access-token",
      "x".repeat(129),
    ]
  ) {
    await assertRejects(
      () => grantSuperadmin(database, mutationRequest({ idempotencyKey })),
      TypeError,
      "16-128 URL-safe characters",
    );
  }
  assertEquals(database.calls.length, 0);
});

Deno.test("bootstrap uses the owner-only database function with a hashed key", async () => {
  const database = new FakeRoleDatabase();
  assertEquals(
    await bootstrapSuperadmin(database, {
      targetUserId: "target-user",
      idempotencyKey: "bootstrap-request-0001",
    }),
    { kind: "changed" },
  );
  assertEquals(
    database.calls[0].sql.includes("select relay.bootstrap_superadmin"),
    true,
  );
  assertEquals(database.calls[0].params[0], "target-user");
  assertMatch(String(database.calls[0].params[1]), /^[0-9a-f]{64}$/);
});

Deno.test({
  name: "isSuperadmin reads current unrevoked state",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool, "nobody");
      assertEquals(await isSuperadmin(pool, userId), false);
    } finally {
      await cleanup(pool, userId);
      await pool.end();
    }
  },
});
