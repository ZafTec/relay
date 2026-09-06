import { fingerprint, generateMeteringId, sha256Hex } from "./canonical.ts";
import {
  formatDecimalAmount,
  normalizeDecimalAmount,
  parseDecimalAmount,
} from "./decimal.ts";
import {
  hasWorkspaceAccess,
  resolveCapabilityAt,
  resolveLimitAt,
  transactionTimestamp,
} from "./entitlements.ts";
import { periodWindow } from "./periods.ts";
import {
  estimateMeteredUsage,
  InvalidPolicyError,
  type MeterPolicyDocumentV1,
  parseMeterPolicyDocument,
  type UsageEstimate,
} from "./policies.ts";
import { lockIdempotencyKey } from "./postgres.ts";
import {
  assertMeteringTransaction,
  type MeteringTransaction,
} from "./transaction.ts";
import type {
  EntitlementLimit,
  MeteringQueryExecutor,
  PolicyRevisionSnapshot,
} from "./types.ts";
import { requirePositiveSafeInteger, requireText } from "./validation.ts";

const MAX_RESERVATION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface EstimateUsageInput {
  readonly actorUserId: string;
  readonly workspaceId: string;
  readonly toolVersionId: string;
  /** PostgreSQL bigint represented as text to avoid JavaScript precision loss. */
  readonly providerModelId: string;
  readonly measures: Readonly<Record<string, unknown>>;
}

export interface AdmissionReservationInput extends EstimateUsageInput {
  readonly idempotencyKey: string;
  readonly reservationTtlSeconds: number;
}

export interface EntitlementSnapshot {
  readonly capturedAt: string;
  readonly capability: {
    readonly key: string;
    readonly grants: readonly unknown[];
  };
  readonly limit: EntitlementLimit & {
    readonly grants: readonly unknown[];
  };
}

export interface UsageReservationReceipt {
  readonly reservationId: string;
  readonly workspaceId: string;
  readonly providerModelId: string;
  readonly status: "active" | "committed" | "released" | "expired";
  readonly estimate: UsageEstimate;
  readonly reservedAmount: string;
  readonly committedAmount: string;
  readonly releasedAmount: string;
  readonly meterPolicy: PolicyRevisionSnapshot<MeterPolicyDocumentV1>;
  readonly entitlement: EntitlementSnapshot;
  readonly limitAmount: string | null;
  readonly periodStartsAt: Date;
  readonly periodEndsAt: Date;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly finalizedAt: Date | null;
}

export type MeteringPreparationFailure =
  | { readonly kind: "workspace_unavailable" }
  | { readonly kind: "tool_unavailable" }
  | { readonly kind: "metering_not_configured" }
  | { readonly kind: "not_entitled" }
  | { readonly kind: "invalid_configuration" };

export type EstimateUsageResult =
  | {
    readonly kind: "estimated";
    readonly estimate: UsageEstimate;
    readonly meterPolicy: PolicyRevisionSnapshot<MeterPolicyDocumentV1>;
    readonly entitlement: EntitlementSnapshot;
    readonly limitAmount: string | null;
  }
  | MeteringPreparationFailure;

export type AdmissionReservationResult =
  | {
    readonly kind: "reserved" | "replayed";
    readonly reservation: UsageReservationReceipt;
    /** `null` means the entitlement is explicitly unlimited. */
    readonly remainingAmount: string | null;
  }
  | MeteringPreparationFailure
  | { readonly kind: "idempotency_conflict" }
  | {
    readonly kind: "allowance_exceeded";
    readonly metric: string;
    readonly unit: string;
    readonly limitAmount: string;
    readonly consumedAmount: string;
    readonly reservedAmount: string;
    readonly requestedAmount: string;
  };

export interface AdmissionMeteringTransactionPort {
  /**
   * Does not issue BEGIN/COMMIT/ROLLBACK. The caller owns the transaction and
   * can atomically combine this reservation with run/job/outbox writes.
   */
  reserve(
    transaction: MeteringTransaction,
    input: AdmissionReservationInput,
  ): Promise<AdmissionReservationResult>;
}

interface ToolMeteringRow {
  meter_policy_id: string | null;
  entitlement_key: string | null;
}

interface MeterPolicyRow {
  id: string;
  policy_key: string;
  revision: number;
  document: unknown;
  immutable_hash: string;
  hash_is_valid: boolean;
}

