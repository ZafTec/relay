import type { DatabasePool } from "@relay/database";
import { grantSuperadmin } from "@relay/auth";
import {
  createHandlerRegistry,
  createToolVersion,
  publishToolVersion,
  registerTool,
  setToolLifecycle,
} from "@relay/catalog";

const FOREIGN_KEY_VIOLATION = "23503";

/**
 * `relay.routing_decisions` being insert-only for `relay_app`
 * (0018_tool_version_and_routing_immutability.ts) means any row that
 * references one -- directly (tool_runs) or transitively
 * (tool_provider_bindings via selected_binding_id, then providers/
 * provider_models/capacity_pools via that binding) -- can't actually be
 * deleted once a fixture has successfully admitted at least once. Rather
 * than precisely re-deriving which of those chains are still blocked for
 * every caller, this tolerates exactly a foreign-key violation (Postgres
 * 23503) as "still referenced, leave it" and re-throws anything else --
 * the same harmless-residue reasoning `cleanupAdmissibleFixture` already
 * applies explicitly to tool_versions/tool_runs below.
 */
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
 * Shared fixture for admission_test.ts/dispatch_test.ts/pipeline_test.ts:
 * everything `admitToolRun` now requires since it authorizes against
 * real workspace membership and the real catalog (workspace + member,
 * a published tool version with an enabled provider binding). Centralized
 * here rather than duplicated per file -- unlike the smaller
 * createUser/createOrganization helpers this codebase otherwise
 * duplicates per test file, this fixture chain is long enough that
 * three copies would be a real maintenance liability.
 */
export interface AdmissibleFixture {
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly toolId: string;
  readonly toolVersionId: string;
  readonly capacityPoolId: number;
  readonly providerId: number;
  readonly providerModelId: number;
  /** The superadmin actor and operator used to register/publish the tool -- cleaned up alongside everything else. */
  readonly catalogActorIds: readonly string[];
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

async function createOrganization(pool: DatabasePool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth.organization (id, name, slug, "createdAt")
     values (gen_random_uuid()::text, 'Test Org', $1, now())
     returning id`,
    [unique("org")],
  );
  return rows[0].id;
}

async function addMember(
  pool: DatabasePool,
  organizationId: string,
  userId: string,
): Promise<void> {
  await pool.query(
    `insert into auth.member (id, "organizationId", "userId", role, "createdAt")
     values (gen_random_uuid()::text, $1, $2, 'member', now())`,
    [organizationId, userId],
  );
}

async function createCapacityPool(pool: DatabasePool): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into relay.capacity_pools (key, execution_class)
     values ($1, 'standard')
     returning id`,
    [unique("pool")],
  );
  return Number(rows[0].id);
}

async function createProviderModel(
  pool: DatabasePool,
): Promise<{ providerId: number; providerModelId: number }> {
  const provider = await pool.query<{ id: string }>(
    `insert into relay.providers (key, name, lifecycle)
     values ($1, 'Test Provider', 'published')
     returning id`,
    [unique("provider")],
  );
  const providerModel = await pool.query<{ id: string }>(
    `insert into relay.provider_models (provider_id, key, display_name, lifecycle)
     values ($1, $2, 'Test Model', 'published')
     returning id`,
    [provider.rows[0].id, unique("model")],
  );
  return {
    providerId: Number(provider.rows[0].id),
    providerModelId: Number(providerModel.rows[0].id),
  };
}

/**
 * Seeds a `relay.capacity_policies` row for a tool's queue-depth limits --
 * `admitToolRun` resolves these itself (see `resolveQueueLimits` in
 * admission.ts) rather than trusting a caller-supplied value, so tests
 * that need to exercise a specific limit configure it here the same way
 * an operator would.
 */
export async function setQueueLimits(
  pool: DatabasePool,
  toolId: string,
  limits: {
    readonly globalTool: number;
    readonly workspaceTotal: number;
    readonly workspaceTool: number;
  },
): Promise<void> {
  await pool.query(
    `insert into relay.capacity_policies (scope_type, scope_id, revision, configuration)
     values ('tool', $1, 1, $2)`,
    [toolId, JSON.stringify(limits)],
  );
}

export async function createAdmissibleFixture(
  pool: DatabasePool,
): Promise<AdmissibleFixture> {
  const workspaceId = await createOrganization(pool);
  const createdBy = await createUser(pool);
  await addMember(pool, workspaceId, createdBy);

  const operatorId = await createUser(pool);
  const actorUserId = await createUser(pool);
  await grantSuperadmin(pool, actorUserId, operatorId);

  const capacityPoolId = await createCapacityPool(pool);
  const { providerId, providerModelId } = await createProviderModel(pool);

  const handlerKey = unique("handler");
  const registered = await registerTool(pool, actorUserId, {
    key: unique("tool"),
    name: "Test Tool",
    visibility: "public",
  });
  if (registered.kind !== "ok") throw new Error("fixture: registerTool failed");
  await setToolLifecycle(
    pool,
    actorUserId,
    registered.value.toolId,
    "internal",
  );

  const created = await createToolVersion(pool, actorUserId, {
    toolId: registered.value.toolId,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    handlerKey,
    executionMode: "async",
    maxDurationSeconds: 120,
  });
  if (created.kind !== "ok") {
    throw new Error("fixture: createToolVersion failed");
  }

  const published = await publishToolVersion(
    pool,
    actorUserId,
    created.value.toolVersionId,
    createHandlerRegistry([handlerKey]),
  );
  if (published.kind !== "published") {
    throw new Error("fixture: publishToolVersion failed");
  }

  await pool.query(
    `insert into relay.tool_provider_bindings
       (tool_version_id, provider_model_id, capacity_pool_id, routing_order, enabled)
     values ($1, $2, $3, 1, true)`,
    [created.value.toolVersionId, providerModelId, capacityPoolId],
  );

  return {
    workspaceId,
    createdBy,
    toolId: registered.value.toolId,
    toolVersionId: created.value.toolVersionId,
    capacityPoolId,
    providerId,
    providerModelId,
    catalogActorIds: [actorUserId, operatorId],
  };
}

