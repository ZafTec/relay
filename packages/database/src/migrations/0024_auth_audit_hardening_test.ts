import { assertEquals, assertStringIncludes } from "@std/assert";
import pg from "pg";
import { CANONICAL_SQL, migration } from "./0024_auth_audit_hardening.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0024_auth_audit_hardening checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});

Deno.test("0024 protects audit and superadmin mutation boundaries", () => {
  assertStringIncludes(
    CANONICAL_SQL,
    "create table relay.audit_event_idempotency",
  );
  assertStringIncludes(
    CANONICAL_SQL,
    "create table relay.privileged_operation_idempotency",
  );
  assertStringIncludes(
    CANONICAL_SQL,
    "revoke all on relay.privileged_operation_idempotency from public, relay_app",
  );
  assertStringIncludes(
    CANONICAL_SQL,
    "revoke insert on relay.audit_events from relay_app",
  );
  assertStringIncludes(
    CANONICAL_SQL,
    "create function relay.record_audit_event",
  );
  assertStringIncludes(
    CANONICAL_SQL,
    "privileged audit actions require their dedicated mutation function",
  );
  assertStringIncludes(
    CANONICAL_SQL,
    "create function relay.require_fresh_superadmin_session",
  );
  assertStringIncludes(CANONICAL_SQL, "for share");
  assertStringIncludes(
    CANONICAL_SQL,
    "create function relay.bootstrap_superadmin",
  );
  assertStringIncludes(
    CANONICAL_SQL,
    "superadmin bootstrap requires zero active superadmins",
  );
  assertStringIncludes(CANONICAL_SQL, "mutation_result := 'last_superadmin'");
  assertStringIncludes(
    CANONICAL_SQL,
    "create trigger reject_active_superadmin_user_delete",
  );
  assertStringIncludes(CANONICAL_SQL, "set search_path = pg_catalog");
});

const databaseUrl = Deno.env.get("DATABASE_URL");
const authSecurityTestDatabaseUrl = Deno.env.get(
  "AUTH_SECURITY_TEST_DATABASE_URL",
);

async function assertDatabaseError(
  client: pg.Client,
  operation: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  await client.query("savepoint expected_error");
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  } finally {
    await client.query("rollback to savepoint expected_error");
  }
  const code = typeof caught === "object" && caught !== null
    ? (caught as { code?: unknown }).code
    : undefined;
  assertEquals(code, expectedCode);
}

Deno.test({
  name: "0024 grants only the intended runtime privileges",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const client = new pg.Client({ connectionString: databaseUrl! });
    await client.connect();
    try {
      const { rows } = await client.query<{
        can_insert_audit: boolean;
        can_write_audit_idempotency: boolean;
        can_read_audit_idempotency: boolean;
        can_write_privileged_idempotency: boolean;
        can_read_privileged_idempotency: boolean;
        can_record_audit: boolean;
        can_bootstrap: boolean;
        can_grant: boolean;
        can_revoke: boolean;
        can_call_auth_helper: boolean;
      }>(
        `select
           has_table_privilege('relay_app', 'relay.audit_events', 'INSERT') as can_insert_audit,
           has_table_privilege('relay_app', 'relay.audit_event_idempotency', 'INSERT,UPDATE,DELETE') as can_write_audit_idempotency,
           has_table_privilege('relay_app', 'relay.audit_event_idempotency', 'SELECT') as can_read_audit_idempotency,
           has_table_privilege('relay_app', 'relay.privileged_operation_idempotency', 'INSERT,UPDATE,DELETE') as can_write_privileged_idempotency,
           has_table_privilege('relay_app', 'relay.privileged_operation_idempotency', 'SELECT') as can_read_privileged_idempotency,
           has_function_privilege(
             'relay_app',
             'relay.record_audit_event(text,text,text,text,text,text,text,text,text,jsonb,jsonb,text,text,text,text,text,text,text)',
             'EXECUTE'
           ) as can_record_audit,
           has_function_privilege(
             'relay_app',
             'relay.bootstrap_superadmin(text,text)',
             'EXECUTE'
           ) as can_bootstrap,
           has_function_privilege(
             'relay_app',
             'relay.grant_superadmin(text,text,text)',
             'EXECUTE'
           ) as can_grant,
           has_function_privilege(
             'relay_app',
             'relay.revoke_superadmin(text,text,text)',
             'EXECUTE'
           ) as can_revoke,
           has_function_privilege(
             'relay_app',
             'relay.require_fresh_superadmin_session(text)',
             'EXECUTE'
           ) as can_call_auth_helper`,
      );

      assertEquals(rows[0], {
        can_insert_audit: false,
        can_write_audit_idempotency: false,
        can_read_audit_idempotency: false,
        can_write_privileged_idempotency: false,
        can_read_privileged_idempotency: false,
        can_record_audit: true,
        can_bootstrap: false,
        can_grant: true,
        can_revoke: true,
        can_call_auth_helper: false,
      });
    } finally {
      await client.end();
    }
  },
});

