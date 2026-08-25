import { addDecimalAmounts, normalizeDecimalAmount } from "./decimal.ts";
import type {
  CapabilityCheckInput,
  CapabilityDecision,
  EntitlementLimit,
  LimitCheckInput,
  LimitDecision,
  MeteringPeriod,
  MeteringQueryExecutor,
} from "./types.ts";
import { requireKey, requireText } from "./validation.ts";

interface MembershipRow {
  role: string;
}

interface CapabilityGrantRow {
  id: string;
  source_kind: string;
  source_reference: string | null;
  subscription_snapshot_id: string | null;
  effective_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

interface LimitGrantRow extends CapabilityGrantRow {
  limit_amount: string | null;
  unit: string;
  period: MeteringPeriod;
}

export interface EntitlementGrantSnapshot {
  readonly id: string;
  readonly sourceKind: string;
  readonly sourceReference: string | null;
  readonly subscriptionSnapshotId: string | null;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly amount?: string | null;
}

export interface ResolvedCapability {
  readonly allowed: boolean;
  readonly capability: string;
  readonly grants: readonly EntitlementGrantSnapshot[];
}

export interface ResolvedLimit {
  readonly kind: "none" | "invalid" | "configured";
  readonly metric: string;
  readonly limit?: EntitlementLimit;
  readonly grants: readonly EntitlementGrantSnapshot[];
}

function grantSnapshot(
  row: CapabilityGrantRow,
  amount?: string | null,
): EntitlementGrantSnapshot {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceReference: row.source_reference,
    subscriptionSnapshotId: row.subscription_snapshot_id,
    effectiveAt: row.effective_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    ...(amount === undefined ? {} : { amount }),
  };
}

export async function hasWorkspaceAccess(
  queryable: MeteringQueryExecutor,
  workspaceId: string,
  actorUserId: string,
): Promise<boolean> {
  const { rows } = await queryable.query<MembershipRow>(
    `select role
       from auth.member
      where "organizationId" = $1 and "userId" = $2`,
    [workspaceId, actorUserId],
  );
  return rows.length > 0;
}

export async function transactionTimestamp(
  queryable: MeteringQueryExecutor,
): Promise<Date> {
  const { rows } = await queryable.query<{ now: Date }>(
    "select transaction_timestamp() as now",
  );
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("PostgreSQL did not return a transaction timestamp");
  }
  return now;
}

export async function resolveCapabilityAt(
  queryable: MeteringQueryExecutor,
  workspaceId: string,
  capability: string,
  at: Date,
): Promise<ResolvedCapability> {
  const { rows } = await queryable.query<CapabilityGrantRow>(
    `select id, source_kind, source_reference, subscription_snapshot_id,
            effective_at, expires_at, revoked_at
       from relay.entitlement_grants
      where workspace_id = $1
        and entitlement_key = $2
        and grant_kind = 'capability'
        and capability_enabled = true
        and effective_at <= $3
        and (expires_at is null or expires_at > $3)
        and (revoked_at is null or revoked_at > $3)
      order by id`,
    [workspaceId, capability, at],
  );
  return {
    allowed: rows.length > 0,
    capability,
    grants: rows.map((row) => grantSnapshot(row)),
  };
}

export async function resolveLimitAt(
  queryable: MeteringQueryExecutor,
  workspaceId: string,
  metric: string,
  at: Date,
): Promise<ResolvedLimit> {
  const { rows } = await queryable.query<LimitGrantRow>(
    `select id, limit_amount, unit, period, source_kind, source_reference,
            subscription_snapshot_id, effective_at, expires_at, revoked_at
       from relay.entitlement_grants
      where workspace_id = $1
        and entitlement_key = $2
        and grant_kind = 'limit'
        and effective_at <= $3
        and (expires_at is null or expires_at > $3)
        and (revoked_at is null or revoked_at > $3)
      order by id`,
    [workspaceId, metric, at],
  );
  if (rows.length === 0) return { kind: "none", metric, grants: [] };

  const dimensions = new Set(
    rows.map((row) => `${row.unit}\u0000${row.period}`),
  );
  if (dimensions.size !== 1) {
    return {
      kind: "invalid",
      metric,
      grants: rows.map((row) => grantSnapshot(row, row.limit_amount)),
    };
  }

  const unit = rows[0].unit;
  const period = rows[0].period;
  const snapshots = rows.map((row) =>
    grantSnapshot(
      row,
      row.limit_amount === null
        ? null
        : normalizeDecimalAmount(row.limit_amount),
    )
  );
  if (rows.some((row) => row.limit_amount === null)) {
    return {
      kind: "configured",
      metric,
      limit: { kind: "unlimited", metric, unit, period },
      grants: snapshots,
    };
  }

  try {
    const amount = addDecimalAmounts(
      rows.map((row) => normalizeDecimalAmount(row.limit_amount!)),
    );
    return {
      kind: "configured",
      metric,
      limit: { kind: "limited", metric, unit, period, amount },
      grants: snapshots,
    };
  } catch {
    return { kind: "invalid", metric, grants: snapshots };
  }
}

/**
 * Capability API for workspace-facing application services. Unknown workspaces
 * and workspaces the actor cannot access deliberately return the same result.
 */
export async function can(
  queryable: MeteringQueryExecutor,
  input: CapabilityCheckInput,
): Promise<CapabilityDecision> {
  requireText(input.workspaceId, "workspaceId");
  requireText(input.actorUserId, "actorUserId");
  requireKey(input.capability, "capability");
  if (
    !await hasWorkspaceAccess(queryable, input.workspaceId, input.actorUserId)
  ) {
    return { kind: "workspace_unavailable" };
  }
  const resolved = await resolveCapabilityAt(
    queryable,
    input.workspaceId,
    input.capability,
    await transactionTimestamp(queryable),
  );
  return resolved.allowed ? { kind: "allowed" } : { kind: "denied" };
}

/**
 * Limit API for workspace-facing application services. It exposes metric,
 * unit, period, and exact decimal amount only; no plan/catalog display name is
 * part of authorization.
 */
export async function limit(
  queryable: MeteringQueryExecutor,
  input: LimitCheckInput,
): Promise<LimitDecision> {
  requireText(input.workspaceId, "workspaceId");
  requireText(input.actorUserId, "actorUserId");
  requireKey(input.metric, "metric");
  if (
    !await hasWorkspaceAccess(queryable, input.workspaceId, input.actorUserId)
  ) {
    return { kind: "workspace_unavailable" };
  }
  const resolved = await resolveLimitAt(
    queryable,
    input.workspaceId,
    input.metric,
    await transactionTimestamp(queryable),
  );
  if (resolved.kind === "none") return { kind: "not_configured" };
  if (resolved.kind === "invalid") return { kind: "invalid_configuration" };
  return { kind: "configured", limit: resolved.limit! };
}
