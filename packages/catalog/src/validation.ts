import type { ReadinessCheck } from "@relay/contracts";
import type { DatabasePool } from "@relay/database";
import type { HandlerCompatibility, HandlerRegistry } from "./handlers.ts";

/** Satisfied by both `pg.Pool` and a checked-out `pg.PoolClient`. */
export type CatalogQueryExecutor = Pick<DatabasePool, "query">;

export type CatalogOperationalIssueCode =
  | "binding_disabled"
  | "provider_disabled"
  | "provider_retired"
  | "provider_model_disabled"
  | "provider_model_retired"
  | "capacity_pool_disabled"
  | "routing_policy_not_effective";

export type CatalogFallbackMode = "none" | "ordered";

export interface CatalogRoutingPolicyDocument {
  /** A lower-priority binding is eligible only when its own policy opts in. */
  readonly fallback?: {
    readonly mode?: CatalogFallbackMode;
  };
  readonly [key: string]: unknown;
}

export function isCatalogRoutingPolicyDocument(
  value: unknown,
): value is CatalogRoutingPolicyDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const fallback = (value as Record<string, unknown>).fallback;
  if (fallback === undefined) return true;
  if (
    fallback === null || typeof fallback !== "object" ||
    Array.isArray(fallback)
  ) {
    return false;
  }
  const mode = (fallback as Record<string, unknown>).mode;
  return mode === undefined || mode === "none" || mode === "ordered";
}

export type CatalogAvailabilityIssueCode =
  | "tool_version_not_found"
  | "tool_version_unpublished"
  | "tool_disabled"
  | "tool_retired"
  | "handler_not_registered"
  | "handler_compatibility_mismatch"
  | "immutable_hash_mismatch"
  | "no_provider_binding"
  | "binding_not_found"
  | CatalogOperationalIssueCode
  | "capacity_pool_provider_model_mismatch"
  | "duplicate_routing_order"
  | "routing_policy_hash_mismatch"
  | "routing_policy_invalid"
  | "fallback_not_permitted"
  | "tool_run_not_found"
  | "routing_decision_missing"
  | "routing_decision_tool_mismatch"
  | "routing_decision_tool_version_mismatch"
  | "routing_decision_tool_version_hash_mismatch"
  | "routing_decision_handler_mismatch"
  | "routing_decision_binding_mismatch"
  | "routing_decision_provider_mismatch"
  | "routing_decision_provider_model_mismatch"
  | "routing_decision_capacity_pool_mismatch"
  | "routing_decision_routing_order_mismatch"
  | "routing_decision_policy_mismatch"
  | "routing_decision_policy_revision_mismatch"
  | "routing_decision_policy_hash_mismatch";

export interface CatalogAvailabilityIssue {
  readonly code: CatalogAvailabilityIssueCode;
  readonly toolId?: string;
  readonly toolVersionId?: string;
  readonly toolRunId?: string;
  readonly bindingId?: string;
  readonly handlerKey?: string;
  readonly routingOrder?: number;
  readonly routingPolicyId?: string;
  readonly expectedCompatibility?: HandlerCompatibility;
  readonly registeredCompatibility?: HandlerCompatibility;
}

export type CatalogFallbackReason =
  | CatalogOperationalIssueCode
  | "higher_priority_route_unavailable";

export interface CatalogFallback {
  readonly used: boolean;
  readonly reason: CatalogFallbackReason | null;
}

export interface CatalogRoute {
  readonly toolId: string;
  readonly toolVersionId: string;
  readonly toolVersionImmutableHash: string;
  readonly handlerKey: string;
  readonly inputSchemaVersion: number;
  readonly handlerVersion: string;
  readonly bindingId: string;
  readonly providerId: string;
  readonly providerModelId: string;
  readonly capacityPoolId: string;
  readonly routingOrder: number;
  readonly routingPolicyId: string | null;
  readonly routingPolicyRevision: number | null;
  readonly routingPolicyImmutableHash: string | null;
}

export interface CatalogRouteSelection {
  readonly route: CatalogRoute;
  readonly fallback: CatalogFallback;
}

export type CatalogRouteResolution =
  | ({ readonly kind: "available" } & CatalogRouteSelection & {
    /** Disabled or inconsistent alternatives that were inspected. */
    readonly issues: readonly CatalogAvailabilityIssue[];
  })
  | {
    readonly kind: "unavailable";
    readonly issues: readonly CatalogAvailabilityIssue[];
  };

interface CatalogSnapshotRow {
  readonly tool_id: string;
  readonly tool_lifecycle: string;
  readonly readiness_critical: boolean;
  readonly active_version_id: string | null;
  readonly tool_version_id: string;
  readonly handler_key: string;
  readonly input_schema_version: number;
  readonly handler_version: string;
  readonly tool_version_immutable_hash: string;
  readonly published_at: Date | null;
  readonly immutable_hash_valid: boolean;
  readonly binding_id: string | number | null;
  readonly provider_model_id: string | number | null;
  readonly capacity_pool_id: string | number | null;
  readonly routing_order: number | null;
  readonly binding_enabled: boolean | null;
  readonly routing_policy_id: string | number | null;
  readonly routing_policy_revision: number | null;
  readonly routing_policy_immutable_hash: string | null;
  readonly routing_policy_hash_valid: boolean | null;
  readonly routing_policy_effective: boolean | null;
  readonly routing_policy_fallback_mode: string | null;
  readonly provider_id: string | number | null;
  readonly provider_lifecycle: string | null;
  readonly provider_model_lifecycle: string | null;
  readonly capacity_pool_enabled: boolean | null;
  readonly capacity_pool_provider_model_id: string | number | null;
}

interface ToolVersionState {
  readonly id: string;
  readonly toolId: string;
  readonly handlerKey: string;
  readonly inputSchemaVersion: number;
  readonly handlerVersion: string;
  readonly immutableHash: string;
  readonly publishedAt: Date | null;
  readonly toolLifecycle: string;
  readonly readinessCritical: boolean;
  readonly activeVersionId: string | null;
  readonly immutableHashValid: boolean;
}

