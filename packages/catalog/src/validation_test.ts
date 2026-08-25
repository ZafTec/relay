import { assertEquals } from "@std/assert";
import pg from "pg";
import { createHandlerRegistry } from "./handlers.ts";
import {
  type CatalogQueryExecutor,
  type CatalogRouteSelection,
  createCatalogValidationService,
  isCatalogRoutingPolicyDocument,
  persistCatalogRoutingDecision,
  resolveCatalogRoute,
  validateRoutingDecisionForRun,
} from "./validation.ts";

const TOOL_VERSION_ID = "tver_test";
const TOOL_VERSION_HASH = "a".repeat(64);
const HANDLER_KEY = "image.generate.v1";

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    tool_id: "tool_test",
    tool_lifecycle: "published",
    readiness_critical: false,
    active_version_id: TOOL_VERSION_ID,
    tool_version_id: TOOL_VERSION_ID,
    handler_key: HANDLER_KEY,
    input_schema_version: 2,
    handler_version: "2026.08",
    tool_version_immutable_hash: TOOL_VERSION_HASH,
    published_at: new Date("2026-01-01T00:00:00Z"),
    immutable_hash_valid: true,
    binding_id: 1,
    provider_model_id: 101,
    capacity_pool_id: 201,
    routing_order: 1,
    binding_enabled: true,
    routing_policy_id: null,
    routing_policy_revision: null,
    routing_policy_immutable_hash: null,
    routing_policy_hash_valid: null,
    routing_policy_effective: null,
    routing_policy_fallback_mode: null,
    provider_id: 301,
    provider_lifecycle: "published",
    provider_model_lifecycle: "published",
    capacity_pool_enabled: true,
    capacity_pool_provider_model_id: null,
    ...overrides,
  };
}

function fallbackPolicy(overrides: Record<string, unknown> = {}) {
  return {
    routing_policy_id: 501,
    routing_policy_revision: 7,
    routing_policy_immutable_hash: "b".repeat(64),
    routing_policy_hash_valid: true,
    routing_policy_effective: true,
    routing_policy_fallback_mode: "ordered",
    ...overrides,
  };
}

function decisionRow(overrides: Record<string, unknown> = {}) {
  return {
    run_tool_version_id: TOOL_VERSION_ID,
    decision_id: 50,
    decision_tool_id: "tool_test",
    decision_tool_version_id: TOOL_VERSION_ID,
    decision_tool_version_hash: TOOL_VERSION_HASH,
    decision_handler_key: HANDLER_KEY,
    decision_input_schema_version: 2,
    decision_handler_version: "2026.08",
    selected_binding_id: 1,
    decision_provider_id: 301,
    decision_provider_model_id: 101,
    decision_capacity_pool_id: 201,
    decision_routing_order: 1,
    decision_policy_id: null,
    decision_policy_revision: null,
    decision_policy_hash: null,
    requested_model_version: null,
    fallback_used: false,
    fallback_reason: null,
    current_tool_id: "tool_test",
    current_tool_version_hash: TOOL_VERSION_HASH,
    current_handler_key: HANDLER_KEY,
    current_input_schema_version: 2,
    current_handler_version: "2026.08",
    version_published: true,
    tool_lifecycle: "published",
    immutable_hash_valid: true,
    current_binding_id: 1,
    binding_tool_version_id: TOOL_VERSION_ID,
    binding_provider_model_id: 101,
    binding_capacity_pool_id: 201,
    binding_routing_order: 1,
    binding_policy_id: null,
    binding_enabled: true,
    model_provider_id: 301,
    provider_lifecycle: "published",
    provider_model_lifecycle: "published",
    capacity_pool_enabled: true,
    capacity_pool_provider_model_id: null,
    current_policy_revision: null,
    current_policy_hash: null,
    routing_policy_hash_valid: null,
    routing_policy_effective: null,
    routing_policy_fallback_mode: null,
    ...overrides,
  };
}

interface FakeQueryable extends CatalogQueryExecutor {
  readonly calls: { text: string; params?: unknown[] }[];
}