interface LoadedMeterPolicy {
  readonly revision: PolicyRevisionSnapshot<MeterPolicyDocumentV1>;
  readonly storedDocument: unknown;
}

interface PreparedMetering {
  readonly estimate: UsageEstimate;
  readonly meterPolicy: PolicyRevisionSnapshot<MeterPolicyDocumentV1>;
  readonly meterPolicySnapshot: unknown;
  readonly entitlement: EntitlementSnapshot;
  readonly limit: EntitlementLimit;
}

interface UsageBucketRow {
  id: string;
  consumed_amount: string;
  reserved_amount: string;
}

interface ReservationDbRow {
  id: string;
  workspace_id: string;
  provider_model_id: string;
  status: UsageReservationReceipt["status"];
  metric_key: string;
  unit: string;
  period: UsageEstimate["period"];
  period_start: Date;
  period_end: Date;
  estimate_measures: UsageEstimate["measures"];
  estimated_minimum: string;
  estimated_expected: string;
  estimated_maximum: string;
  reserved_amount: string;
  committed_amount: string;
  released_amount: string;
  meter_policy_id: string;
  meter_policy_key: string;
  meter_policy_revision: number;
  meter_policy_hash: string;
  meter_policy_snapshot: unknown;
  entitlement_snapshot: EntitlementSnapshot;
  limit_amount_snapshot: string | null;
  expires_at: Date;
  created_at: Date;
  finalized_at: Date | null;
}

function validateEstimateInput(input: EstimateUsageInput): void {
  requireText(input.actorUserId, "actorUserId");
  requireText(input.workspaceId, "workspaceId");
  requireText(input.toolVersionId, "toolVersionId");
  requireText(input.providerModelId, "providerModelId");
  if (!/^[1-9][0-9]*$/.test(input.providerModelId)) {
    throw new TypeError(
      "providerModelId must be a positive PostgreSQL bigint string",
    );
  }
  if (
    input.measures === null || typeof input.measures !== "object" ||
    Array.isArray(input.measures)
  ) {
    throw new TypeError("measures must be an object");
  }
}

function validateReservationInput(input: AdmissionReservationInput): void {
  validateEstimateInput(input);
  requireText(input.idempotencyKey, "idempotencyKey");
  requirePositiveSafeInteger(
    input.reservationTtlSeconds,
    "reservationTtlSeconds",
    MAX_RESERVATION_TTL_SECONDS,
  );
}

async function loadToolMetering(
  queryable: MeteringQueryExecutor,
  toolVersionId: string,
  providerModelId: string,
): Promise<ToolMeteringRow | null> {
  const { rows } = await queryable.query<ToolMeteringRow>(
    `select tv.meter_policy_id, tv.entitlement_key
       from relay.tool_versions tv
       join relay.tools t on t.id = tv.tool_id
      where tv.id = $1
        and tv.published_at is not null
        and t.lifecycle not in ('disabled', 'retired')
        and exists (
          select 1
            from relay.tool_provider_bindings binding
            join relay.provider_models model on model.id = binding.provider_model_id
            join relay.providers provider on provider.id = model.provider_id
            join relay.capacity_pools pool on pool.id = binding.capacity_pool_id
           where binding.tool_version_id = tv.id
             and binding.provider_model_id = $2
             and binding.enabled = true
             and model.lifecycle not in ('disabled', 'retired')
             and provider.lifecycle not in ('disabled', 'retired')
             and pool.enabled = true
        )`,
    [toolVersionId, providerModelId],
  );
  return rows[0] ?? null;
}

async function loadMeterPolicy(
  queryable: MeteringQueryExecutor,
  meterPolicyId: string,
  at: Date,
): Promise<LoadedMeterPolicy | null> {
  const { rows } = await queryable.query<MeterPolicyRow>(
    `select id, policy_key, revision, document, immutable_hash,
            immutable_hash = relay.compute_meter_policy_immutable_hash(
              id, policy_key, revision, document, effective_at, expires_at
            ) as hash_is_valid
       from relay.meter_policies
      where id = $1
        and effective_at <= $2
        and (expires_at is null or expires_at > $2)`,
    [meterPolicyId, at],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!row.hash_is_valid) {
    throw new InvalidPolicyError("meter policy immutable hash is invalid");
  }
  return {
    revision: {
      id: row.id,
      key: row.policy_key,
      revision: row.revision,
      immutableHash: row.immutable_hash,
      document: parseMeterPolicyDocument(row.document),
    },
    storedDocument: row.document,
  };
}