interface BindingState {
  readonly bindingId: string;
  readonly providerModelId: string;
  readonly capacityPoolId: string;
  readonly routingOrder: number;
  readonly bindingEnabled: boolean;
  readonly routingPolicyId: string | null;
  readonly routingPolicyRevision: number | null;
  readonly routingPolicyImmutableHash: string | null;
  readonly routingPolicyHashValid: boolean | null;
  readonly routingPolicyEffective: boolean | null;
  readonly routingPolicyFallbackMode: string | null;
  readonly providerId: string;
  readonly providerLifecycle: string;
  readonly providerModelLifecycle: string;
  readonly capacityPoolEnabled: boolean;
  readonly capacityPoolProviderModelId: string | null;
}

const CATALOG_SNAPSHOT_COLUMNS = `
  select t.id as tool_id,
         t.lifecycle as tool_lifecycle,
         t.readiness_critical,
         t.active_version_id,
         tv.id as tool_version_id,
         tv.handler_key,
         tv.input_schema_version,
         tv.handler_version,
         tv.immutable_hash as tool_version_immutable_hash,
         tv.published_at,
         tv.immutable_hash = relay.compute_tool_version_immutable_hash(
           tv.id, tv.tool_id, tv.version, tv.input_schema, tv.output_schema,
           tv.handler_key, tv.input_schema_version, tv.handler_version,
           tv.execution_mode, tv.max_duration_seconds, tv.meter_policy_id,
           tv.entitlement_key, tv.compatibility_metadata
         ) as immutable_hash_valid,
         tpb.id as binding_id,
         tpb.provider_model_id,
         tpb.capacity_pool_id,
         tpb.routing_order,
         tpb.enabled as binding_enabled,
         tpb.routing_policy_id,
         rp.revision as routing_policy_revision,
         rp.immutable_hash as routing_policy_immutable_hash,
         case when rp.id is null then null else
           rp.immutable_hash = relay.compute_routing_policy_immutable_hash(
             rp.id, rp.revision, rp.policy, rp.effective_at
           )
         end as routing_policy_hash_valid,
         case when rp.id is null then null else rp.effective_at <= now() end
           as routing_policy_effective,
         rp.policy #>> '{fallback,mode}' as routing_policy_fallback_mode,
         p.id as provider_id,
         p.lifecycle as provider_lifecycle,
         pm.lifecycle as provider_model_lifecycle,
         cp.enabled as capacity_pool_enabled,
         cp.provider_model_id as capacity_pool_provider_model_id
    from relay.tool_versions tv
    join relay.tools t on t.id = tv.tool_id
    left join relay.tool_provider_bindings tpb
      on tpb.tool_version_id = tv.id
    left join relay.provider_models pm on pm.id = tpb.provider_model_id
    left join relay.providers p on p.id = pm.provider_id
    left join relay.capacity_pools cp on cp.id = tpb.capacity_pool_id
    left join relay.routing_policies rp on rp.id = tpb.routing_policy_id`;

function id(value: string | number): string {
  return String(value);
}

function toVersion(row: CatalogSnapshotRow): ToolVersionState {
  return {
    id: row.tool_version_id,
    toolId: row.tool_id,
    handlerKey: row.handler_key,
    inputSchemaVersion: row.input_schema_version,
    handlerVersion: row.handler_version,
    immutableHash: row.tool_version_immutable_hash,
    publishedAt: row.published_at,
    toolLifecycle: row.tool_lifecycle,
    readinessCritical: row.readiness_critical,
    activeVersionId: row.active_version_id,
    immutableHashValid: row.immutable_hash_valid,
  };
}

function toBinding(row: CatalogSnapshotRow): BindingState | undefined {
  if (
    row.binding_id === null || row.provider_model_id === null ||
    row.capacity_pool_id === null || row.routing_order === null ||
    row.binding_enabled === null || row.provider_id === null ||
    row.provider_lifecycle === null || row.provider_model_lifecycle === null ||
    row.capacity_pool_enabled === null
  ) {
    return undefined;
  }

  return {
    bindingId: id(row.binding_id),
    providerModelId: id(row.provider_model_id),
    capacityPoolId: id(row.capacity_pool_id),
    routingOrder: row.routing_order,
    bindingEnabled: row.binding_enabled,
    routingPolicyId: row.routing_policy_id === null
      ? null
      : id(row.routing_policy_id),
    routingPolicyRevision: row.routing_policy_revision,
    routingPolicyImmutableHash: row.routing_policy_immutable_hash,
    routingPolicyHashValid: row.routing_policy_hash_valid,
    routingPolicyEffective: row.routing_policy_effective,
    routingPolicyFallbackMode: row.routing_policy_fallback_mode,
    providerId: id(row.provider_id),
    providerLifecycle: row.provider_lifecycle,
    providerModelLifecycle: row.provider_model_lifecycle,
    capacityPoolEnabled: row.capacity_pool_enabled,
    capacityPoolProviderModelId: row.capacity_pool_provider_model_id === null
      ? null
      : id(row.capacity_pool_provider_model_id),
  };
}

function handlerIssues(
  version: ToolVersionState,
  handlers: HandlerRegistry,
): CatalogAvailabilityIssue[] {
  const registered = handlers.get(version.handlerKey);
  if (registered === undefined) {
    return [{
      code: "handler_not_registered",
      toolId: version.toolId,
      toolVersionId: version.id,
      handlerKey: version.handlerKey,
    }];
  }

  const expected: HandlerCompatibility = {
    inputSchemaVersion: version.inputSchemaVersion,
    handlerVersion: version.handlerVersion,
  };
  if (!handlers.isCompatible(version.handlerKey, expected)) {
    return [{
      code: "handler_compatibility_mismatch",
      toolId: version.toolId,
      toolVersionId: version.id,
      handlerKey: version.handlerKey,
      expectedCompatibility: expected,
      registeredCompatibility: {
        inputSchemaVersion: registered.inputSchemaVersion,
        handlerVersion: registered.handlerVersion,
      },
    }];
  }
  return [];
}

