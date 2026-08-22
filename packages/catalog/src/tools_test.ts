import { assertEquals, assertRejects } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { grantSuperadmin } from "@relay/auth";
import { createHandlerRegistry } from "./handlers.ts";
import {
  createToolVersion,
  publishToolVersion,
  registerTool,
  setToolLifecycle,
} from "./tools.ts";
import { validateCatalogHandlers } from "./validation.ts";

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

async function createSuperadmin(
  pool: DatabasePool,
): Promise<{ actorUserId: string; operatorId: string }> {
  const actorUserId = await createUser(pool);
  const operatorId = await createUser(pool);
  await grantSuperadmin(pool, actorUserId, operatorId);
  return { actorUserId, operatorId };
}

/**
 * `tools.active_version_id`/`tool_versions.tool_id` are mutually
 * referential (see 0013_tool_registry.ts), and `system_role_assignments
 * .granted_by`/`revoked_by` don't cascade -- deleting the operator/actor
 * pair in the same statement without clearing their grant row first can
 * hit the FK before the other row's cascade clears it (Postgres's per-
 * row RI trigger order isn't "all cascades, then all restricts"). Same
 * reasoning as packages/queue/src/test_support.ts's fixture cleanup;
 * left behind, any of this breaks packages/auth's tests, which do a
 * full-table `auth.user` reset assuming exclusive ownership.
 */
async function cleanupCatalogFixture(
  pool: DatabasePool,
  fixture: { toolId?: string; userIds: readonly string[] },
): Promise<void> {
  if (fixture.toolId) {
    await pool.query(
      "update relay.tools set active_version_id = null where id = $1",
      [fixture.toolId],
    );
    await pool.query("delete from relay.tool_versions where tool_id = $1", [
      fixture.toolId,
    ]);
    await pool.query("delete from relay.tools where id = $1", [
      fixture.toolId,
    ]);
  }
  await pool.query(
    "delete from relay.system_role_assignments where user_id = any($1::text[]) or granted_by = any($1::text[]) or revoked_by = any($1::text[])",
    [fixture.userIds],
  );
  await pool.query('delete from auth."user" where id = any($1::text[])', [
    fixture.userIds,
  ]);
}

function versionInput(toolId: string, overrides: Record<string, unknown> = {}) {
  return {
    toolId,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    handlerKey: "image.generate.v1",
    executionMode: "async",
    maxDurationSeconds: 120,
    ...overrides,
  };
}

Deno.test({
  name: "a non-superadmin cannot register a tool",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const userId = await createUser(pool);
    try {
      const key = unique("tool");
      const result = await registerTool(pool, userId, {
        key,
        name: "Image Generate",
        visibility: "public",
      });
      assertEquals(result.kind, "denied");

      const rows = await pool.query(
        "select id from relay.tools where key = $1",
        [
          key,
        ],
      );
      assertEquals(rows.rows.length, 0);
    } finally {
      await cleanupCatalogFixture(pool, { userIds: [userId] });
      await pool.end();
    }
  },
});

Deno.test({
  name: "registerTool creates a draft tool and records an audit event",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const { actorUserId, operatorId } = await createSuperadmin(pool);
    let toolId: string | undefined;
    try {
      const key = unique("tool");

      const result = await registerTool(pool, actorUserId, {
        key,
        name: "Image Generate",
        category: "image",
        summary: "Generates an image from a prompt",
        visibility: "public",
      });
      assertEquals(result.kind, "ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      toolId = result.value.toolId;

      const tool = await pool.query<{ lifecycle: string; key: string }>(
        "select lifecycle, key from relay.tools where id = $1",
        [result.value.toolId],
      );
      assertEquals(tool.rows[0].lifecycle, "draft");
      assertEquals(tool.rows[0].key, key);

      const audit = await pool.query<{ action: string }>(
        "select action from relay.audit_events where target_id = $1",
        [result.value.toolId],
      );
      assertEquals(
        audit.rows.some((r: { action: string }) =>
          r.action === "tool.register"
        ),
        true,
      );
    } finally {
      await cleanupCatalogFixture(pool, {
        toolId,
        userIds: [actorUserId, operatorId],
      });
      await pool.end();
    }
  },
});

Deno.test({
  name: "createToolVersion numbers versions sequentially per tool",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const { actorUserId, operatorId } = await createSuperadmin(pool);
    let toolId: string | undefined;
    try {
      const registered = await registerTool(pool, actorUserId, {
        key: unique("tool"),
        name: "Image Generate",
        visibility: "public",
      });
      if (registered.kind !== "ok") throw new Error("unreachable");
      toolId = registered.value.toolId;

      const first = await createToolVersion(
        pool,
        actorUserId,
        versionInput(toolId),
      );
      const second = await createToolVersion(
        pool,
        actorUserId,
        versionInput(toolId),
      );
      if (first.kind !== "ok" || second.kind !== "ok") {
        throw new Error("unreachable");
      }

      assertEquals(first.value.version, 1);
      assertEquals(second.value.version, 2);
    } finally {
      await cleanupCatalogFixture(pool, {
        toolId,
        userIds: [actorUserId, operatorId],
      });
      await pool.end();
    }
  },
});

