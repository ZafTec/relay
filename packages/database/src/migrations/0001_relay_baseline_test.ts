import { assertEquals, assertStringIncludes } from "@std/assert";
import pg from "pg";
import { CANONICAL_SQL, migration } from "./0001_relay_baseline.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0001_relay_baseline checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});

Deno.test("0001 baseline contains the complete MVP trust boundaries", () => {
  for (
    const invariant of [
      'CREATE TABLE auth."user"',
      "CREATE TABLE auth.jwks",
      'CREATE TABLE auth."oauthClient"',
      'CREATE TABLE auth."oauthResource"',
      'CREATE TABLE auth."oauthClientResource"',
      'CREATE TABLE auth."oauthRefreshToken"',
      'CREATE TABLE auth."oauthAccessToken"',
      'CREATE TABLE auth."oauthConsent"',
      'CREATE TABLE auth."oauthClientAssertion"',
      "CREATE TABLE relay.tool_runs",
      "CREATE TABLE relay.execution_jobs",
      "CREATE TABLE relay.artifacts",
      "CREATE TABLE relay.usage_reservations",
      "CREATE TABLE relay.changelog_releases",
      "CREATE FUNCTION relay.record_audit_event",
      "CREATE FUNCTION relay.adjust_customer_usage",
      "CREATE TRIGGER execution_jobs_server_owned_scheduling_profile",
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA relay FROM relay_app",
      "INSERT INTO relay.scheduler_classes",
    ]
  ) {
    assertStringIncludes(CANONICAL_SQL, invariant);
  }
  assertEquals(
    /INSERT INTO relay\.(?:meter_policies|pricing_policies|entitlement_grants)/i
      .test(CANONICAL_SQL),
    false,
  );
});

const databaseUrl = Deno.env.get("DATABASE_URL");

Deno.test({
  name: "0001 baseline exposes the expected PostgreSQL runtime surface",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const ledger = await client.query<{ checksum_sha256: string }>(
        `select checksum_sha256
           from relay.schema_migrations
          where id = '0001_relay_baseline'`,
      );
      assertEquals(ledger.rows, [{
        checksum_sha256: migration.checksumSha256,
      }]);

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'relay'
            and table_name in (
              'audit_events', 'tools', 'tool_versions', 'routing_decisions',
              'tool_runs', 'execution_jobs', 'outbox_events', 'artifacts',
              'artifact_versions', 'share_links', 'usage_reservations',
              'usage_events', 'provider_cost_events', 'changelog_releases',
              'legal_documents'
            )
          order by table_name`,
      );
      assertEquals(
        tables.rows.map((row: { table_name: string }) => row.table_name),
        [
          "artifact_versions",
          "artifacts",
          "audit_events",
          "execution_jobs",
          "outbox_events",
          "provider_cost_events",
          "routing_decisions",
          "share_links",
          "tool_runs",
          "tool_versions",
          "tools",
          "usage_events",
          "usage_reservations",
        ],
      );

      const authTables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'auth'
            and table_name in (
              'jwks', 'oauthClient', 'oauthResource', 'oauthClientResource',
              'oauthRefreshToken', 'oauthAccessToken', 'oauthConsent',
              'oauthClientAssertion'
            )
          order by table_name`,
      );
      assertEquals(
        authTables.rows.map((row: { table_name: string }) => row.table_name),
        [
          "jwks",
          "oauthAccessToken",
          "oauthClient",
          "oauthClientAssertion",
          "oauthClientResource",
          "oauthConsent",
          "oauthRefreshToken",
          "oauthResource",
        ],
      );

      const scheduler = await client.query<{
        class_key: string;
        weight: string;
        max_share: string | null;
      }>(
        `select class_key, weight::text, max_share::text
           from relay.scheduler_classes
          order by class_key`,
      );
      assertEquals(scheduler.rows, [
        { class_key: "enterprise", weight: "4", max_share: null },
        { class_key: "internal", weight: "1", max_share: "0.10" },
        { class_key: "paid", weight: "2", max_share: null },
        { class_key: "standard", weight: "1", max_share: null },
      ]);

      const privileges = await client.query<{
        audit_insert: boolean;
        role_update: boolean;
        adjustment_insert: boolean;
        changelog_select: boolean;
        run_insert: boolean;
        record_audit: boolean;
      }>(
        `select
           has_table_privilege(current_user, 'relay.audit_events', 'INSERT') as audit_insert,
           has_table_privilege(current_user, 'relay.system_role_assignments', 'UPDATE') as role_update,
           has_table_privilege(current_user, 'relay.usage_adjustments', 'INSERT') as adjustment_insert,
           has_table_privilege(current_user, 'relay.changelog_releases', 'SELECT') as changelog_select,
           has_table_privilege(current_user, 'relay.tool_runs', 'INSERT') as run_insert,
           has_function_privilege(
             current_user,
             'relay.record_audit_event(text,text,text,text,text,text,text,text,text,jsonb,jsonb,text,text,text,text,text,text,text)',
             'EXECUTE'
           ) as record_audit`,
      );
      assertEquals(privileges.rows[0], {
        audit_insert: false,
        role_update: false,
        adjustment_insert: false,
        changelog_select: false,
        run_insert: true,
        record_audit: true,
      });
    } finally {
      await client.end();
    }
  },
});