function toolVersionIssues(
  version: ToolVersionState,
  handlers: HandlerRegistry,
): CatalogAvailabilityIssue[] {
  const issues = handlerIssues(version, handlers);
  if (version.publishedAt === null) {
    issues.unshift({
      code: "tool_version_unpublished",
      toolId: version.toolId,
      toolVersionId: version.id,
    });
  }
  if (version.toolLifecycle === "disabled") {
    issues.push({
      code: "tool_disabled",
      toolId: version.toolId,
      toolVersionId: version.id,
    });
  } else if (version.toolLifecycle === "retired") {
    issues.push({
      code: "tool_retired",
      toolId: version.toolId,
      toolVersionId: version.id,
    });
  }
  if (!version.immutableHashValid) {
    issues.push({
      code: "immutable_hash_mismatch",
      toolId: version.toolId,
      toolVersionId: version.id,
    });
  }
  return issues;
}

function duplicateRoutingOrders(
  bindings: readonly BindingState[],
): ReadonlySet<number> {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const binding of bindings) {
    if (seen.has(binding.routingOrder)) duplicates.add(binding.routingOrder);
    seen.add(binding.routingOrder);
  }
  return duplicates;
}

function bindingIssues(
  binding: BindingState,
  version: ToolVersionState,
  duplicateOrders: ReadonlySet<number>,
): CatalogAvailabilityIssue[] {
  const common = {
    toolId: version.toolId,
    toolVersionId: version.id,
    bindingId: binding.bindingId,
  };
  const issues: CatalogAvailabilityIssue[] = [];
  if (duplicateOrders.has(binding.routingOrder)) {
    issues.push({
      ...common,
      code: "duplicate_routing_order",
      routingOrder: binding.routingOrder,
    });
  }
  if (!binding.bindingEnabled) {
    issues.push({ ...common, code: "binding_disabled" });
  }
  if (binding.providerLifecycle === "disabled") {
    issues.push({ ...common, code: "provider_disabled" });
  } else if (binding.providerLifecycle === "retired") {
    issues.push({ ...common, code: "provider_retired" });
  }
  if (binding.providerModelLifecycle === "disabled") {
    issues.push({ ...common, code: "provider_model_disabled" });
  } else if (binding.providerModelLifecycle === "retired") {
    issues.push({ ...common, code: "provider_model_retired" });
  }
  if (!binding.capacityPoolEnabled) {
    issues.push({ ...common, code: "capacity_pool_disabled" });
  }
  if (
    binding.capacityPoolProviderModelId !== null &&
    binding.capacityPoolProviderModelId !== binding.providerModelId
  ) {
    issues.push({ ...common, code: "capacity_pool_provider_model_mismatch" });
  }
  if (binding.routingPolicyId !== null) {
    const policy = { ...common, routingPolicyId: binding.routingPolicyId };
    if (binding.routingPolicyRevision === null) {
      issues.push({ ...policy, code: "routing_policy_invalid" });
    } else if (binding.routingPolicyHashValid !== true) {
      issues.push({ ...policy, code: "routing_policy_hash_mismatch" });
    } else if (binding.routingPolicyEffective !== true) {
      issues.push({ ...policy, code: "routing_policy_not_effective" });
    } else if (
      binding.routingPolicyFallbackMode !== null &&
      binding.routingPolicyFallbackMode !== "none" &&
      binding.routingPolicyFallbackMode !== "ordered"
    ) {
      issues.push({ ...policy, code: "routing_policy_invalid" });
    }
  }
  return issues;
}

function toRoute(
  version: ToolVersionState,
  binding: BindingState,
): CatalogRoute {
  return {
    toolId: version.toolId,
    toolVersionId: version.id,
    toolVersionImmutableHash: version.immutableHash,
    handlerKey: version.handlerKey,
    inputSchemaVersion: version.inputSchemaVersion,
    handlerVersion: version.handlerVersion,
    bindingId: binding.bindingId,
    providerId: binding.providerId,
    providerModelId: binding.providerModelId,
    capacityPoolId: binding.capacityPoolId,
    routingOrder: binding.routingOrder,
    routingPolicyId: binding.routingPolicyId,
    routingPolicyRevision: binding.routingPolicyRevision,
    routingPolicyImmutableHash: binding.routingPolicyImmutableHash,
  };
}

const OPERATIONAL_ISSUES: ReadonlySet<CatalogAvailabilityIssueCode> = new Set([
  "binding_disabled",
  "provider_disabled",
  "provider_retired",
  "provider_model_disabled",
  "provider_model_retired",
  "capacity_pool_disabled",
  "routing_policy_not_effective",
]);

function fallbackReason(
  evaluations: readonly { issues: readonly CatalogAvailabilityIssue[] }[],
): CatalogFallbackReason {
  for (const evaluation of evaluations) {
    const issue = evaluation.issues.find((candidate) =>
      OPERATIONAL_ISSUES.has(candidate.code)
    );
    if (issue !== undefined) {
      return issue.code as CatalogOperationalIssueCode;
    }
  }
  return "higher_priority_route_unavailable";
}