async function prepareMetering(
  queryable: MeteringQueryExecutor,
  input: EstimateUsageInput,
  at: Date,
): Promise<PreparedMetering | MeteringPreparationFailure> {
  const tool = await loadToolMetering(
    queryable,
    input.toolVersionId,
    input.providerModelId,
  );
  if (tool === null) return { kind: "tool_unavailable" };
  if (tool.meter_policy_id === null || tool.entitlement_key === null) {
    return { kind: "metering_not_configured" };
  }

  let loadedMeterPolicy: LoadedMeterPolicy | null;
  try {
    loadedMeterPolicy = await loadMeterPolicy(
      queryable,
      tool.meter_policy_id,
      at,
    );
  } catch (error) {
    if (error instanceof InvalidPolicyError) {
      return { kind: "invalid_configuration" };
    }
    throw error;
  }
  if (loadedMeterPolicy === null) {
    return { kind: "metering_not_configured" };
  }
  const meterPolicy = loadedMeterPolicy.revision;

  const capability = await resolveCapabilityAt(
    queryable,
    input.workspaceId,
    tool.entitlement_key,
    at,
  );
  if (!capability.allowed) return { kind: "not_entitled" };
  const resolvedLimit = await resolveLimitAt(
    queryable,
    input.workspaceId,
    meterPolicy.document.metric,
    at,
  );
  if (resolvedLimit.kind === "none") return { kind: "not_entitled" };
  if (resolvedLimit.kind === "invalid") {
    return { kind: "invalid_configuration" };
  }
  const limit = resolvedLimit.limit!;
  if (
    limit.unit !== meterPolicy.document.unit ||
    limit.period !== meterPolicy.document.period
  ) {
    return { kind: "invalid_configuration" };
  }

  let estimate: UsageEstimate;
  try {
    estimate = estimateMeteredUsage(meterPolicy.document, input.measures);
  } catch (error) {
    if (error instanceof InvalidPolicyError) {
      return { kind: "invalid_configuration" };
    }
    throw error;
  }

  return {
    estimate,
    meterPolicy,
    meterPolicySnapshot: loadedMeterPolicy.storedDocument,
    limit,
    entitlement: {
      capturedAt: at.toISOString(),
      capability: {
        key: capability.capability,
        grants: capability.grants,
      },
      limit: {
        ...limit,
        grants: resolvedLimit.grants,
      },
    },
  };
}

function reservationReceipt(row: ReservationDbRow): UsageReservationReceipt {
  const document = parseMeterPolicyDocument(row.meter_policy_snapshot);
  return {
    reservationId: row.id,
    workspaceId: row.workspace_id,
    providerModelId: String(row.provider_model_id),
    status: row.status,
    estimate: {
      metric: row.metric_key,
      unit: row.unit,
      period: row.period,
      minimum: normalizeDecimalAmount(row.estimated_minimum),
      expected: normalizeDecimalAmount(row.estimated_expected),
      maximum: normalizeDecimalAmount(row.estimated_maximum),
      reserve: normalizeDecimalAmount(row.reserved_amount),
      measures: row.estimate_measures,
    },
    reservedAmount: normalizeDecimalAmount(row.reserved_amount),
    committedAmount: normalizeDecimalAmount(row.committed_amount),
    releasedAmount: normalizeDecimalAmount(row.released_amount),
    meterPolicy: {
      id: row.meter_policy_id,
      key: row.meter_policy_key,
      revision: row.meter_policy_revision,
      immutableHash: row.meter_policy_hash,
      document,
    },
    entitlement: row.entitlement_snapshot,
    limitAmount: row.limit_amount_snapshot === null
      ? null
      : normalizeDecimalAmount(row.limit_amount_snapshot),
    periodStartsAt: row.period_start,
    periodEndsAt: row.period_end,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    finalizedAt: row.finalized_at,
  };
}