Deno.test({
  name: "publishToolVersion refuses an unregistered handler",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const { actorUserId, operatorId } = await createSuperadmin(pool);
    let toolId: string | undefined;
    try {
      const registered = await registerTool(pool, actorUserId, {
        key: unique("tool"),
        name: "Image Generate",
        visibility: "public",
      });
      if (registered.kind !== "ok") throw new Error("unreachable");
      toolId = registered.value.toolId;
      const created = await createToolVersion(
        pool,
        actorUserId,
        versionInput(toolId, { handlerKey: "does.not.exist" }),
      );
      if (created.kind !== "ok") throw new Error("unreachable");

      const emptyRegistry = createHandlerRegistry();
      const result = await publishToolVersion(
        pool,
        actorUserId,
        created.value.toolVersionId,
        emptyRegistry,
      );
      assertEquals(result.kind, "unknown_handler");
      if (result.kind !== "unknown_handler") throw new Error("unreachable");
      assertEquals(result.handlerKey, "does.not.exist");

      const tool = await pool.query<
        { lifecycle: string; active_version_id: string | null }
      >(
        "select lifecycle, active_version_id from relay.tools where id = $1",
        [toolId],
      );
      assertEquals(tool.rows[0].lifecycle, "draft");
      assertEquals(tool.rows[0].active_version_id, null);
    } finally {
      await cleanupCatalogFixture(pool, {
        toolId,
        userIds: [actorUserId, operatorId],
      });
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "publishToolVersion activates the version and moves the tool to published",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const { actorUserId, operatorId } = await createSuperadmin(pool);
    let toolId: string | undefined;
    try {
      const registered = await registerTool(pool, actorUserId, {
        key: unique("tool"),
        name: "Image Generate",
        visibility: "public",
      });
      if (registered.kind !== "ok") throw new Error("unreachable");
      toolId = registered.value.toolId;
      await setToolLifecycle(pool, actorUserId, toolId, "internal");
      const created = await createToolVersion(
        pool,
        actorUserId,
        versionInput(toolId),
      );
      if (created.kind !== "ok") throw new Error("unreachable");

      const registry = createHandlerRegistry(["image.generate.v1"]);
      const published = await publishToolVersion(
        pool,
        actorUserId,
        created.value.toolVersionId,
        registry,
      );
      assertEquals(published.kind, "published");

      const tool = await pool.query<
        { lifecycle: string; active_version_id: string | null }
      >(
        "select lifecycle, active_version_id from relay.tools where id = $1",
        [toolId],
      );
      assertEquals(tool.rows[0].lifecycle, "published");
      assertEquals(tool.rows[0].active_version_id, created.value.toolVersionId);

      const version = await pool.query<{ published_at: Date | null }>(
        "select published_at from relay.tool_versions where id = $1",
        [created.value.toolVersionId],
      );
      assertEquals(version.rows[0].published_at !== null, true);

      // Publishing again must not be allowed to happen twice.
      const republished = await publishToolVersion(
        pool,
        actorUserId,
        created.value.toolVersionId,
        registry,
      );
      assertEquals(republished.kind, "already_published");

      // The database itself, not just publishToolVersion's own guard,
      // must refuse to let a behavior-defining column change once
      // published_at is set -- a compromised or buggy relay_app write
      // must not be able to silently redefine what a pinned version does.
      await assertRejects(
        () =>
          pool.query(
            "update relay.tool_versions set handler_key = 'evil.handler' where id = $1",
            [created.value.toolVersionId],
          ),
        Error,
        "immutable",
      );

      // Lifecycle metadata (deprecated_at/retired_at), unlike behavior
      // columns, must still be settable after publish.
      await pool.query(
        "update relay.tool_versions set deprecated_at = now() where id = $1",
        [created.value.toolVersionId],
      );
      const deprecated = await pool.query<{ deprecated_at: Date | null }>(
        "select deprecated_at from relay.tool_versions where id = $1",
        [created.value.toolVersionId],
      );
      assertEquals(deprecated.rows[0].deprecated_at !== null, true);
    } finally {
      await cleanupCatalogFixture(pool, {
        toolId,
        userIds: [actorUserId, operatorId],
      });
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "setToolLifecycle follows draft -> internal -> published(via publish) -> deprecated -> retired and rejects skips",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const { actorUserId, operatorId } = await createSuperadmin(pool);
    let toolId: string | undefined;
    try {
      const registered = await registerTool(pool, actorUserId, {
        key: unique("tool"),
        name: "Image Generate",
        visibility: "public",
      });
      if (registered.kind !== "ok") throw new Error("unreachable");
      toolId = registered.value.toolId;

      // draft -> retired directly is not allowed.
      const skip = await setToolLifecycle(pool, actorUserId, toolId, "retired");
      assertEquals(skip.kind, "invalid_transition");

      const toInternal = await setToolLifecycle(
        pool,
        actorUserId,
        toolId,
        "internal",
      );
      assertEquals(toInternal.kind, "ok");

      // setToolLifecycle never grants "published" -- that's publishToolVersion's job.
      const toPublished = await setToolLifecycle(
        pool,
        actorUserId,
        toolId,
        "published",
      );
      assertEquals(toPublished.kind, "invalid_transition");

      const created = await createToolVersion(
        pool,
        actorUserId,
        versionInput(toolId),
      );
      if (created.kind !== "ok") throw new Error("unreachable");
      const registry = createHandlerRegistry(["image.generate.v1"]);
      const published = await publishToolVersion(
        pool,
        actorUserId,
        created.value.toolVersionId,
        registry,
      );
      assertEquals(published.kind, "published");

      const toDeprecated = await setToolLifecycle(
        pool,
        actorUserId,
        toolId,
        "deprecated",
      );
      assertEquals(toDeprecated.kind, "ok");

      const toRetired = await setToolLifecycle(
        pool,
        actorUserId,
        toolId,
        "retired",
      );
      assertEquals(toRetired.kind, "ok");

      // retired is terminal.
      const afterRetired = await setToolLifecycle(
        pool,
        actorUserId,
        toolId,
        "disabled",
      );
      assertEquals(afterRetired.kind, "invalid_transition");
    } finally {
      await cleanupCatalogFixture(pool, {
        toolId,
        userIds: [actorUserId, operatorId],
      });
      await pool.end();
    }
  },
});

Deno.test({
  name: "disabled tools can be re-enabled to published or deprecated",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const { actorUserId, operatorId } = await createSuperadmin(pool);
    let toolId: string | undefined;
    try {
      const registered = await registerTool(pool, actorUserId, {
        key: unique("tool"),
        name: "Image Generate",
        visibility: "public",
      });
      if (registered.kind !== "ok") throw new Error("unreachable");
      toolId = registered.value.toolId;
      await setToolLifecycle(pool, actorUserId, toolId, "internal");
      const created = await createToolVersion(
        pool,
        actorUserId,
        versionInput(toolId),
      );
      if (created.kind !== "ok") throw new Error("unreachable");
      const registry = createHandlerRegistry(["image.generate.v1"]);
      await publishToolVersion(
        pool,
        actorUserId,
        created.value.toolVersionId,
        registry,
      );

      const disabled = await setToolLifecycle(
        pool,
        actorUserId,
        toolId,
        "disabled",
      );
      assertEquals(disabled.kind, "ok");

      const reEnabled = await setToolLifecycle(
        pool,
        actorUserId,
        toolId,
        "published",
      );
      assertEquals(reEnabled.kind, "ok");

      const tool = await pool.query<{ lifecycle: string }>(
        "select lifecycle from relay.tools where id = $1",
        [toolId],
      );
      assertEquals(tool.rows[0].lifecycle, "published");
    } finally {
      await cleanupCatalogFixture(pool, {
        toolId,
        userIds: [actorUserId, operatorId],
      });
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "validateCatalogHandlers reports published versions with missing handlers",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const { actorUserId, operatorId } = await createSuperadmin(pool);
    let toolId: string | undefined;
    try {
      const registered = await registerTool(pool, actorUserId, {
        key: unique("tool"),
        name: "Image Generate",
        visibility: "public",
      });
      if (registered.kind !== "ok") throw new Error("unreachable");
      toolId = registered.value.toolId;
      await setToolLifecycle(pool, actorUserId, toolId, "internal");
      const handlerKey = unique("handler");
      const created = await createToolVersion(
        pool,
        actorUserId,
        versionInput(toolId, { handlerKey }),
      );
      if (created.kind !== "ok") throw new Error("unreachable");

      // Publish with the handler present, then validate against a
      // registry that no longer has it (simulating a deploy that
      // removed the handler after publish).
      const withHandler = createHandlerRegistry([handlerKey]);
      const published = await publishToolVersion(
        pool,
        actorUserId,
        created.value.toolVersionId,
        withHandler,
      );
      assertEquals(published.kind, "published");

      const withoutHandler = createHandlerRegistry();
      const report = await validateCatalogHandlers(pool, withoutHandler);
      assertEquals(
        report.publishedVersionsWithMissingHandlers.some(
          (entry: { toolVersionId: string }) =>
            entry.toolVersionId === created.value.toolVersionId,
        ),
        true,
      );

      const cleanReport = await validateCatalogHandlers(pool, withHandler);
      assertEquals(
        cleanReport.publishedVersionsWithMissingHandlers.some(
          (entry: { toolVersionId: string }) =>
            entry.toolVersionId === created.value.toolVersionId,
        ),
        false,
      );
    } finally {
      await cleanupCatalogFixture(pool, {
        toolId,
        userIds: [actorUserId, operatorId],
      });
      await pool.end();
    }
  },
});