function resolveCatalogRows(
  rows: readonly CatalogSnapshotRow[],
  handlers: HandlerRegistry,
  toolVersionId: string,
  requiredBindingId?: string,
): CatalogRouteResolution {
  if (rows.length === 0) {
    return {
      kind: "unavailable",
      issues: [{ code: "tool_version_not_found", toolVersionId }],
    };
  }

  const version = toVersion(rows[0]);
  const versionIssues = toolVersionIssues(version, handlers);
  if (versionIssues.length > 0) {
    return { kind: "unavailable", issues: versionIssues };
  }

  const bindings = rows.flatMap((row) => {
    const binding = toBinding(row);
    return binding === undefined ? [] : [binding];
  });
  if (bindings.length === 0) {
    return {
      kind: "unavailable",
      issues: [{
        code: requiredBindingId === undefined
          ? "no_provider_binding"
          : "binding_not_found",
        toolId: version.toolId,
        toolVersionId,
        bindingId: requiredBindingId,
      }],
    };
  }

  const duplicates = duplicateRoutingOrders(bindings);
  const evaluations = bindings.map((binding) => ({
    binding,
    issues: bindingIssues(binding, version, duplicates),
  }));

  if (requiredBindingId !== undefined) {
    const selected = evaluations.find((entry) =>
      entry.binding.bindingId === requiredBindingId
    );
    if (selected === undefined) {
      return {
        kind: "unavailable",
        issues: [{
          code: "binding_not_found",
          toolId: version.toolId,
          toolVersionId,
          bindingId: requiredBindingId,
        }],
      };
    }
    if (selected.issues.length > 0) {
      return { kind: "unavailable", issues: selected.issues };
    }
    return {
      kind: "available",
      route: toRoute(version, selected.binding),
      fallback: { used: false, reason: null },
      issues: [],
    };
  }

  const allIssues = evaluations.flatMap((entry) => entry.issues);
  const primary = evaluations[0];
  if (primary.issues.length === 0) {
    return {
      kind: "available",
      route: toRoute(version, primary.binding),
      fallback: { used: false, reason: null },
      issues: allIssues,
    };
  }

  for (let index = 1; index < evaluations.length; index++) {
    const candidate = evaluations[index];
    if (candidate.issues.length > 0) continue;

    const higherPriority = evaluations.slice(0, index);
    if (
      higherPriority.some((entry) =>
        entry.issues.some((issue) => !OPERATIONAL_ISSUES.has(issue.code))
      )
    ) {
      break;
    }

    if (candidate.binding.routingPolicyFallbackMode !== "ordered") {
      allIssues.push({
        code: "fallback_not_permitted",
        toolId: version.toolId,
        toolVersionId,
        bindingId: candidate.binding.bindingId,
        routingOrder: candidate.binding.routingOrder,
        routingPolicyId: candidate.binding.routingPolicyId ?? undefined,
      });
      continue;
    }

    return {
      kind: "available",
      route: toRoute(version, candidate.binding),
      fallback: {
        used: true,
        reason: fallbackReason(higherPriority),
      },
      issues: allIssues,
    };
  }

  return { kind: "unavailable", issues: allIssues };
}

async function loadCatalogRows(
  queryable: CatalogQueryExecutor,
  toolVersionId: string,
): Promise<readonly CatalogSnapshotRow[]> {
  const { rows } = await queryable.query<CatalogSnapshotRow>(
    `${CATALOG_SNAPSHOT_COLUMNS}
     where tv.id = $1
     order by tpb.routing_order asc nulls last, tpb.id asc`,
    [toolVersionId],
  );
  return rows;
}

/** Resolve one route from a single PostgreSQL statement snapshot. */
export async function resolveCatalogRoute(
  queryable: CatalogQueryExecutor,
  handlers: HandlerRegistry,
  toolVersionId: string,
): Promise<CatalogRouteResolution> {
  return resolveCatalogRows(
    await loadCatalogRows(queryable, toolVersionId),
    handlers,
    toolVersionId,
  );
}

/** Revalidate the current kill switches for one already-selected binding. */
export async function validateCatalogBinding(
  queryable: CatalogQueryExecutor,
  handlers: HandlerRegistry,
  toolVersionId: string,
  bindingId: string,
): Promise<CatalogRouteResolution> {
  return resolveCatalogRows(
    await loadCatalogRows(queryable, toolVersionId),
    handlers,
    toolVersionId,
    bindingId,
  );
}

export interface PersistCatalogRoutingDecisionOptions {
  readonly requestedModelVersion?: string | null;
}

export interface CatalogRoutingDecision extends CatalogRouteSelection {
  readonly decisionId: string;
  readonly requestedModelVersion: string | null;
}

/**
 * Persists every execution-relevant field selected by `resolveCatalogRoute`.
 * Call this with the same transaction client that inserted the tool run.
 */
export async function persistCatalogRoutingDecision(
  queryable: CatalogQueryExecutor,
  toolRunId: string,
  selection: CatalogRouteSelection,
  options: PersistCatalogRoutingDecisionOptions = {},
): Promise<CatalogRoutingDecision> {
  const { route, fallback } = selection;
  const { rows } = await queryable.query<{
    id: string | number;
    tool_id: string;
    tool_version_id: string;
    tool_version_immutable_hash: string;
    handler_key: string;
    input_schema_version: number;
    handler_version: string;
    selected_binding_id: string | number;
    provider_id: string | number;
    provider_model_id: string | number;
    capacity_pool_id: string | number;
    routing_order: number;
    routing_policy_id: string | number | null;
    routing_policy_revision: number | null;
    routing_policy_immutable_hash: string | null;
    requested_model_version: string | null;
    fallback_used: boolean;
    fallback_reason: CatalogFallbackReason | null;
  }>(
    `insert into relay.routing_decisions
       (tool_run_id, tool_id, tool_version_id, tool_version_immutable_hash,
        handler_key, input_schema_version, handler_version,
        selected_binding_id, provider_id, provider_model_id, capacity_pool_id,
        routing_order, routing_policy_id, routing_policy_revision,
        routing_policy_immutable_hash, requested_model_version,
        fallback_used, fallback_reason)
     values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15, $16, $17, $18
     )
     returning id, tool_id, tool_version_id, tool_version_immutable_hash,
               handler_key, input_schema_version, handler_version,
               selected_binding_id, provider_id, provider_model_id,
               capacity_pool_id, routing_order, routing_policy_id,
               routing_policy_revision, routing_policy_immutable_hash,
               requested_model_version, fallback_used, fallback_reason`,
    [
      toolRunId,
      route.toolId,
      route.toolVersionId,
      route.toolVersionImmutableHash,
      route.handlerKey,
      route.inputSchemaVersion,
      route.handlerVersion,
      route.bindingId,
      route.providerId,
      route.providerModelId,
      route.capacityPoolId,
      route.routingOrder,
      route.routingPolicyId,
      route.routingPolicyRevision,
      route.routingPolicyImmutableHash,
      options.requestedModelVersion ?? null,
      fallback.used,
      fallback.reason,
    ],
  );
  const row = rows[0];
  return {
    decisionId: id(row.id),
    requestedModelVersion: row.requested_model_version,
    route: {
      toolId: row.tool_id,
      toolVersionId: row.tool_version_id,
      toolVersionImmutableHash: row.tool_version_immutable_hash,
      handlerKey: row.handler_key,
      inputSchemaVersion: row.input_schema_version,
      handlerVersion: row.handler_version,
      bindingId: id(row.selected_binding_id),
      providerId: id(row.provider_id),
      providerModelId: id(row.provider_model_id),
      capacityPoolId: id(row.capacity_pool_id),
      routingOrder: row.routing_order,
      routingPolicyId: row.routing_policy_id === null
        ? null
        : id(row.routing_policy_id),
      routingPolicyRevision: row.routing_policy_revision,
      routingPolicyImmutableHash: row.routing_policy_immutable_hash,
    },
    fallback: {
      used: row.fallback_used,
      reason: row.fallback_reason,
    },
  };
}