/**
 * Deletes everything `createAdmissibleFixture` creates, in dependency
 * order, plus anything the caller's own admission/dispatch calls added
 * on top (jobs/runs/counters keyed off the same workspace/tool IDs) --
 * same reasoning as the FK-cleanup fix in the Wave 3A commit: leftover
 * rows here would break `packages/auth`'s tests, which do a full-table
 * `auth.user`/`auth.organization` reset assuming exclusive ownership.
 */
export async function cleanupAdmissibleFixture(
  pool: DatabasePool,
  fixture: AdmissibleFixture,
): Promise<void> {
  await pool.query(
    `delete from relay.outbox_events
     where aggregate_id in (select id::text from relay.execution_jobs where workspace_id = $1)`,
    [fixture.workspaceId],
  );
  await pool.query(
    `delete from relay.job_attempts
     where job_id in (select id from relay.execution_jobs where workspace_id = $1)`,
    [fixture.workspaceId],
  );
  await pool.query("delete from relay.execution_jobs where workspace_id = $1", [
    fixture.workspaceId,
  ]);
  await pool.query(
    "delete from relay.idempotency_records where workspace_id = $1",
    [fixture.workspaceId],
  );
  // A successfully admitted run now always has a routing_decisions row
  // (see admitToolRun), which relay_app can never delete -- see
  // tryDelete's doc comment.
  await tryDelete(pool, "delete from relay.tool_runs where workspace_id = $1", [
    fixture.workspaceId,
  ]);
  await pool.query(
    "delete from relay.workspace_tool_queue_counters where workspace_id = $1",
    [fixture.workspaceId],
  );
  await pool.query(
    "delete from relay.workspace_queue_counters where workspace_id = $1",
    [fixture.workspaceId],
  );
  await pool.query(
    "delete from relay.tool_queue_counters where tool_id = $1",
    [fixture.toolId],
  );
  await pool.query(
    "delete from relay.capacity_policies where scope_type = 'tool' and scope_id = $1",
    [fixture.toolId],
  );
  await tryDelete(
    pool,
    "delete from relay.tool_provider_bindings where tool_version_id = $1",
    [fixture.toolVersionId],
  );
  // tools.active_version_id and tool_versions.tool_id are mutually
  // referential (see 0013_tool_registry.ts) -- break the cycle before
  // either row can be deleted.
  await pool.query(
    "update relay.tools set active_version_id = null where id = $1",
    [fixture.toolId],
  );
  // createAdmissibleFixture always publishes its tool version, and a
  // published tool_versions row is now immutable against deletion too
  // (0022_tool_version_delete_and_routing_policy_immutability.ts), so it
  // -- and, since tool_versions.tool_id still references it, its parent
  // tools row -- are deliberately left behind here. Harmless residue
  // scoped by this fixture's unique() tool/workspace IDs, and exactly
  // the real-world consequence of the immutability guarantee under test
  // elsewhere in the suite; only an unpublished tool_versions row (never
  // the case for this fixture, but kept general) could ever actually be
  // deleted here.
  await pool.query(
    "delete from relay.tool_versions where tool_id = $1 and published_at is null",
    [fixture.toolId],
  );
  const remainingVersions = await pool.query(
    "select 1 from relay.tool_versions where tool_id = $1 limit 1",
    [fixture.toolId],
  );
  if (remainingVersions.rows.length === 0) {
    await tryDelete(pool, "delete from relay.tools where id = $1", [
      fixture.toolId,
    ]);
  }
  await tryDelete(
    pool,
    "delete from relay.provider_models where id = $1",
    [fixture.providerModelId],
  );
  await tryDelete(pool, "delete from relay.providers where id = $1", [
    fixture.providerId,
  ]);
  await tryDelete(pool, "delete from relay.capacity_pools where id = $1", [
    fixture.capacityPoolId,
  ]);
  await pool.query('delete from auth.member where "organizationId" = $1', [
    fixture.workspaceId,
  ]);
  // A surviving tool_runs row (already attempted above, tolerated the
  // same way) keeps its workspace_id and created_by referenced --
  // blocking the organization delete below and, in the batched user
  // delete further down, the whole statement (one DELETE affecting
  // multiple rows is all-or-nothing).
  await tryDelete(pool, "delete from auth.organization where id = $1", [
    fixture.workspaceId,
  ]);
  // relay_app has no DELETE on relay.system_role_assignments at all
  // (0023_system_role_assignment_immutability.ts) -- only a cascade from
  // deleting the grant's own user_id can remove it; granted_by/
  // revoked_by never cascade. `catalogActorIds[0]` is always the grantee
  // (see createAdmissibleFixture's `grantSuperadmin(pool, actorUserId,
  // operatorId)` below), so deleting it first cascades its grant row
  // away, clearing the granted_by/revoked_by reference that would
  // otherwise block deleting the operator afterward in the same
  // statement.
  await tryDelete(pool, 'delete from auth."user" where id = $1', [
    fixture.catalogActorIds[0],
  ]);
  const remainingUserIds = [
    fixture.createdBy,
    ...fixture.catalogActorIds.slice(1),
  ];
  await tryDelete(pool, 'delete from auth."user" where id = any($1::text[])', [
    remainingUserIds,
  ]);
}
