import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import {
  AUDIT_REDACTION_LIMITS,
  AuditIdempotencyConflictError,
  recordAuditEvent,
  redactAuditValue,
} from "./audit.ts";

/**
 * relay_app -- the role these tests connect as, matching the API's real
 * runtime identity -- can append only through relay.record_audit_event and
 * cannot directly INSERT, UPDATE, or DELETE relay.audit_events. Consequently
 * there is no table-wide reset: each test uses unique identifiers and queries
 * only its own rows.
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

class MemoryAuditStore {
  private readonly idempotencyKeysByPrefix = new Map<string, string>();

  query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    if (!sql.includes("relay.record_audit_event")) {
      throw new Error(`Unexpected audit SQL: ${sql}`);
    }

    const scopeHash = params[15] as string | null;
    const keyHash = params[16] as string | null;
    const fingerprint = params[17] as string | null;
    if (scopeHash === null || keyHash === null || fingerprint === null) {
      return Promise.resolve({ rows: [{ disposition: "inserted" }] as T[] });
    }

    const scopedKey = `${scopeHash}:${keyHash}`;
    const existing = this.idempotencyKeysByPrefix.get(scopedKey);
    if (existing === undefined) {
      this.idempotencyKeysByPrefix.set(scopedKey, fingerprint);
      return Promise.resolve({ rows: [{ disposition: "inserted" }] as T[] });
    }
    return Promise.resolve({
      rows: [{
        disposition: existing === fingerprint ? "replayed" : "conflict",
      }] as T[],
    });
  }
}

Deno.test("idempotent audit retries compare pre-redaction semantics", async () => {
  const store = new MemoryAuditStore();
  const event = {
    actorType: "system" as const,
    action: "provider.update",
    targetType: "provider",
    targetId: "provider-1",
    outcome: "success" as const,
    beforeSnapshot: { apiKey: "sk-first-secret-value" },
    idempotencyKey: "audit-request-0001",
  };

  await recordAuditEvent(store, event);
  await recordAuditEvent(store, event);
  await assertRejects(
    () =>
      recordAuditEvent(store, {
        ...event,
        beforeSnapshot: { apiKey: "sk-retry-secret-value" },
      }),
    AuditIdempotencyConflictError,
  );
  await assertRejects(
    () => recordAuditEvent(store, { ...event, targetId: "provider-2" }),
    AuditIdempotencyConflictError,
  );
});

Deno.test("redaction catches credential-shaped values under harmless keys", () => {
  const redacted = redactAuditValue({
    header: "Bearer secret-access-token",
    note: "api_key=sk-should-not-survive",
    callback: "https://example.com/callback?code=oauth-secret",
    "sk-secret-used-as-a-key": "hidden",
    safe: "published",
  });

  assertEquals(redacted, {
    header: "[redacted]",
    note: "[redacted]",
    callback: "[redacted]",
    "[redacted]": "[redacted]",
    safe: "published",
  });

  assertEquals(redactAuditValue({ apiKey: "secret", password: "secret" }), {
    apiKey: "[redacted]",
    password: "[redacted]",
  });
});

Deno.test("audit idempotency is scoped and rejects unsafe keys", async () => {
  const store = new MemoryAuditStore();
  const sharedKey = "shared-request-0001";
  const base = {
    actorType: "user" as const,
    actorUserId: "user-1",
    targetType: "tool",
    targetId: "tool-1",
    outcome: "success" as const,
    idempotencyKey: sharedKey,
  };

  await recordAuditEvent(store, { ...base, action: "tool.publish" });
  await recordAuditEvent(store, { ...base, action: "tool.disable" });

  await assertRejects(
    () =>
      recordAuditEvent(store, {
        ...base,
        action: "tool.publish",
        idempotencyKey: "short",
      }),
    TypeError,
    "16-128 URL-safe characters",
  );
  await assertRejects(
    () =>
      recordAuditEvent(store, {
        ...base,
        action: "tool.publish",
        idempotencyKey: "Bearer secret-access-token",
      }),
    TypeError,
    "URL-safe characters",
  );
});

Deno.test("redaction never returns deep, cyclic, or oversized input raw", () => {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let depth = 0; depth < AUDIT_REDACTION_LIMITS.maxDepth + 4; depth += 1) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }
  cursor.value = "Bearer must-not-survive";
  root.self = root;
  root.items = Array.from(
    { length: AUDIT_REDACTION_LIMITS.maxCollectionEntries + 20 },
    (_, index) => `safe-${index}`,
  );
  root.large = "x".repeat(AUDIT_REDACTION_LIMITS.maxStringCharacters * 2);

  const serialized = JSON.stringify(redactAuditValue(root));
  assertEquals(serialized.includes("must-not-survive"), false);
  assertEquals(serialized.includes("[circular]"), true);
  assertEquals(serialized.includes("[truncated]"), true);
  assertEquals(
    serialized.length < AUDIT_REDACTION_LIMITS.maxTotalStringCharacters * 2,
    true,
  );
});

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

      const rows = await pool.query<{ idempotency_key: string }>(
        "select idempotency_key from relay.audit_events where target_id = $1",
        [event.targetId],
      );
      assertEquals(rows.rowCount, 1);
      assertNotEquals(rows.rows[0].idempotency_key, idempotencyKey);
      assertMatch(
        rows.rows[0].idempotency_key,
        /^v2:[0-9a-f]{64}:[0-9a-f]{64}$/,
      );
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "concurrent retries serialize to one audit event",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      const targetId = unique("concurrent-target");
      const event = {
        actorType: "system" as const,
        action: "provider.update",
        targetType: "provider",
        targetId,
        outcome: "success" as const,
        idempotencyKey: unique("concurrent-key"),
      };

      await Promise.all(
        Array.from({ length: 5 }, () => recordAuditEvent(pool, event)),
      );

      const rows = await pool.query(
        "select 1 from relay.audit_events where target_id = $1",
        [targetId],
      );
      assertEquals(rows.rowCount, 1);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "a changed secret conflicts even though both snapshots are redacted",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      const targetId = unique("secret-target");
      const event = {
        actorType: "system" as const,
        action: "provider.credential_state_change",
        targetType: "provider",
        targetId,
        outcome: "success" as const,
        beforeSnapshot: { apiKey: "sk-first-secret-value" },
        idempotencyKey: unique("secret-key"),
      };

      await recordAuditEvent(pool, event);
      await assertRejects(
        () =>
          recordAuditEvent(pool, {
            ...event,
            beforeSnapshot: { apiKey: "sk-second-secret-value" },
          }),
        AuditIdempotencyConflictError,
      );

      const rows = await pool.query<{ before_snapshot: unknown }>(
        "select before_snapshot from relay.audit_events where target_id = $1",
        [targetId],
      );
      assertEquals(rows.rows, [{ before_snapshot: { apiKey: "[redacted]" } }]);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "the same client idempotency key is independent across audit scopes",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      const targetId = unique("scoped-target");
      const idempotencyKey = unique("shared-scope-key");
      const base = {
        actorType: "system" as const,
        targetType: "tool",
        targetId,
        outcome: "success" as const,
        idempotencyKey,
      };

      await recordAuditEvent(pool, { ...base, action: "tool.publish" });
      await recordAuditEvent(pool, { ...base, action: "tool.disable" });

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
  name: "reusing an idempotency key for a different event fails",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      const idempotencyKey = unique("mismatch-key");
      const targetId = unique("target");
      await recordAuditEvent(pool, {
        actorType: "system",
        action: "tool.publish",
        targetType: "tool",
        targetId,
        outcome: "success",
        afterSnapshot: { lifecycle: "published" },
        idempotencyKey,
      });

      await assertRejects(
        () =>
          recordAuditEvent(pool, {
            actorType: "system",
            action: "tool.publish",
            targetType: "tool",
            targetId,
            outcome: "success",
            afterSnapshot: { lifecycle: "disabled" },
            idempotencyKey,
          }),
        AuditIdempotencyConflictError,
        "different event",
      );

      const rows = await pool.query<{ after_snapshot: unknown }>(
        "select after_snapshot from relay.audit_events where target_id = $1",
        [targetId],
      );
      assertEquals(rows.rows, [{ after_snapshot: { lifecycle: "published" } }]);
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