interface RoutingDecisionRow {
  readonly run_tool_version_id: string;
  readonly decision_id: string | number | null;
  readonly decision_tool_id: string | null;
  readonly decision_tool_version_id: string | null;
  readonly decision_tool_version_hash: string | null;
  readonly decision_handler_key: string | null;
  readonly decision_input_schema_version: number | null;
  readonly decision_handler_version: string | null;
  readonly selected_binding_id: string | number | null;
  readonly decision_provider_id: string | number | null;
  readonly decision_provider_model_id: string | number | null;
  readonly decision_capacity_pool_id: string | number | null;
  readonly decision_routing_order: number | null;
  readonly decision_policy_id: string | number | null;
  readonly decision_policy_revision: number | null;
  readonly decision_policy_hash: string | null;
  readonly requested_model_version: string | null;
  readonly fallback_used: boolean | null;
  readonly fallback_reason: CatalogFallbackReason | null;
  readonly current_tool_id: string | null;
  readonly current_tool_version_hash: string | null;
  readonly current_handler_key: string | null;
  readonly current_input_schema_version: number | null;
  readonly current_handler_version: string | null;
  readonly version_published: boolean | null;
  readonly tool_lifecycle: string | null;
  readonly immutable_hash_valid: boolean | null;
  readonly current_binding_id: string | number | null;
  readonly binding_tool_version_id: string | null;
  readonly binding_provider_model_id: string | number | null;
  readonly binding_capacity_pool_id: string | number | null;
  readonly binding_routing_order: number | null;
  readonly binding_policy_id: string | number | null;
  readonly binding_enabled: boolean | null;
  readonly model_provider_id: string | number | null;
  readonly provider_lifecycle: string | null;
  readonly provider_model_lifecycle: string | null;
  readonly capacity_pool_enabled: boolean | null;
  readonly capacity_pool_provider_model_id: string | number | null;
  readonly current_policy_revision: number | null;
  readonly current_policy_hash: string | null;
  readonly routing_policy_hash_valid: boolean | null;
  readonly routing_policy_effective: boolean | null;
  readonly routing_policy_fallback_mode: string | null;
}

export type CatalogRoutingDecisionValidation =
  | {
    readonly kind: "available";
    readonly value: CatalogRoutingDecision;
    readonly issues: readonly CatalogAvailabilityIssue[];
  }
  | {
    readonly kind: "unavailable";
    readonly issues: readonly CatalogAvailabilityIssue[];
  };

function decisionIssue(
  row: RoutingDecisionRow,
  code: CatalogAvailabilityIssueCode,
): CatalogAvailabilityIssue {
  return {
    code,
    toolId: row.decision_tool_id ?? undefined,
    toolVersionId: row.decision_tool_version_id ?? row.run_tool_version_id,
    bindingId: row.selected_binding_id === null
      ? undefined
      : id(row.selected_binding_id),
    routingOrder: row.decision_routing_order ?? undefined,
    routingPolicyId: row.decision_policy_id === null
      ? undefined
      : id(row.decision_policy_id),
  };
}

/**
 * Validates one immutable decision snapshot and its current kill switches in a
 * single database statement. Queue dispatch should invoke this through the
 * transaction that owns its durable claim.
 */