function fakeQueryable(input: {
  readonly routeRows?: readonly Record<string, unknown>[];
  readonly decision?: Record<string, unknown>;
  readonly readinessRows?: readonly Record<string, unknown>[];
  readonly handlerRows?: readonly Record<string, unknown>[];
  readonly persistedDecision?: Record<string, unknown>;
}): FakeQueryable {
  const calls: { text: string; params?: unknown[] }[] = [];
  const query = (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    if (text.includes("insert into relay.routing_decisions")) {
      return Promise.resolve({
        rows: [{
          id: 50,
          tool_id: params?.[1],
          tool_version_id: params?.[2],
          tool_version_immutable_hash: params?.[3],
          handler_key: params?.[4],
          input_schema_version: params?.[5],
          handler_version: params?.[6],
          selected_binding_id: params?.[7],
          provider_id: params?.[8],
          provider_model_id: params?.[9],
          capacity_pool_id: params?.[10],
          routing_order: params?.[11],
          routing_policy_id: params?.[12],
          routing_policy_revision: params?.[13],
          routing_policy_immutable_hash: params?.[14],
          requested_model_version: params?.[15],
          fallback_used: params?.[16],
          fallback_reason: params?.[17],
          ...input.persistedDecision,
        }],
      });
    }
    if (text.includes("from relay.tool_runs tr")) {
      return Promise.resolve({
        rows: input.decision === undefined ? [] : [input.decision],
      });
    }
    if (text.includes("where tv.published_at is not null")) {
      return Promise.resolve({ rows: [...(input.readinessRows ?? [])] });
    }
    if (text.includes("where tv.id = $1")) {
      return Promise.resolve({ rows: [...(input.routeRows ?? [])] });
    }
    if (text.includes("from relay.tool_versions")) {
      return Promise.resolve({ rows: [...(input.handlerRows ?? [])] });
    }
    return Promise.reject(new Error(`unexpected catalog query: ${text}`));
  };
  return { query: query as CatalogQueryExecutor["query"], calls };
}

Deno.test("routing policy documents expose an explicit fallback mode", () => {
  assertEquals(isCatalogRoutingPolicyDocument({}), true);
  assertEquals(
    isCatalogRoutingPolicyDocument({ fallback: { mode: "ordered" } }),
    true,
  );
  assertEquals(
    isCatalogRoutingPolicyDocument({ fallback: { mode: "automatic" } }),
    false,
  );
  assertEquals(isCatalogRoutingPolicyDocument({ fallback: true }), false);
});

function compatibleHandlers() {
  return createHandlerRegistry([{
    key: HANDLER_KEY,
    inputSchemaVersion: 2,
    handlerVersion: "2026.08",
  }]);
}

Deno.test("removing a handler immediately makes its published route unavailable", async () => {
  const handlers = compatibleHandlers();
  const service = createCatalogValidationService(
    fakeQueryable({ routeRows: [snapshotRow()] }),
    handlers,
  );

  assertEquals((await service.resolveRoute(TOOL_VERSION_ID)).kind, "available");
  assertEquals(handlers.unregister(HANDLER_KEY), true);
  const after = await service.resolveRoute(TOOL_VERSION_ID);
  assertEquals(after.kind, "unavailable");
  assertEquals(after.issues.map((issue) => issue.code), [
    "handler_not_registered",
  ]);
});

Deno.test("handler schema and implementation versions are checked", async () => {
  const result = await resolveCatalogRoute(
    fakeQueryable({ routeRows: [snapshotRow()] }),
    createHandlerRegistry([{
      key: HANDLER_KEY,
      inputSchemaVersion: 1,
      handlerVersion: "2026.07",
    }]),
    TOOL_VERSION_ID,
  );

  assertEquals(result.kind, "unavailable");
  assertEquals(result.issues[0], {
    code: "handler_compatibility_mismatch",
    toolId: "tool_test",
    toolVersionId: TOOL_VERSION_ID,
    handlerKey: HANDLER_KEY,
    expectedCompatibility: {
      inputSchemaVersion: 2,
      handlerVersion: "2026.08",
    },
    registeredCompatibility: {
      inputSchemaVersion: 1,
      handlerVersion: "2026.07",
    },
  });
});

Deno.test("an invalid immutable hash makes a version unavailable", async () => {
  const result = await resolveCatalogRoute(
    fakeQueryable({
      routeRows: [snapshotRow({ immutable_hash_valid: false })],
    }),
    compatibleHandlers(),
    TOOL_VERSION_ID,
  );

  assertEquals(result.kind, "unavailable");
  assertEquals(result.issues.map((issue) => issue.code), [
    "immutable_hash_mismatch",
  ]);
});

