import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { BootstrapSuperadminRequest, Queryable } from "@relay/auth";
import type { DatabaseConfig } from "@relay/config";
import {
  BOOTSTRAP_SUPERADMIN_IDEMPOTENCY_KEY_ENV,
  BOOTSTRAP_SUPERADMIN_USAGE,
  BOOTSTRAP_SUPERADMIN_USER_ID_ENV,
  BootstrapSuperadminCommandError,
  bootstrapSuperadminFailureMessage,
  loadBootstrapSuperadminOptions,
  runBootstrapSuperadminCommand,
} from "./bootstrap-superadmin.ts";

function databaseConfig(username = "relay_migrator"): DatabaseConfig {
  return {
    url: new URL(`postgres://${username}:secret@localhost:5432/relay`),
    poolMax: 1,
    connectTimeoutMs: 5_000,
    statementTimeoutMs: 30_000,
  };
}

class FakeClient implements Queryable {
  readonly calls: Array<{ readonly text: string; readonly params: unknown[] }> =
    [];
  releaseCalls = 0;

  constructor(readonly sessionUser = "relay_migrator") {}

  query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, params });
    const rows = text.includes("session_user")
      ? [{ session_user: this.sessionUser }]
      : [];
    return Promise.resolve({ rows: rows as T[] });
  }

  release(): void {
    this.releaseCalls += 1;
  }
}

class FakePool {
  endCalls = 0;

  constructor(readonly client: FakeClient) {}

  connect(): Promise<FakeClient> {
    return Promise.resolve(this.client);
  }

  end(): Promise<void> {
    this.endCalls += 1;
    return Promise.resolve();
  }
}

Deno.test("bootstrap command loads explicit environment-only input", () => {
  assertEquals(
    loadBootstrapSuperadminOptions({
      [BOOTSTRAP_SUPERADMIN_USER_ID_ENV]: "user-immutable-0001",
      [BOOTSTRAP_SUPERADMIN_IDEMPOTENCY_KEY_ENV]: "bootstrap-request-0001",
    }),
    {
      userId: "user-immutable-0001",
      idempotencyKey: "bootstrap-request-0001",
    },
  );

  for (
    const env of [
      {},
      { [BOOTSTRAP_SUPERADMIN_USER_ID_ENV]: "user-immutable-0001" },
      {
        [BOOTSTRAP_SUPERADMIN_USER_ID_ENV]: " ",
        [BOOTSTRAP_SUPERADMIN_IDEMPOTENCY_KEY_ENV]: "bootstrap-request-0001",
      },
      {
        [BOOTSTRAP_SUPERADMIN_USER_ID_ENV]: "user-immutable-0001",
        [BOOTSTRAP_SUPERADMIN_IDEMPOTENCY_KEY_ENV]: "short",
      },
    ]
  ) {
    assertThrows(
      () => loadBootstrapSuperadminOptions(env),
      TypeError,
    );
  }
  assertEquals(BOOTSTRAP_SUPERADMIN_USAGE.includes("--user-id"), false);
  assertEquals(BOOTSTRAP_SUPERADMIN_USAGE.includes("--idempotency-key"), false);
});

Deno.test("bootstrap command scopes relay_owner to one transaction", async () => {
  const client = new FakeClient();
  const pool = new FakePool(client);
  let receivedQueryable: Queryable | undefined;
  let receivedRequest: BootstrapSuperadminRequest | undefined;

  const result = await runBootstrapSuperadminCommand(
    databaseConfig(),
    {
      userId: "user-immutable-0001",
      idempotencyKey: "bootstrap-request-0001",
    },
    {
      createPool: () => pool,
      bootstrap: (queryable, request) => {
        receivedQueryable = queryable;
        receivedRequest = request;
        return Promise.resolve({ kind: "changed" });
      },
    },
  );

  assertEquals(result, { kind: "changed" });
  assertStrictEquals(receivedQueryable, client);
  assertEquals(receivedRequest, {
    targetUserId: "user-immutable-0001",
    idempotencyKey: "bootstrap-request-0001",
  });
  assertEquals(client.calls.map((call) => call.text), [
    "select session_user::text as session_user",
    "begin",
    "set local role relay_owner",
    "commit",
  ]);
  assertEquals(client.releaseCalls, 1);
  assertEquals(pool.endCalls, 1);
});

