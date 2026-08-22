import { assertEquals, assertRejects } from "@std/assert";
import pg from "pg";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { createHandlerRegistry } from "./handlers.ts";
import {
  createToolVersion,
  publishToolVersion,
  registerTool,
  setToolLifecycle,
  setToolReadinessCritical,
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

  // A fresh database has no superadmin who can authorize the first grant.
  // Bootstrap only this test fixture through the local migrator role, mirroring
  // the deployment-time operator provisioning boundary rather than adding a
  // production backdoor to the auth service.
  const ownerUrl = new URL(databaseUrl!);
  ownerUrl.username = "relay_migrator";
  ownerUrl.password = "relay_dev_only";
  const client = new pg.Client({ connectionString: ownerUrl.toString() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local role relay_owner");
    await client.query(
      `insert into relay.system_role_assignments (user_id, role, granted_by)
       values ($1, 'superadmin', $2)`,
      [actorUserId, operatorId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
  return { actorUserId, operatorId };
}

const FOREIGN_KEY_VIOLATION = "23503";

/** See packages/queue/src/test_support.ts's tryDelete for why this tolerates exactly a foreign-key violation. */
async function tryDelete(
  pool: DatabasePool,
  sqlText: string,
  params: readonly unknown[],
): Promise<void> {
  try {
    await pool.query(sqlText, params as unknown[]);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === FOREIGN_KEY_VIOLATION) {
      return;
    }
    throw error;
  }
}

/**
 * `tools.active_version_id`/`tool_versions.tool_id` are mutually
 * referential (see 0013_tool_registry.ts). relay_app also has no DELETE
 * on relay.system_role_assignments at all
 * (0023_system_role_assignment_immutability.ts) -- only a cascade from
 * deleting the grant's own user_id removes it; granted_by/revoked_by
 * never cascade. `createSuperadmin` always returns `[actorUserId,
 * operatorId]` with actorUserId as the grantee, so every caller's
 * `userIds` has the grantee first -- deleting it first cascades its
 * grant row away before the operator (referenced as granted_by) is
 * processed. Left behind, any of this breaks packages/auth's tests,
 * which used to do a full-table `auth.user` reset assuming exclusive
 * ownership -- no longer true (see auth_test.ts), but scoped deletes
 * here are still correct on their own merits.
 */
async function cleanupCatalogFixture(
  pool: DatabasePool,
  fixture: { toolId?: string; userIds: readonly string[] },
): Promise<void> {
  if (fixture.toolId) {
    await pool.query(
      `update relay.tools
          set lifecycle = 'retired', active_version_id = null
        where id = $1`,
      [fixture.toolId],
    );
    // Published tool_versions rows are immutable against deletion too
    // (0022_tool_version_delete_and_routing_policy_immutability.ts), so
    // only unpublished ones can actually be cleaned up here. A fixture
    // that published a version deliberately leaves that version (and,
    // since tool_versions.tool_id still references it, its parent tools
    // row) behind -- harmless residue scoped by this file's unique()
    // tool keys, not a real leak, and exactly the real-world consequence
    // of the immutability guarantee under test elsewhere in this file.
    await pool.query(
      "delete from relay.tool_versions where tool_id = $1 and published_at is null",
      [fixture.toolId],
    );
    const remaining = await pool.query(
      "select 1 from relay.tool_versions where tool_id = $1 limit 1",
      [fixture.toolId],
    );
    if (remaining.rows.length === 0) {
      await pool.query("delete from relay.tools where id = $1", [
        fixture.toolId,
      ]);
    }
  }
  if (fixture.userIds.length > 0) {
    const ownerUrl = new URL(databaseUrl!);
    ownerUrl.username = "relay_migrator";
    ownerUrl.password = "relay_dev_only";
    const owner = new pg.Client({ connectionString: ownerUrl.toString() });
    await owner.connect();
    try {
      await owner.query("begin");
      await owner.query("set local role relay_owner");
      await owner.query(
        "delete from relay.system_role_assignments where user_id = any($1::text[])",
        [[...fixture.userIds]],
      );
      await owner.query("commit");
    } catch (error) {
      await owner.query("rollback");
      throw error;
    } finally {
      await owner.end();
    }
  }
  for (const userId of fixture.userIds) {
    await tryDelete(pool, 'delete from auth."user" where id = $1', [userId]);
  }
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
        readinessCritical: true,
      });
      assertEquals(result.kind, "ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      toolId = result.value.toolId;

      const tool = await pool.query<{
        lifecycle: string;
        key: string;
        readiness_critical: boolean;
      }>(
        "select lifecycle, key, readiness_critical from relay.tools where id = $1",
        [result.value.toolId],
      );
      assertEquals(tool.rows[0].lifecycle, "draft");
      assertEquals(tool.rows[0].key, key);
      assertEquals(tool.rows[0].readiness_critical, true);

      assertEquals(
        await setToolReadinessCritical(pool, actorUserId, toolId, false),
        { kind: "ok" },
      );
      const readiness = await pool.query<{ readiness_critical: boolean }>(
        "select readiness_critical from relay.tools where id = $1",
        [toolId],
      );
      assertEquals(readiness.rows[0].readiness_critical, false);

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
  name:
    "concurrent createToolVersion calls for the same tool never throw and number sequentially",
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
      const registeredToolId = registered.value.toolId;
      toolId = registeredToolId;

      // Every caller initially races for the same max(version). The parent
      // tool-row lock must serialize all of them, not merely make a
      // two-request race unlikely.
      const results = await Promise.all(
        Array.from(
          { length: 5 },
          () =>
            createToolVersion(
              pool,
              actorUserId,
              versionInput(registeredToolId),
            ),
        ),
      );

      assertEquals(results.every((result) => result.kind === "ok"), true);
      const versions = results.map((result) => {
        if (result.kind !== "ok") {
          throw new Error(`expected success, got ${result.kind}`);
        }
        return result.value.version;
      }).sort((a, b) => a - b);
      assertEquals(versions, [1, 2, 3, 4, 5]);
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
  name: "tool-version hashes cover and validate the complete contract",
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
        versionInput(toolId, {
          meterPolicyId: "meter.test",
          entitlementKey: "entitlement.test",
          inputSchemaVersion: 2,
          handlerVersion: "2026.08",
          compatibilityMetadata: { protocol: 2 },
        }),
      );
      if (created.kind !== "ok") throw new Error("unreachable");

      const { rows } = await pool.query<{
        immutable_hash: string;
        expected_hash: string;
      }>(
        `select immutable_hash,
                relay.compute_tool_version_immutable_hash(
                  id, tool_id, version, input_schema, output_schema,
                  handler_key, input_schema_version, handler_version,
                  execution_mode, max_duration_seconds, meter_policy_id,
                  entitlement_key, compatibility_metadata
                ) as expected_hash
         from relay.tool_versions
         where id = $1`,
        [created.value.toolVersionId],
      );
      assertEquals(rows[0].immutable_hash, rows[0].expected_hash);
      assertEquals(rows[0].immutable_hash.length, 64);

      // Draft edits remain deploy-compatible with the previous writer: the
      // database owns canonical hash maintenance until publication.
      const originalHash = rows[0].immutable_hash;
      await pool.query(
        "update relay.tool_versions set meter_policy_id = 'meter.other' where id = $1",
        [created.value.toolVersionId],
      );
      const updated = await pool.query<{
        immutable_hash: string;
        expected_hash: string;
      }>(
        `select immutable_hash,
                relay.compute_tool_version_immutable_hash(
                  id, tool_id, version, input_schema, output_schema,
                  handler_key, input_schema_version, handler_version,
                  execution_mode, max_duration_seconds, meter_policy_id,
                  entitlement_key, compatibility_metadata
                ) as expected_hash
           from relay.tool_versions
          where id = $1`,
        [created.value.toolVersionId],
      );
      assertEquals(
        updated.rows[0].immutable_hash,
        updated.rows[0].expected_hash,
      );
      assertEquals(updated.rows[0].immutable_hash === originalHash, false);
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
  name: "createToolVersion reports not_found for a nonexistent tool",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const { actorUserId, operatorId } = await createSuperadmin(pool);
    try {
      const result = await createToolVersion(
        pool,
        actorUserId,
        versionInput(unique("tool_nonexistent")),
      );
      assertEquals(result.kind, "not_found");
    } finally {
      await cleanupCatalogFixture(pool, {
        toolId: undefined,
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
  name: "publishToolVersion refuses incompatible handler metadata",
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
        versionInput(toolId, {
          inputSchemaVersion: 2,
          handlerVersion: "2026.08",
        }),
      );
      if (created.kind !== "ok") throw new Error("unreachable");

      const result = await publishToolVersion(
        pool,
        actorUserId,
        created.value.toolVersionId,
        createHandlerRegistry([{
          key: "image.generate.v1",
          inputSchemaVersion: 1,
          handlerVersion: "2026.07",
        }]),
      );
      assertEquals(result, {
        kind: "incompatible_handler",
        handlerKey: "image.generate.v1",
        expected: { inputSchemaVersion: 2, handlerVersion: "2026.08" },
        registered: { inputSchemaVersion: 1, handlerVersion: "2026.07" },
      });
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

      // Published means the complete version row is frozen. Lifecycle is
      // represented by relay.tools; even the version's old lifecycle
      // timestamp columns and created_at cannot be rewritten afterward.
      for (
        const statement of [
          "update relay.tool_versions set deprecated_at = now() where id = $1",
          "update relay.tool_versions set retired_at = now() where id = $1",
          "update relay.tool_versions set created_at = now() where id = $1",
          "update relay.tool_versions set published_at = now() where id = $1",
        ]
      ) {
        await assertRejects(
          () => pool.query(statement, [created.value.toolVersionId]),
          Error,
          "fully immutable",
        );
      }

      // Immutable must also mean "cannot be deleted," not just
      // "cannot be updated" -- deleting a published version would erase
      // the exact pinned record the update trigger exists to protect.
      await assertRejects(
        () =>
          pool.query(
            "delete from relay.tool_versions where id = $1",
            [created.value.toolVersionId],
          ),
        Error,
        "immutable",
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