Deno.test("fallback requires an effective, hash-valid ordered policy", async () => {
  const denied = await resolveCatalogRoute(
    fakeQueryable({
      routeRows: [
        snapshotRow({ binding_id: 1, binding_enabled: false }),
        snapshotRow({
          binding_id: 2,
          provider_model_id: 102,
          capacity_pool_id: 202,
          provider_id: 302,
          routing_order: 2,
        }),
      ],
    }),
    compatibleHandlers(),
    TOOL_VERSION_ID,
  );
  assertEquals(denied.kind, "unavailable");
  assertEquals(denied.issues.map((issue) => issue.code), [
    "binding_disabled",
    "fallback_not_permitted",
  ]);

  const allowed = await resolveCatalogRoute(
    fakeQueryable({
      routeRows: [
        snapshotRow({ binding_id: 1, binding_enabled: false }),
        snapshotRow({
          binding_id: 2,
          provider_model_id: 102,
          capacity_pool_id: 202,
          provider_id: 302,
          routing_order: 2,
          ...fallbackPolicy(),
        }),
      ],
    }),
    compatibleHandlers(),
    TOOL_VERSION_ID,
  );
  assertEquals(allowed.kind, "available");
  if (allowed.kind !== "available") throw new Error("unreachable");
  assertEquals(allowed.route.bindingId, "2");
  assertEquals(allowed.fallback, { used: true, reason: "binding_disabled" });

  const futurePrimaryPolicy = await resolveCatalogRoute(
    fakeQueryable({
      routeRows: [
        snapshotRow({
          ...fallbackPolicy({ routing_policy_effective: false }),
        }),
        snapshotRow({
          binding_id: 2,
          provider_model_id: 102,
          capacity_pool_id: 202,
          provider_id: 302,
          routing_order: 2,
          ...fallbackPolicy({ routing_policy_id: 502 }),
        }),
      ],
    }),
    compatibleHandlers(),
    TOOL_VERSION_ID,
  );
  assertEquals(futurePrimaryPolicy.kind, "available");
  if (futurePrimaryPolicy.kind !== "available") {
    throw new Error("unreachable");
  }
  assertEquals(futurePrimaryPolicy.fallback, {
    used: true,
    reason: "routing_policy_not_effective",
  });
});

Deno.test("invalid routing policy hashes fail closed", async () => {
  const result = await resolveCatalogRoute(
    fakeQueryable({
      routeRows: [snapshotRow({
        ...fallbackPolicy({ routing_policy_hash_valid: false }),
      })],
    }),
    compatibleHandlers(),
    TOOL_VERSION_ID,
  );

  assertEquals(result.kind, "unavailable");
  assertEquals(result.issues.map((issue) => issue.code), [
    "routing_policy_hash_mismatch",
  ]);
});

Deno.test("duplicate routing order is treated as corruption and fails closed", async () => {
  const result = await resolveCatalogRoute(
    fakeQueryable({
      routeRows: [
        snapshotRow({ binding_id: 1 }),
        snapshotRow({
          binding_id: 2,
          provider_model_id: 102,
          capacity_pool_id: 202,
          provider_id: 302,
        }),
      ],
    }),
    compatibleHandlers(),
    TOOL_VERSION_ID,
  );

  assertEquals(result.kind, "unavailable");
  assertEquals(
    result.issues.filter((issue) => issue.code === "duplicate_routing_order")
      .length,
    2,
  );
});

Deno.test("readiness uses one snapshot and only critical active versions gate", async () => {
  const noncritical = fakeQueryable({
    readinessRows: [snapshotRow({ binding_enabled: false })],
  });
  const noncriticalService = createCatalogValidationService(
    noncritical,
    compatibleHandlers(),
  );
  assertEquals(await noncriticalService.checkReadiness(), {
    name: "catalog",
    status: "ok",
  });
  assertEquals(noncritical.calls.length, 1);

  const critical = fakeQueryable({
    readinessRows: [snapshotRow({
      binding_enabled: false,
      readiness_critical: true,
    })],
  });
  const criticalService = createCatalogValidationService(
    critical,
    compatibleHandlers(),
  );
  assertEquals(await criticalService.checkReadiness(), {
    name: "catalog",
    status: "error",
    message: "critical catalog routes are unavailable or inconsistent",
  });
  assertEquals(critical.calls.length, 1);
});

Deno.test("a non-active version of a critical tool does not gate readiness", async () => {
  const db = fakeQueryable({
    readinessRows: [snapshotRow({
      binding_enabled: false,
      readiness_critical: true,
      active_version_id: "tver_other",
    })],
  });
  assertEquals(
    await createCatalogValidationService(db, compatibleHandlers())
      .checkReadiness(),
    { name: "catalog", status: "ok" },
  );
});