Deno.test("bootstrap command accepts an idempotent replay", async () => {
  const client = new FakeClient();
  const pool = new FakePool(client);
  const result = await runBootstrapSuperadminCommand(
    databaseConfig(),
    {
      userId: "user-immutable-0001",
      idempotencyKey: "bootstrap-request-0001",
    },
    {
      createPool: () => pool,
      bootstrap: () => Promise.resolve({ kind: "replayed" }),
    },
  );

  assertEquals(result, { kind: "replayed" });
  assertEquals(client.calls.at(-1)?.text, "commit");
  assertEquals(client.releaseCalls, 1);
  assertEquals(pool.endCalls, 1);
});

Deno.test("bootstrap command validates input before opening a privileged pool", async () => {
  let createCalls = 0;
  await assertRejects(
    () =>
      runBootstrapSuperadminCommand(
        databaseConfig(),
        {
          userId: "user-immutable-0001",
          idempotencyKey: "short",
        },
        {
          createPool: () => {
            createCalls += 1;
            return new FakePool(new FakeClient());
          },
        },
      ),
    TypeError,
    BOOTSTRAP_SUPERADMIN_IDEMPOTENCY_KEY_ENV,
  );
  assertEquals(createCalls, 0);
});

Deno.test("bootstrap command failure messages are actionable and identifier-free", () => {
  assertEquals(
    bootstrapSuperadminFailureMessage("database_role"),
    "Superadmin bootstrap requires relay_migrator database credentials",
  );
  assertEquals(
    bootstrapSuperadminFailureMessage("target_not_found"),
    "Superadmin bootstrap target user does not exist",
  );
  assertEquals(
    bootstrapSuperadminFailureMessage("already_completed"),
    "Initial superadmin bootstrap has already been completed with different input",
  );
});

Deno.test("bootstrap command maps expected database denials safely", async () => {
  for (
    const [code, reason] of [
      ["42501", "already_completed"],
      ["23503", "target_not_found"],
    ] as const
  ) {
    const client = new FakeClient();
    const pool = new FakePool(client);
    const error = await assertRejects(
      () =>
        runBootstrapSuperadminCommand(
          databaseConfig(),
          {
            userId: "user-immutable-0001",
            idempotencyKey: "bootstrap-request-0001",
          },
          {
            createPool: () => pool,
            bootstrap: () =>
              Promise.reject(Object.assign(new Error("database detail"), {
                code,
              })),
          },
        ),
      BootstrapSuperadminCommandError,
    );
    assertEquals(error.reason, reason);
    assertEquals(client.calls.at(-1)?.text, "rollback");
    assertEquals(client.releaseCalls, 1);
    assertEquals(pool.endCalls, 1);
  }
});

Deno.test("bootstrap command refuses runtime and unexpected database roles", async () => {
  let createCalls = 0;
  const configurationError = await assertRejects(
    () =>
      runBootstrapSuperadminCommand(
        databaseConfig("relay_app"),
        {
          userId: "user-immutable-0001",
          idempotencyKey: "bootstrap-request-0001",
        },
        {
          createPool: () => {
            createCalls += 1;
            return new FakePool(new FakeClient());
          },
        },
      ),
    BootstrapSuperadminCommandError,
  );
  assertEquals(configurationError.reason, "database_role");
  assertEquals(createCalls, 0);

  const client = new FakeClient("postgres");
  const pool = new FakePool(client);
  const sessionError = await assertRejects(
    () =>
      runBootstrapSuperadminCommand(
        databaseConfig(),
        {
          userId: "user-immutable-0001",
          idempotencyKey: "bootstrap-request-0001",
        },
        { createPool: () => pool },
      ),
    BootstrapSuperadminCommandError,
  );
  assertEquals(sessionError.reason, "database_role");
  assertEquals(client.calls.map((call) => call.text), [
    "select session_user::text as session_user",
  ]);
  assertEquals(client.releaseCalls, 1);
  assertEquals(pool.endCalls, 1);
});

Deno.test("bootstrap command rolls back and closes resources on failure", async () => {
  const client = new FakeClient();
  const pool = new FakePool(client);
  const failure = new Error("bootstrap failed");

  await assertRejects(
    () =>
      runBootstrapSuperadminCommand(
        databaseConfig(),
        {
          userId: "user-immutable-0001",
          idempotencyKey: "bootstrap-request-0001",
        },
        {
          createPool: () => pool,
          bootstrap: () => Promise.reject(failure),
        },
      ),
    Error,
    failure.message,
  );

  assertEquals(client.calls.map((call) => call.text), [
    "select session_user::text as session_user",
    "begin",
    "set local role relay_owner",
    "rollback",
  ]);
  assertEquals(client.releaseCalls, 1);
  assertEquals(pool.endCalls, 1);
});