async function readReservationByReserveKey(
  queryable: MeteringQueryExecutor,
  workspaceId: string,
  idempotencyKeyHash: string,
): Promise<(ReservationDbRow & { reserve_request_hash: string }) | null> {
  const { rows } = await queryable.query<
    ReservationDbRow & { reserve_request_hash: string }
  >(
    `select id, workspace_id, provider_model_id::text, status, metric_key, unit,
            period, period_start, period_end, estimate_measures,
            estimated_minimum, estimated_expected, estimated_maximum,
            reserved_amount,
            committed_amount, released_amount, meter_policy_id,
            meter_policy_key, meter_policy_revision, meter_policy_hash,
            meter_policy_snapshot, entitlement_snapshot,
            limit_amount_snapshot, reserve_request_hash, expires_at, created_at,
            finalized_at
       from relay.usage_reservations
      where workspace_id = $1 and reserve_idempotency_key_hash = $2`,
    [workspaceId, idempotencyKeyHash],
  );
  return rows[0] ?? null;
}

function remainingAmount(
  limitAmount: string | null,
  consumedAmount: string,
  reservedAmount: string,
): string | null {
  if (limitAmount === null) return null;
  const remaining = parseDecimalAmount(limitAmount) -
    parseDecimalAmount(consumedAmount) - parseDecimalAmount(reservedAmount);
  return formatDecimalAmount(remaining > 0n ? remaining : 0n);
}

export async function estimateUsage(
  queryable: MeteringQueryExecutor,
  input: EstimateUsageInput,
): Promise<EstimateUsageResult> {
  validateEstimateInput(input);
  if (
    !await hasWorkspaceAccess(queryable, input.workspaceId, input.actorUserId)
  ) {
    return { kind: "workspace_unavailable" };
  }
  const prepared = await prepareMetering(
    queryable,
    input,
    await transactionTimestamp(queryable),
  );
  if ("kind" in prepared) return prepared;
  return {
    kind: "estimated",
    estimate: prepared.estimate,
    meterPolicy: prepared.meterPolicy,
    entitlement: prepared.entitlement,
    limitAmount: prepared.limit.kind === "limited"
      ? prepared.limit.amount
      : null,
  };
}

