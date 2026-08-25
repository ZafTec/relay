export interface MeteringQueryResult<Row> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

/**
 * Structural query subset shared by `pg.Pool`, `pg.Client`, and
 * `pg.PoolClient`. Read-only APIs accept this directly; mutation APIs require
 * the branded transaction produced by `withMeteringTransaction`.
 */
export interface MeteringQueryExecutor {
  query<Row>(
    text: string,
    params?: unknown[],
  ): Promise<MeteringQueryResult<Row>>;
}

export type MeteringPeriod = "calendar_day" | "calendar_month" | "lifetime";

export interface PolicyRevisionSnapshot<Document> {
  readonly id: string;
  readonly key: string;
  readonly revision: number;
  readonly immutableHash: string;
  readonly document: Document;
}

export interface PeriodWindow {
  readonly kind: MeteringPeriod;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface FiniteEntitlementLimit {
  readonly kind: "limited";
  readonly metric: string;
  readonly unit: string;
  readonly period: MeteringPeriod;
  readonly amount: string;
}

export interface UnlimitedEntitlementLimit {
  readonly kind: "unlimited";
  readonly metric: string;
  readonly unit: string;
  readonly period: MeteringPeriod;
}

export type EntitlementLimit =
  | FiniteEntitlementLimit
  | UnlimitedEntitlementLimit;

export type CapabilityDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied" }
  | { readonly kind: "workspace_unavailable" };

export type LimitDecision =
  | { readonly kind: "configured"; readonly limit: EntitlementLimit }
  | { readonly kind: "not_configured" }
  | { readonly kind: "invalid_configuration" }
  | { readonly kind: "workspace_unavailable" };

export interface CapabilityCheckInput {
  readonly actorUserId: string;
  readonly workspaceId: string;
  readonly capability: string;
}

export interface LimitCheckInput {
  readonly actorUserId: string;
  readonly workspaceId: string;
  readonly metric: string;
}
