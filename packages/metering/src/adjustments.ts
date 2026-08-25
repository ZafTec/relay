import { fingerprint, generateMeteringId, sha256Hex } from "./canonical.ts";
import { isZeroDecimalAmount, normalizeDecimalAmount } from "./decimal.ts";
import {
  assertMeteringTransaction,
  type MeteringTransaction,
} from "./transaction.ts";
import { requireText } from "./validation.ts";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface AdjustCustomerUsageInput {
  readonly operatorSessionId: string;
  readonly workspaceId: string;
  readonly usageEventId: string;
  readonly idempotencyKey: string;
  readonly quantityDelta: string;
  readonly reason: string;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly requestId?: string | null;
  readonly traceId?: string | null;
}

export interface UsageAdjustmentReceipt {
  readonly adjustmentId: string;
  readonly workspaceId: string;
  readonly usageEventId: string;
  readonly adjustedByUserId: string;
  readonly metric: string;
  readonly unit: string;
  readonly quantityDelta: string;
  readonly reason: string;
  readonly occurredAt: Date;
}

export type AdjustCustomerUsageResult =
  | {
    readonly kind: "adjusted" | "replayed";
    readonly receipt: UsageAdjustmentReceipt;
  }
  | { readonly kind: "not_found" }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "would_make_usage_negative" }
  | { readonly kind: "denied" }
  | { readonly kind: "reauthentication_required" };

interface AdjustmentFunctionResult {
  readonly kind: AdjustCustomerUsageResult["kind"];
  readonly adjustmentId?: string;
  readonly workspaceId?: string;
  readonly usageEventId?: string;
  readonly adjustedByUserId?: string;
  readonly metric?: string;
  readonly unit?: string;
  readonly quantityDelta?: string;
  readonly reason?: string;
  readonly occurredAt?: string;
}

function optionalCorrelationId(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (!CORRELATION_ID_PATTERN.test(value)) {
    throw new TypeError(
      `${field} must contain 1-128 letters, digits, dot, underscore, colon, or hyphen`,
    );
  }
  return value;
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function receipt(result: AdjustmentFunctionResult): UsageAdjustmentReceipt {
  if (
    result.adjustmentId === undefined || result.workspaceId === undefined ||
    result.usageEventId === undefined ||
    result.adjustedByUserId === undefined || result.metric === undefined ||
    result.unit === undefined || result.quantityDelta === undefined ||
    result.reason === undefined || result.occurredAt === undefined
  ) {
    throw new Error("Adjustment function returned an incomplete receipt");
  }
  const occurredAt = new Date(result.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error("Adjustment function returned an invalid timestamp");
  }
  return {
    adjustmentId: result.adjustmentId,
    workspaceId: result.workspaceId,
    usageEventId: result.usageEventId,
    adjustedByUserId: result.adjustedByUserId,
    metric: result.metric,
    unit: result.unit,
    quantityDelta: normalizeDecimalAmount(result.quantityDelta, {
      allowNegative: true,
    }),
    reason: result.reason,
    occurredAt,
  };
}

export async function adjustCustomerUsage(
  transaction: MeteringTransaction,
  input: AdjustCustomerUsageInput,
): Promise<AdjustCustomerUsageResult> {
  assertMeteringTransaction(transaction);
  requireText(input.operatorSessionId, "operatorSessionId");
  requireText(input.workspaceId, "workspaceId");
  requireText(input.usageEventId, "usageEventId");
  requireText(input.idempotencyKey, "idempotencyKey");
  requireText(input.reason, "reason", 500);
  const quantityDelta = normalizeDecimalAmount(input.quantityDelta, {
    allowNegative: true,
  });
  if (isZeroDecimalAmount(quantityDelta)) {
    throw new TypeError("quantityDelta must not be zero");
  }
  if (
    input.metadata !== undefined && input.metadata !== null &&
    (typeof input.metadata !== "object" || Array.isArray(input.metadata))
  ) throw new TypeError("metadata must be an object or null");
  const requestId = optionalCorrelationId(input.requestId, "requestId");
  const traceId = optionalCorrelationId(input.traceId, "traceId");

  const keyHash = await sha256Hex(input.idempotencyKey);
  const requestHash = await fingerprint({
    operation: "adjust-customer-usage",
    workspaceId: input.workspaceId,
    usageEventId: input.usageEventId,
    quantityDelta,
    reason: input.reason,
    metadata: input.metadata ?? null,
  });

  try {
    const { rows } = await transaction.query<{
      result: AdjustmentFunctionResult;
    }>(
      `select relay.adjust_customer_usage(
         $1, $2, $3, $4, $5, $6, $7::numeric, $8, $9::jsonb, $10, $11
       ) as result`,
      [
        generateMeteringId("adjustment"),
        input.operatorSessionId,
        input.workspaceId,
        input.usageEventId,
        keyHash,
        requestHash,
        quantityDelta,
        input.reason,
        JSON.stringify(input.metadata ?? {}),
        requestId,
        traceId,
      ],
    );
    const result = rows[0]?.result;
    if (result === undefined) {
      throw new Error("Adjustment function returned no result");
    }
    if (result.kind === "adjusted" || result.kind === "replayed") {
      return { kind: result.kind, receipt: receipt(result) };
    }
    if (
      result.kind === "not_found" || result.kind === "idempotency_conflict" ||
      result.kind === "would_make_usage_negative"
    ) {
      return { kind: result.kind };
    }
    throw new Error("Adjustment function returned an unexpected result");
  } catch (error) {
    const code = databaseErrorCode(error);
    if (code === "42501") return { kind: "denied" };
    if (code === "28000" || code === "55000") {
      return { kind: "reauthentication_required" };
    }
    throw error;
  }
}