export async function validateRoutingDecisionForRun(
  queryable: CatalogQueryExecutor,
  handlers: HandlerRegistry,
  toolRunId: string,
): Promise<CatalogRoutingDecisionValidation> {
  const { rows } = await queryable.query<RoutingDecisionRow>(
    `select tr.tool_version_id as run_tool_version_id,
            rd.id as decision_id,
            rd.tool_id as decision_tool_id,
            rd.tool_version_id as decision_tool_version_id,
            rd.tool_version_immutable_hash as decision_tool_version_hash,
            rd.handler_key as decision_handler_key,
            rd.input_schema_version as decision_input_schema_version,
            rd.handler_version as decision_handler_version,
            rd.selected_binding_id,
            rd.provider_id as decision_provider_id,
            rd.provider_model_id as decision_provider_model_id,
            rd.capacity_pool_id as decision_capacity_pool_id,
            rd.routing_order as decision_routing_order,
            rd.routing_policy_id as decision_policy_id,
            rd.routing_policy_revision as decision_policy_revision,
            rd.routing_policy_immutable_hash as decision_policy_hash,
            rd.requested_model_version,
            rd.fallback_used,
            rd.fallback_reason,
            tv.tool_id as current_tool_id,
            tv.immutable_hash as current_tool_version_hash,
            tv.handler_key as current_handler_key,
            tv.input_schema_version as current_input_schema_version,
            tv.handler_version as current_handler_version,
            tv.published_at is not null as version_published,
            t.lifecycle as tool_lifecycle,
            tv.immutable_hash = relay.compute_tool_version_immutable_hash(
              tv.id, tv.tool_id, tv.version, tv.input_schema, tv.output_schema,
              tv.handler_key, tv.input_schema_version, tv.handler_version,
              tv.execution_mode, tv.max_duration_seconds, tv.meter_policy_id,
              tv.entitlement_key, tv.compatibility_metadata
            ) as immutable_hash_valid,
            tpb.id as current_binding_id,
            tpb.tool_version_id as binding_tool_version_id,
            tpb.provider_model_id as binding_provider_model_id,
            tpb.capacity_pool_id as binding_capacity_pool_id,
            tpb.routing_order as binding_routing_order,
            tpb.routing_policy_id as binding_policy_id,
            tpb.enabled as binding_enabled,
            pm.provider_id as model_provider_id,
            p.lifecycle as provider_lifecycle,
            pm.lifecycle as provider_model_lifecycle,
            cp.enabled as capacity_pool_enabled,
            cp.provider_model_id as capacity_pool_provider_model_id,
            rp.revision as current_policy_revision,
            rp.immutable_hash as current_policy_hash,
            case when rp.id is null then null else
              rp.immutable_hash = relay.compute_routing_policy_immutable_hash(
                rp.id, rp.revision, rp.policy, rp.effective_at
              )
            end as routing_policy_hash_valid,
            case when rp.id is null then null else rp.effective_at <= now() end
              as routing_policy_effective,
            rp.policy #>> '{fallback,mode}' as routing_policy_fallback_mode
       from relay.tool_runs tr
       left join relay.routing_decisions rd on rd.tool_run_id = tr.id
       left join relay.tool_versions tv on tv.id = rd.tool_version_id
       left join relay.tools t on t.id = rd.tool_id
       left join relay.tool_provider_bindings tpb on tpb.id = rd.selected_binding_id
       left join relay.provider_models pm on pm.id = rd.provider_model_id
       left join relay.providers p on p.id = rd.provider_id
       left join relay.capacity_pools cp on cp.id = rd.capacity_pool_id
       left join relay.routing_policies rp on rp.id = rd.routing_policy_id
      where tr.id = $1`,
    [toolRunId],
  );
  const row = rows[0];
  if (row === undefined) {
    return {
      kind: "unavailable",
      issues: [{ code: "tool_run_not_found", toolRunId }],
    };
  }
  if (row.decision_id === null || row.selected_binding_id === null) {
    return {
      kind: "unavailable",
      issues: [{
        code: "routing_decision_missing",
        toolRunId,
        toolVersionId: row.run_tool_version_id,
      }],
    };
  }

  const issues: CatalogAvailabilityIssue[] = [];
  const add = (code: CatalogAvailabilityIssueCode) =>
    issues.push({ ...decisionIssue(row, code), toolRunId });

  if (row.decision_tool_version_id !== row.run_tool_version_id) {
    add("routing_decision_tool_version_mismatch");
  }
  if (row.current_tool_id !== row.decision_tool_id) {
    add("routing_decision_tool_mismatch");
  }
  if (row.current_tool_version_hash !== row.decision_tool_version_hash) {
    add("routing_decision_tool_version_hash_mismatch");
  }
  if (
    row.current_handler_key !== row.decision_handler_key ||
    row.current_input_schema_version !== row.decision_input_schema_version ||
    row.current_handler_version !== row.decision_handler_version
  ) {
    add("routing_decision_handler_mismatch");
  }
  if (
    row.current_binding_id === null ||
    row.binding_tool_version_id !== row.decision_tool_version_id
  ) {
    add("routing_decision_binding_mismatch");
  }
  if (
    row.binding_provider_model_id === null ||
    row.decision_provider_model_id === null ||
    id(row.binding_provider_model_id) !== id(row.decision_provider_model_id)
  ) {
    add("routing_decision_provider_model_mismatch");
  }
  if (
    row.model_provider_id === null || row.decision_provider_id === null ||
    id(row.model_provider_id) !== id(row.decision_provider_id)
  ) {
    add("routing_decision_provider_mismatch");
  }
  if (
    row.binding_capacity_pool_id === null ||
    row.decision_capacity_pool_id === null ||
    id(row.binding_capacity_pool_id) !== id(row.decision_capacity_pool_id)
  ) {
    add("routing_decision_capacity_pool_mismatch");
  }
  if (row.binding_routing_order !== row.decision_routing_order) {
    add("routing_decision_routing_order_mismatch");
  }
  const bindingPolicyId = row.binding_policy_id === null
    ? null
    : id(row.binding_policy_id);
  const decisionPolicyId = row.decision_policy_id === null
    ? null
    : id(row.decision_policy_id);
  if (bindingPolicyId !== decisionPolicyId) {
    add("routing_decision_policy_mismatch");
  }
  if (row.decision_policy_revision !== row.current_policy_revision) {
    add("routing_decision_policy_revision_mismatch");
  }
  if (row.decision_policy_hash !== row.current_policy_hash) {
    add("routing_decision_policy_hash_mismatch");
  }

  if (row.version_published !== true) add("tool_version_unpublished");
  if (row.tool_lifecycle === "disabled") add("tool_disabled");
  else if (row.tool_lifecycle === "retired") add("tool_retired");
  if (row.immutable_hash_valid !== true) add("immutable_hash_mismatch");
  if (row.binding_enabled !== true) add("binding_disabled");
  if (row.provider_lifecycle === "disabled") add("provider_disabled");
  else if (row.provider_lifecycle === "retired") add("provider_retired");
  if (row.provider_model_lifecycle === "disabled") {
    add("provider_model_disabled");
  } else if (row.provider_model_lifecycle === "retired") {
    add("provider_model_retired");
  }
  if (row.capacity_pool_enabled !== true) add("capacity_pool_disabled");
  if (
    row.capacity_pool_provider_model_id !== null &&
    row.decision_provider_model_id !== null &&
    id(row.capacity_pool_provider_model_id) !==
      id(row.decision_provider_model_id)
  ) {
    add("capacity_pool_provider_model_mismatch");
  }
  if (row.decision_policy_id !== null) {
    if (row.routing_policy_hash_valid !== true) {
      add("routing_policy_hash_mismatch");
    } else if (row.routing_policy_effective !== true) {
      add("routing_policy_not_effective");
    }
  }
  if (
    row.fallback_used === true &&
    row.routing_policy_fallback_mode !== "ordered"
  ) {
    add("fallback_not_permitted");
  }

  if (
    row.decision_handler_key !== null &&
    row.decision_input_schema_version !== null &&
    row.decision_handler_version !== null
  ) {
    const registered = handlers.get(row.decision_handler_key);
    if (registered === undefined) {
      issues.push({
        ...decisionIssue(row, "handler_not_registered"),
        toolRunId,
        handlerKey: row.decision_handler_key,
      });
    } else if (
      !handlers.isCompatible(row.decision_handler_key, {
        inputSchemaVersion: row.decision_input_schema_version,
        handlerVersion: row.decision_handler_version,
      })
    ) {
      issues.push({
        ...decisionIssue(row, "handler_compatibility_mismatch"),
        toolRunId,
        handlerKey: row.decision_handler_key,
        expectedCompatibility: {
          inputSchemaVersion: row.decision_input_schema_version,
          handlerVersion: row.decision_handler_version,
        },
        registeredCompatibility: {
          inputSchemaVersion: registered.inputSchemaVersion,
          handlerVersion: registered.handlerVersion,
        },
      });
    }
  }

  if (issues.length > 0) return { kind: "unavailable", issues };

  const route: CatalogRoute = {
    toolId: row.decision_tool_id!,
    toolVersionId: row.decision_tool_version_id!,
    toolVersionImmutableHash: row.decision_tool_version_hash!,
    handlerKey: row.decision_handler_key!,
    inputSchemaVersion: row.decision_input_schema_version!,
    handlerVersion: row.decision_handler_version!,
    bindingId: id(row.selected_binding_id),
    providerId: id(row.decision_provider_id!),
    providerModelId: id(row.decision_provider_model_id!),
    capacityPoolId: id(row.decision_capacity_pool_id!),
    routingOrder: row.decision_routing_order!,
    routingPolicyId: row.decision_policy_id === null
      ? null
      : id(row.decision_policy_id),
    routingPolicyRevision: row.decision_policy_revision,
    routingPolicyImmutableHash: row.decision_policy_hash,
  };
  return {
    kind: "available",
    value: {
      decisionId: id(row.decision_id),
      requestedModelVersion: row.requested_model_version,
      route,
      fallback: {
        used: row.fallback_used === true,
        reason: row.fallback_reason,
      },
    },
    issues: [],
  };
}