Deno.test({
  name:
    "0024 enforces bootstrap, session authorization, replay, and final-admin rules",
  ignore: authSecurityTestDatabaseUrl === undefined,
  fn: async () => {
    const url = new URL(authSecurityTestDatabaseUrl!);
    const runtimeDatabase = databaseUrl === undefined
      ? undefined
      : new URL(databaseUrl).pathname;
    if (!url.pathname.endsWith("_test") && url.pathname !== runtimeDatabase) {
      throw new Error(
        "AUTH_SECURITY_TEST_DATABASE_URL must target DATABASE_URL or a disposable *_test database",
      );
    }
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await client.query("begin");
    try {
      await client.query("set local role relay_owner");

      const bootstrapUserId = crypto.randomUUID();
      const targetUserId = crypto.randomUUID();
      const otherUserId = crypto.randomUUID();
      const bootstrapSessionId = crypto.randomUUID();
      const staleSessionId = crypto.randomUUID();
      const nonAdminSessionId = crypto.randomUUID();
      await client.query(
        `insert into auth."user" (id, name, email, "emailVerified")
         values
           ($1, 'Bootstrap', $2, true),
           ($3, 'Target', $4, true),
           ($5, 'Other', $6, true)`,
        [
          bootstrapUserId,
          `${bootstrapUserId}@example.com`,
          targetUserId,
          `${targetUserId}@example.com`,
          otherUserId,
          `${otherUserId}@example.com`,
        ],
      );
      await client.query(
        `insert into auth."session"
           (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
         values
           ($1, now() + interval '1 hour', $2, now(), now(), $3),
           ($4, now() + interval '1 hour', $5, now() - interval '16 minutes', now(), $3),
           ($6, now() + interval '1 hour', $7, now(), now(), $8)`,
        [
          bootstrapSessionId,
          crypto.randomUUID(),
          bootstrapUserId,
          staleSessionId,
          crypto.randomUUID(),
          nonAdminSessionId,
          crypto.randomUUID(),
          otherUserId,
        ],
      );

      const bootstrapKeyHash = "a".repeat(64);
      assertEquals(
        (await client.query<{ result: string }>(
          "select relay.bootstrap_superadmin($1, $2) as result",
          [bootstrapUserId, bootstrapKeyHash],
        )).rows[0].result,
        "changed",
      );
      assertEquals(
        (await client.query<{ result: string }>(
          "select relay.bootstrap_superadmin($1, $2) as result",
          [bootstrapUserId, bootstrapKeyHash],
        )).rows[0].result,
        "replayed",
      );
      await assertDatabaseError(
        client,
        () =>
          client.query("select relay.bootstrap_superadmin($1, $2)", [
            otherUserId,
            "b".repeat(64),
          ]),
        "42501",
      );

      // Runtime denial is covered by the explicit privilege assertions above.
      // Keep this transaction under relay_owner so bootstrap setup and the
      // function-level authorization/replay behavior share one rollback scope.
      const grantKeyHash = "c".repeat(64);
      assertEquals(
        (await client.query<{ result: string }>(
          "select relay.grant_superadmin($1, $2, $3) as result",
          [targetUserId, bootstrapSessionId, grantKeyHash],
        )).rows[0].result,
        "changed",
      );
      assertEquals(
        (await client.query<{ result: string }>(
          "select relay.grant_superadmin($1, $2, $3) as result",
          [targetUserId, bootstrapSessionId, grantKeyHash],
        )).rows[0].result,
        "replayed",
      );
      await assertDatabaseError(
        client,
        () =>
          client.query("select relay.grant_superadmin($1, $2, $3)", [
            otherUserId,
            bootstrapSessionId,
            grantKeyHash,
          ]),
        "22023",
      );
      await assertDatabaseError(
        client,
        () =>
          client.query("select relay.grant_superadmin($1, $2, $3)", [
            otherUserId,
            staleSessionId,
            "d".repeat(64),
          ]),
        "55000",
      );
      await assertDatabaseError(
        client,
        () =>
          client.query("select relay.grant_superadmin($1, $2, $3)", [
            otherUserId,
            nonAdminSessionId,
            "e".repeat(64),
          ]),
        "42501",
      );

      assertEquals(
        (await client.query<{ result: string }>(
          "select relay.revoke_superadmin($1, $2, $3) as result",
          [targetUserId, bootstrapSessionId, "f".repeat(64)],
        )).rows[0].result,
        "changed",
      );
      assertEquals(
        (await client.query<{ result: string }>(
          "select relay.revoke_superadmin($1, $2, $3) as result",
          [bootstrapUserId, bootstrapSessionId, "1".repeat(64)],
        )).rows[0].result,
        "last_superadmin",
      );
      await assertDatabaseError(
        client,
        () =>
          client.query('delete from auth."user" where id = $1', [
            bootstrapUserId,
          ]),
        "42501",
      );

      const { rows } = await client.query<{
        active_count: string;
        denied_count: string;
      }>(
        `select
           (select count(*) from relay.system_role_assignments where revoked_at is null)::text as active_count,
           (select count(*) from relay.audit_events
             where action = 'system_role.superadmin.revoke'
               and outcome = 'denied'
               and reason_code = 'last_superadmin')::text as denied_count`,
      );
      assertEquals(rows[0], { active_count: "1", denied_count: "1" });
    } finally {
      await client.query("rollback");
      await client.end();
    }
  },
});