Deno.test("persistCatalogRoutingDecision writes the complete route snapshot", async () => {
  const db = fakeQueryable({
    persistedDecision: {
      id: 88,
      fallback_used: true,
      fallback_reason: "provider_disabled",
    },
  });
  const selection: CatalogRouteSelection = {
    route: {
      toolId: "tool_test",
      toolVersionId: TOOL_VERSION_ID,
      toolVersionImmutableHash: TOOL_VERSION_HASH,
      handlerKey: HANDLER_KEY,
      inputSchemaVersion: 2,
      handlerVersion: "2026.08",
      bindingId: "2",
      providerId: "302",
      providerModelId: "102",
      capacityPoolId: "202",
      routingOrder: 2,
      routingPolicyId: "501",
      routingPolicyRevision: 7,
      routingPolicyImmutableHash: "b".repeat(64),
    },
    fallback: { used: true, reason: "provider_disabled" },
  };

  const persisted = await persistCatalogRoutingDecision(
    db,
    "run_test",
    selection,
    { requestedModelVersion: "model-2026-08" },
  );

  assertEquals(persisted, {
    decisionId: "88",
    requestedModelVersion: "model-2026-08",
    route: selection.route,
    fallback: { used: true, reason: "provider_disabled" },
  });
  assertEquals(db.calls[0].params, [
    "run_test",
    "tool_test",
    TOOL_VERSION_ID,
    TOOL_VERSION_HASH,
    HANDLER_KEY,
    2,
    "2026.08",
    "2",
    "302",
    "102",
    "202",
    2,
    "501",
    7,
    "b".repeat(64),
    "model-2026-08",
    true,
    "provider_disabled",
  ]);
});

Deno.test("dispatch validation returns the immutable decision snapshot", async () => {
  const result = await validateRoutingDecisionForRun(
    fakeQueryable({ decision: decisionRow() }),
    compatibleHandlers(),
    "run_test",
  );

  assertEquals(result.kind, "available");
  if (result.kind !== "available") throw new Error("unreachable");
  assertEquals(result.value.route.capacityPoolId, "201");
  assertEquals(result.value.route.toolVersionImmutableHash, TOOL_VERSION_HASH);
  assertEquals(result.value.fallback, { used: false, reason: null });
});

Deno.test("dispatch validation rejects a contradictory decision snapshot", async () => {
  const result = await validateRoutingDecisionForRun(
    fakeQueryable({
      decision: decisionRow({ binding_capacity_pool_id: 999 }),
    }),
    compatibleHandlers(),
    "run_test",
  );

  assertEquals(result.kind, "unavailable");
  assertEquals(
    result.issues.some((issue) =>
      issue.code === "routing_decision_capacity_pool_mismatch"
    ),
    true,
  );
});

const databaseUrl = Deno.env.get("DATABASE_URL");