export interface CatalogValidationReport {
  readonly publishedVersionsWithMissingHandlers: readonly {
    readonly toolVersionId: string;
    readonly toolId: string;
    readonly handlerKey: string;
  }[];
  readonly publishedVersionsWithIncompatibleHandlers: readonly {
    readonly toolVersionId: string;
    readonly toolId: string;
    readonly handlerKey: string;
    readonly expected: HandlerCompatibility;
    readonly registered: HandlerCompatibility;
  }[];
}

export async function validateCatalogHandlers(
  queryable: CatalogQueryExecutor,
  handlers: HandlerRegistry,
): Promise<CatalogValidationReport> {
  const { rows } = await queryable.query<{
    id: string;
    tool_id: string;
    handler_key: string;
    input_schema_version: number;
    handler_version: string;
  }>(
    `select id, tool_id, handler_key, input_schema_version, handler_version
       from relay.tool_versions
      where published_at is not null
      order by id`,
  );

  const missing: {
    toolVersionId: string;
    toolId: string;
    handlerKey: string;
  }[] = [];
  const incompatible: {
    toolVersionId: string;
    toolId: string;
    handlerKey: string;
    expected: HandlerCompatibility;
    registered: HandlerCompatibility;
  }[] = [];
  for (const row of rows) {
    const registered = handlers.get(row.handler_key);
    if (registered === undefined) {
      missing.push({
        toolVersionId: row.id,
        toolId: row.tool_id,
        handlerKey: row.handler_key,
      });
      continue;
    }
    const expected = {
      inputSchemaVersion: row.input_schema_version,
      handlerVersion: row.handler_version,
    };
    if (!handlers.isCompatible(row.handler_key, expected)) {
      incompatible.push({
        toolVersionId: row.id,
        toolId: row.tool_id,
        handlerKey: row.handler_key,
        expected,
        registered: {
          inputSchemaVersion: registered.inputSchemaVersion,
          handlerVersion: registered.handlerVersion,
        },
      });
    }
  }

  return {
    publishedVersionsWithMissingHandlers: missing,
    publishedVersionsWithIncompatibleHandlers: incompatible,
  };
}

export interface CatalogIntegrityReport extends CatalogValidationReport {
  readonly publishedVersionsWithInvalidHashes: readonly {
    readonly toolVersionId: string;
    readonly toolId: string;
  }[];
  readonly publishedVersionsWithoutAvailableRoutes: readonly {
    readonly toolVersionId: string;
    readonly toolId: string;
    readonly readinessCritical: boolean;
    readonly activeVersion: boolean;
    readonly issues: readonly CatalogAvailabilityIssue[];
  }[];
  readonly routingInconsistencies: readonly CatalogAvailabilityIssue[];
  readonly criticalIssues: readonly CatalogAvailabilityIssue[];
}