export async function reserveUsageForAdmission(
  transaction: MeteringTransaction,
  input: AdmissionReservationInput,
): Promise<AdmissionReservationResult> {
  assertMeteringTransaction(transaction);
  validateReservationInput(input);
  const idempotencyKeyHash = await sha256Hex(input.idempotencyKey);
  const requestHash = await fingerprint({
    operation: "reserve",
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    toolVersionId: input.toolVersionId,
    providerModelId: input.providerModelId,
    measures: input.measures,
    reservationTtlSeconds: input.reservationTtlSeconds,
  });
  await lockIdempotencyKey(
    transaction,
    input.workspaceId,
    "usage-reserve",
    idempotencyKeyHash,
  );

  // Authorization intentionally precedes idempotency/resource lookups so an
  // outsider cannot probe whether a workspace has a matching reservation.
  if (
    !await hasWorkspaceAccess(transaction, input.workspaceId, input.actorUserId)
  ) {
    return { kind: "workspace_unavailable" };
  }

  const replay = await readReservationByReserveKey(
    transaction,
    input.workspaceId,
    idempotencyKeyHash,
  );
  if (replay !== null) {
    if (replay.reserve_request_hash !== requestHash) {
      return { kind: "idempotency_conflict" };
    }
    const bucket = await transaction.query<UsageBucketRow>(
      `select id::text, consumed_amount, reserved_amount
         from relay.usage_buckets
        where id = (
          select bucket_id from relay.usage_reservations where id = $1
        )`,
      [replay.id],
    );
    const receipt = reservationReceipt(replay);
    return {
      kind: "replayed",
      reservation: receipt,
      remainingAmount: remainingAmount(
        receipt.limitAmount,
        normalizeDecimalAmount(bucket.rows[0].consumed_amount),
        normalizeDecimalAmount(bucket.rows[0].reserved_amount),
      ),
    };
  }

  // Grant changes serialize with new reservations. Read the clock after the
  // lock: transaction_timestamp can predate a revocation we waited behind.
  await transaction.query(
    `select pg_advisory_xact_lock_shared(
      hashtextextended('relay.allowance:workspace:' || $1, 0))`,
    [input.workspaceId],
  );
  const { rows: clock } = await transaction.query<{ now: Date }>(
    "select clock_timestamp() as now",
  );
  const at = clock[0].now;
  const prepared = await prepareMetering(transaction, input, at);
  if ("kind" in prepared) return prepared;
  const window = periodWindow(at, prepared.estimate.period);
  const ttlExpiry = new Date(
    at.getTime() + input.reservationTtlSeconds * 1_000,
  );
  const expiresAt = ttlExpiry < window.endsAt ? ttlExpiry : window.endsAt;

  const bucket = await transaction.query<UsageBucketRow>(
    `insert into relay.usage_buckets
       (workspace_id, metric_key, unit, period, period_start, period_end)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (workspace_id, metric_key, unit, period, period_start, period_end)
     do update set workspace_id = excluded.workspace_id
     returning id::text, consumed_amount, reserved_amount`,
    [
      input.workspaceId,
      prepared.estimate.metric,
      prepared.estimate.unit,
      prepared.estimate.period,
      window.startsAt,
      window.endsAt,
    ],
  );
  const bucketId = bucket.rows[0].id;
  const limitAmount = prepared.limit.kind === "limited"
    ? prepared.limit.amount
    : null;
  const reservedBucket = await transaction.query<UsageBucketRow>(
    `update relay.usage_buckets
        set reserved_amount = reserved_amount + $2::numeric,
            updated_at = $3
      where id = $1
        and (
          $4::numeric is null
          or consumed_amount + reserved_amount + $2::numeric <= $4::numeric
        )
      returning id::text, consumed_amount, reserved_amount`,
    [bucketId, prepared.estimate.reserve, at, limitAmount],
  );
  if (reservedBucket.rows.length === 0) {
    const current = await transaction.query<UsageBucketRow>(
      `select id::text, consumed_amount, reserved_amount
         from relay.usage_buckets
        where id = $1`,
      [bucketId],
    );
    return {
      kind: "allowance_exceeded",
      metric: prepared.estimate.metric,
      unit: prepared.estimate.unit,
      limitAmount: limitAmount!,
      consumedAmount: normalizeDecimalAmount(current.rows[0].consumed_amount),
      reservedAmount: normalizeDecimalAmount(current.rows[0].reserved_amount),
      requestedAmount: prepared.estimate.reserve,
    };
  }

  const reservationId = generateMeteringId("reservation");
  const inserted = await transaction.query<ReservationDbRow>(
    `insert into relay.usage_reservations (
       id, workspace_id, bucket_id, tool_version_id, provider_model_id,
       capability_key, metric_key, unit, period, period_start, period_end,
       estimate_measures, estimated_minimum, estimated_expected,
       estimated_maximum, reserved_amount, meter_policy_id, meter_policy_key,
       meter_policy_revision, meter_policy_hash, meter_policy_snapshot,
       entitlement_snapshot, limit_amount_snapshot,
       reserve_idempotency_key_hash, reserve_request_hash, expires_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, $17, $18, $19, $20,
       $21, $22, $23, $24, $25, $26
     )
     returning id, workspace_id, provider_model_id::text, status, metric_key,
               unit, period, period_start, period_end, estimate_measures,
               estimated_minimum, estimated_expected, estimated_maximum,
               reserved_amount,
               committed_amount, released_amount, meter_policy_id,
               meter_policy_key, meter_policy_revision, meter_policy_hash,
               meter_policy_snapshot, entitlement_snapshot,
               limit_amount_snapshot, expires_at, created_at, finalized_at`,
    [
      reservationId,
      input.workspaceId,
      bucketId,
      input.toolVersionId,
      input.providerModelId,
      prepared.entitlement.capability.key,
      prepared.estimate.metric,
      prepared.estimate.unit,
      prepared.estimate.period,
      window.startsAt,
      window.endsAt,
      JSON.stringify(prepared.estimate.measures),
      prepared.estimate.minimum,
      prepared.estimate.expected,
      prepared.estimate.maximum,
      prepared.estimate.reserve,
      prepared.meterPolicy.id,
      prepared.meterPolicy.key,
      prepared.meterPolicy.revision,
      prepared.meterPolicy.immutableHash,
      JSON.stringify(prepared.meterPolicySnapshot),
      JSON.stringify(prepared.entitlement),
      limitAmount,
      idempotencyKeyHash,
      requestHash,
      expiresAt,
    ],
  );
  const receipt = reservationReceipt(inserted.rows[0]);
  return {
    kind: "reserved",
    reservation: receipt,
    remainingAmount: remainingAmount(
      limitAmount,
      normalizeDecimalAmount(reservedBucket.rows[0].consumed_amount),
      normalizeDecimalAmount(reservedBucket.rows[0].reserved_amount),
    ),
  };
}

export const postgresAdmissionMeteringPort: AdmissionMeteringTransactionPort =
  Object.freeze({ reserve: reserveUsageForAdmission });
