import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { recordAuditEvent } from "./audit.ts";

/**
 * relay_app -- the role these tests connect as, matching the API's real
 * runtime identity -- cannot UPDATE or DELETE relay.audit_events by
 * design (see 0005_audit_events.ts). So unlike other test files in this
 * repo, there is no table-wide reset() here: every test uses a unique
 * action/target/idempotency value and only ever queries rows matching
 * that value, ignoring whatever earlier runs left behind.
 */
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

Deno.test({
  name: "recordAuditEvent inserts a durable row with the given fields",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      const targetId = unique("target");
      await recordAuditEvent(pool, {
        actorType: "system",
        action: "tool.publish",
        targetType: "tool",
        targetId,
        outcome: "success",
      });

      const rows = await pool.query<
        { action: string; target_type: string; outcome: string }
      >(
        "select action, target_type, outcome from relay.audit_events where target_id = $1",
        [targetId],
      );
      assertEquals(rows.rows.length, 1);
      assertEquals(rows.rows[0].action, "tool.publish");
      assertEquals(rows.rows[0].outcome, "success");
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "a retried action with the same idempotency key records exactly one event",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      const idempotencyKey = unique("retry-key");
      const event = {
        actorType: "user" as const,
        action: "share_link.create",
        targetType: "artifact",
        targetId: unique("artifact"),
        outcome: "success" as const,
        idempotencyKey,
      };

      await recordAuditEvent(pool, event);
      await recordAuditEvent(pool, event);
      await recordAuditEvent(pool, event);

      const rows = await pool.query(
        "select 1 from relay.audit_events where idempotency_key = $1",
        [idempotencyKey],
      );
      assertEquals(rows.rowCount, 1);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "events without an idempotency key are never deduplicated against each other",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      const targetId = unique("target");
      const event = {
        actorType: "user" as const,
        action: "changelog.publish",
        targetType: "changelog_entry",
        targetId,
        outcome: "success" as const,
      };

      await recordAuditEvent(pool, event);
      await recordAuditEvent(pool, event);

      const rows = await pool.query(
        "select 1 from relay.audit_events where target_id = $1",
        [targetId],
      );
      assertEquals(rows.rowCount, 2);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "credential-shaped keys in snapshots are redacted before storage",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      const targetId = unique("provider");
      await recordAuditEvent(pool, {
        actorType: "system",
        action: "provider.credential_state_change",
        targetType: "provider",
        targetId,
        outcome: "success",
        beforeSnapshot: {
          providerId: "azure-openai",
          apiKey: "sk-should-never-be-stored",
          nested: { clientSecret: "also-should-never-be-stored" },
        },
      });

      const rows = await pool.query<{ before_snapshot: unknown }>(
        "select before_snapshot from relay.audit_events where target_id = $1",
        [targetId],
      );
      const snapshot = rows.rows[0].before_snapshot as Record<
        string,
        unknown
      >;
      assertEquals(snapshot.providerId, "azure-openai");
      assertEquals(snapshot.apiKey, "[redacted]");
      assertEquals(
        (snapshot.nested as Record<string, unknown>).clientSecret,
        "[redacted]",
      );
    } finally {
      await pool.end();
    }
  },
});