const ROUTING_INTEGRITY_CODES: ReadonlySet<CatalogAvailabilityIssueCode> =
  new Set([
    "capacity_pool_provider_model_mismatch",
    "duplicate_routing_order",
    "routing_policy_hash_mismatch",
    "routing_policy_invalid",
  ]);

/** Inspect all published routes from one database statement snapshot. */
export async function validateCatalogIntegrity(
  queryable: CatalogQueryExecutor,
  handlers: HandlerRegistry,
): Promise<CatalogIntegrityReport> {
  const { rows } = await queryable.query<CatalogSnapshotRow>(
    `${CATALOG_SNAPSHOT_COLUMNS}
     where tv.published_at is not null
       and t.lifecycle not in ('disabled', 'retired')
     order by tv.id, tpb.routing_order asc nulls last, tpb.id asc`,
  );

  const byVersion = new Map<string, CatalogSnapshotRow[]>();
  for (const row of rows) {
    const existing = byVersion.get(row.tool_version_id);
    if (existing === undefined) byVersion.set(row.tool_version_id, [row]);
    else existing.push(row);
  }

  const missingHandlers: {
    toolVersionId: string;
    toolId: string;
    handlerKey: string;
  }[] = [];
  const incompatibleHandlers: {
    toolVersionId: string;
    toolId: string;
    handlerKey: string;
    expected: HandlerCompatibility;
    registered: HandlerCompatibility;
  }[] = [];
  const invalidHashes: { toolVersionId: string; toolId: string }[] = [];
  const unavailable: {
    toolVersionId: string;
    toolId: string;
    readinessCritical: boolean;
    activeVersion: boolean;
    issues: readonly CatalogAvailabilityIssue[];
  }[] = [];
  const routingInconsistencies: CatalogAvailabilityIssue[] = [];
  const criticalIssues: CatalogAvailabilityIssue[] = [];

  for (const [toolVersionId, versionRows] of byVersion) {
    const version = toVersion(versionRows[0]);
    const resolution = resolveCatalogRows(
      versionRows,
      handlers,
      toolVersionId,
    );
    for (const issue of resolution.issues) {
      if (issue.code === "handler_not_registered") {
        missingHandlers.push({
          toolVersionId,
          toolId: version.toolId,
          handlerKey: issue.handlerKey!,
        });
      } else if (issue.code === "handler_compatibility_mismatch") {
        incompatibleHandlers.push({
          toolVersionId,
          toolId: version.toolId,
          handlerKey: issue.handlerKey!,
          expected: issue.expectedCompatibility!,
          registered: issue.registeredCompatibility!,
        });
      } else if (issue.code === "immutable_hash_mismatch") {
        invalidHashes.push({ toolVersionId, toolId: version.toolId });
      }
      if (ROUTING_INTEGRITY_CODES.has(issue.code)) {
        routingInconsistencies.push(issue);
      }
    }

    const activeVersion = version.activeVersionId === toolVersionId;
    if (resolution.kind === "unavailable") {
      unavailable.push({
        toolVersionId,
        toolId: version.toolId,
        readinessCritical: version.readinessCritical,
        activeVersion,
        issues: resolution.issues,
      });
    }
    if (version.readinessCritical && activeVersion) {
      if (resolution.kind === "unavailable") {
        criticalIssues.push(...resolution.issues);
      } else {
        criticalIssues.push(
          ...resolution.issues.filter((issue) =>
            ROUTING_INTEGRITY_CODES.has(issue.code)
          ),
        );
      }
    }
  }

  return {
    publishedVersionsWithMissingHandlers: missingHandlers,
    publishedVersionsWithIncompatibleHandlers: incompatibleHandlers,
    publishedVersionsWithInvalidHashes: invalidHashes,
    publishedVersionsWithoutAvailableRoutes: unavailable,
    routingInconsistencies,
    criticalIssues,
  };
}

export async function checkCatalogReadiness(
  queryable: CatalogQueryExecutor,
  handlers: HandlerRegistry,
): Promise<ReadinessCheck> {
  try {
    const report = await validateCatalogIntegrity(queryable, handlers);
    if (report.criticalIssues.length > 0) {
      return {
        name: "catalog",
        status: "error",
        message: "critical catalog routes are unavailable or inconsistent",
      };
    }
    return { name: "catalog", status: "ok" };
  } catch {
    return {
      name: "catalog",
      status: "error",
      message: "unable to validate catalog",
    };
  }
}

export interface CatalogValidationService {
  resolveRoute(toolVersionId: string): Promise<CatalogRouteResolution>;
  validateBinding(
    toolVersionId: string,
    bindingId: string,
  ): Promise<CatalogRouteResolution>;
  persistDecision(
    toolRunId: string,
    selection: CatalogRouteSelection,
    options?: PersistCatalogRoutingDecisionOptions,
  ): Promise<CatalogRoutingDecision>;
  validateRoutingDecisionForRun(
    toolRunId: string,
  ): Promise<CatalogRoutingDecisionValidation>;
  inspect(): Promise<CatalogIntegrityReport>;
  checkReadiness(): Promise<ReadinessCheck>;
}

export function createCatalogValidationService(
  queryable: CatalogQueryExecutor,
  handlers: HandlerRegistry,
): CatalogValidationService {
  return {
    resolveRoute: (toolVersionId) =>
      resolveCatalogRoute(queryable, handlers, toolVersionId),
    validateBinding: (toolVersionId, bindingId) =>
      validateCatalogBinding(queryable, handlers, toolVersionId, bindingId),
    persistDecision: (toolRunId, selection, options) =>
      persistCatalogRoutingDecision(queryable, toolRunId, selection, options),
    validateRoutingDecisionForRun: (toolRunId) =>
      validateRoutingDecisionForRun(queryable, handlers, toolRunId),
    inspect: () => validateCatalogIntegrity(queryable, handlers),
    checkReadiness: () => checkCatalogReadiness(queryable, handlers),
  };
}