Deno.test({
  name:
    "catalog resolves, persists, and revalidates a policy-authorized fallback",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const ownerUrl = new URL(databaseUrl!);
    ownerUrl.username = "relay_migrator";
    ownerUrl.password = "relay_dev_only";
    const client = new pg.Client({ connectionString: ownerUrl.toString() });
    await client.connect();
    await client.query("begin");
    try {
      await client.query("set local role relay_owner");
      const suffix = crypto.randomUUID();
      const userId = `user_${suffix}`;
      const workspaceId = `org_${suffix}`;
      const toolId = `tool_${suffix}`;
      const toolVersionId = `tver_${suffix}`;
      const runId = `run_${suffix}`;

      await client.query(
        `insert into auth."user" (id, name, email, "emailVerified")
         values ($1, 'Test', $2, true)`,
        [userId, `${suffix}@example.com`],
      );
      await client.query(
        `insert into auth.organization (id, name, slug, "createdAt")
         values ($1, 'Test', $2, now())`,
        [workspaceId, `catalog-validation-${suffix}`],
      );
      await client.query(
        `insert into relay.tools
           (id, key, name, lifecycle, visibility, readiness_critical)
         values ($1, $2, 'Test', 'internal', 'internal', true)`,
        [toolId, `catalog.validation.${suffix}`],
      );
      await client.query(
        `insert into relay.tool_versions
           (id, tool_id, version, input_schema, output_schema, handler_key,
            input_schema_version, handler_version, execution_mode,
            max_duration_seconds, published_at, immutable_hash)
         values (
           $1, $2, 1, '{}', '{}', $3, 2, '2026.08', 'async', 30, now(),
           relay.compute_tool_version_immutable_hash(
             $1, $2, 1, '{}', '{}', $3, 2, '2026.08',
             'async', 30, null, null, null
           )
         )`,
        [toolVersionId, toolId, HANDLER_KEY],
      );
      await client.query(
        `update relay.tools
            set lifecycle = 'published', active_version_id = $2
          where id = $1`,
        [toolId, toolVersionId],
      );

      const provider = await client.query<{ id: string }>(
        `insert into relay.providers (key, name, lifecycle)
         values ($1, 'Test provider', 'published') returning id`,
        [`provider.${suffix}`],
      );
      const firstModel = await client.query<{ id: string }>(
        `insert into relay.provider_models
           (provider_id, key, display_name, lifecycle)
         values ($1, $2, 'Primary', 'published') returning id`,
        [provider.rows[0].id, `model.primary.${suffix}`],
      );
      const fallbackModel = await client.query<{ id: string }>(
        `insert into relay.provider_models
           (provider_id, key, display_name, lifecycle)
         values ($1, $2, 'Fallback', 'published') returning id`,
        [provider.rows[0].id, `model.fallback.${suffix}`],
      );
      const firstPool = await client.query<{ id: string }>(
        `insert into relay.capacity_pools
           (key, provider_model_id, execution_class, enabled)
         values ($1, $2, 'standard', false) returning id`,
        [`pool.primary.${suffix}`, firstModel.rows[0].id],
      );
      const fallbackPool = await client.query<{ id: string }>(
        `insert into relay.capacity_pools
           (key, provider_model_id, execution_class)
         values ($1, $2, 'standard') returning id`,
        [`pool.fallback.${suffix}`, fallbackModel.rows[0].id],
      );
      const policy = await client.query<{ id: string }>(
        `insert into relay.routing_policies (revision, policy)
         select coalesce(max(revision), 0) + 1,
                '{"fallback":{"mode":"ordered"}}'::jsonb
           from relay.routing_policies
         returning id`,
      );
      await client.query(
        `insert into relay.tool_provider_bindings
           (tool_version_id, provider_model_id, capacity_pool_id,
            routing_order, routing_policy_id)
         values ($1, $2, $3, 1, null),
                ($1, $4, $5, 2, $6)`,
        [
          toolVersionId,
          firstModel.rows[0].id,
          firstPool.rows[0].id,
          fallbackModel.rows[0].id,
          fallbackPool.rows[0].id,
          policy.rows[0].id,
        ],
      );
      await client.query(
        `insert into relay.tool_runs
           (id, workspace_id, tool_version_id, status, input, created_by)
         values ($1, $2, $3, 'queued', '{}', $4)`,
        [runId, workspaceId, toolVersionId, userId],
      );

      const queryable = client as unknown as CatalogQueryExecutor;
      const handlers = compatibleHandlers();
      const service = createCatalogValidationService(queryable, handlers);
      const resolved = await service.resolveRoute(toolVersionId);
      assertEquals(resolved.kind, "available");
      if (resolved.kind !== "available") throw new Error("unreachable");
      assertEquals(resolved.fallback, {
        used: true,
        reason: "capacity_pool_disabled",
      });

      const persisted = await persistCatalogRoutingDecision(
        queryable,
        runId,
        resolved,
      );
      assertEquals(persisted.fallback, resolved.fallback);
      assertEquals(
        (await service.validateRoutingDecisionForRun(runId)).kind,
        "available",
      );
      assertEquals(await service.checkReadiness(), {
        name: "catalog",
        status: "ok",
      });

      await client.query(
        "update relay.tool_provider_bindings set enabled = false where id = $1",
        [resolved.route.bindingId],
      );
      const disabledDecision = await service.validateRoutingDecisionForRun(
        runId,
      );
      assertEquals(disabledDecision.kind, "unavailable");
      assertEquals(
        disabledDecision.issues.some((issue) =>
          issue.code === "binding_disabled"
        ),
        true,
      );
      assertEquals(await service.checkReadiness(), {
        name: "catalog",
        status: "error",
        message: "critical catalog routes are unavailable or inconsistent",
      });
    } finally {
      await client.query("rollback");
      await client.end();
    }
  },
});
