import { DECIMAL_AMOUNT_PATTERN, SAFE_CODE_PATTERN } from "@relay/contracts";
import {
  estimateUsage,
  reserveUsageForAdmission,
  type UsageMeasureRanges,
  withMeteringTransaction,
} from "@relay/metering";
import type {
  AdmissionUsageFailure,
  AdmissionUsageMeasures,
  AdmissionUsagePort,
  AdmissionUsageQuote,
  AdmissionUsageQuoteResult,
  AdmissionUsageRequest,
  AdmissionUsageReservationResult,
} from "../../queue/src/admission.ts";
import { MAX_SCHEDULER_COST_UNITS } from "../../queue/src/tickets.ts";

export const DEFAULT_ADMISSION_RESERVATION_TTL_SECONDS = 24 * 60 * 60;
export const MAX_ADMISSION_RESERVATION_TTL_SECONDS = 30 * 24 * 60 * 60;

const GPT_IMAGE_TOOL_KEY = "image.generate.gpt-image-2";
const FLUX_IMAGE_TOOL_KEY = "image.generate.flux-2-pro";
const OCR_TOOL_KEY = "document.ocr";
const RUN_RESERVATION_IDEMPOTENCY_DOMAIN = "run-admission";

export interface PostgresAdmissionUsagePortOptions {
  readonly reservationTtlSeconds?: number;
}

export interface PostgresAdmissionUsagePortDependencies {
  readonly estimateUsage: typeof estimateUsage;
  readonly reserveUsageForAdmission: typeof reserveUsageForAdmission;
}

const DEFAULT_DEPENDENCIES: PostgresAdmissionUsagePortDependencies = {
  estimateUsage,
  reserveUsageForAdmission,
};

function boundedPositiveInteger(
  value: number,
  field: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${field} must be between 1 and ${maximum}`);
  }
  return value;
}

function measureRange(amount: number): AdmissionUsageMeasures {
  const normalized = String(amount);
  return Object.freeze({
    requested_units: Object.freeze({
      minimum: normalized,
      expected: normalized,
      maximum: normalized,
    }),
  });
}

function inputObject(input: unknown): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("GPT Image admission input must be an object");
  }
  return input as Readonly<Record<string, unknown>>;
}

/** Resolves the only metering measures admitted by the production MVP tools. */
export function resolveAdmissionUsageMeasures(
  toolKey: string,
  input: unknown,
): AdmissionUsageMeasures {
  switch (toolKey) {
    case "image.edit.gpt-image-2":
    case GPT_IMAGE_TOOL_KEY: {
      const rawInput = inputObject(input);
      const requested = rawInput.n === undefined ? 1 : rawInput.n;
      if (
        typeof requested !== "number" ||
        !Number.isSafeInteger(requested) ||
        requested < 1 ||
        requested > 10
      ) {
        throw new TypeError("GPT Image n must be an integer between 1 and 10");
      }
      return measureRange(requested);
    }
    case FLUX_IMAGE_TOOL_KEY:
    case "image.edit.flux-2-pro":
    case "image.generate.mai-image-2.5":
    case "image.edit.mai-image-2.5":
    case "image.generate.mai-image-2.5-flash":
    case "image.edit.mai-image-2.5-flash":
    case OCR_TOOL_KEY:
      return measureRange(1);
    default:
      throw new TypeError("Tool has no admission metering measure mapping");
  }
}

/** Converts the normalized expected estimate into a scheduler-safe cost. */
export function schedulerCostFromExpectedUsage(expected: string): number {
  if (!DECIMAL_AMOUNT_PATTERN.test(expected)) {
    throw new TypeError("Metering expected usage must be a decimal amount");
  }
  const parsed = Number(expected);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new TypeError("Metering expected usage must be non-negative");
  }
  if (!Number.isFinite(parsed) || parsed >= MAX_SCHEDULER_COST_UNITS) {
    return MAX_SCHEDULER_COST_UNITS;
  }
  return Math.max(1, parsed);
}

export function runAdmissionReservationIdempotencyKey(
  runIdempotencyKey: string,
): string {
  return `${RUN_RESERVATION_IDEMPOTENCY_DOMAIN}:${runIdempotencyKey}`;
}

function unavailable(
  reason: "unavailable" | "invalid_configuration",
): AdmissionUsageFailure {
  return { kind: "usage_unavailable", reason };
}

function mapPreparationFailure(
  kind:
    | "workspace_unavailable"
    | "tool_unavailable"
    | "metering_not_configured"
    | "not_entitled"
    | "invalid_configuration",
): AdmissionUsageFailure {
  switch (kind) {
    case "not_entitled":
      return { kind: "not_entitled" };
    case "workspace_unavailable":
      return unavailable("unavailable");
    case "tool_unavailable":
    case "metering_not_configured":
    case "invalid_configuration":
      return unavailable("invalid_configuration");
  }
}

function safeAllowanceFailure(result: {
  readonly metric: string;
  readonly unit: string;
  readonly limitAmount: string;
  readonly consumedAmount: string;
  readonly reservedAmount: string;
  readonly requestedAmount: string;
}): AdmissionUsageFailure {
  if (
    !SAFE_CODE_PATTERN.test(result.metric) ||
    !SAFE_CODE_PATTERN.test(result.unit) ||
    !DECIMAL_AMOUNT_PATTERN.test(result.limitAmount) ||
    !DECIMAL_AMOUNT_PATTERN.test(result.consumedAmount) ||
    !DECIMAL_AMOUNT_PATTERN.test(result.reservedAmount) ||
    !DECIMAL_AMOUNT_PATTERN.test(result.requestedAmount)
  ) {
    return unavailable("invalid_configuration");
  }
  return { kind: "allowance_exceeded", ...result };
}

function policyIdentity(policy: {
  readonly key: string;
  readonly revision: number;
  readonly immutableHash: string;
}): string {
  return `meter:${policy.key}:r${policy.revision}:${policy.immutableHash}`;
}

function sameMeasures(
  left: AdmissionUsageMeasures,
  right: UsageMeasureRanges,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }
  return leftKeys.every((key) => {
    const leftRange = left[key];
    const rightRange = right[key];
    return rightRange !== undefined &&
      leftRange.minimum === rightRange.minimum &&
      leftRange.expected === rightRange.expected &&
      leftRange.maximum === rightRange.maximum;
  });
}

async function loadToolKey(
  client: Parameters<AdmissionUsagePort["quote"]>[0],
  toolId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ readonly key: string }>(
    "select key from relay.tools where id = $1",
    [toolId],
  );
  return rows[0]?.key ?? null;
}

/**
 * PostgreSQL-backed bridge from queue admission to metering. It never opens or
 * commits a transaction: quote reads and reservation writes use the queue's
 * checked-out client, and `withMeteringTransaction` only verifies that client is
 * already inside the caller-owned acceptance transaction.
 */
export class PostgresAdmissionUsagePort implements AdmissionUsagePort {
  readonly #reservationTtlSeconds: number;
  readonly #dependencies: PostgresAdmissionUsagePortDependencies;

  constructor(
    options: PostgresAdmissionUsagePortOptions = {},
    dependencies: PostgresAdmissionUsagePortDependencies = DEFAULT_DEPENDENCIES,
  ) {
    this.#reservationTtlSeconds = boundedPositiveInteger(
      options.reservationTtlSeconds ??
        DEFAULT_ADMISSION_RESERVATION_TTL_SECONDS,
      "reservationTtlSeconds",
      MAX_ADMISSION_RESERVATION_TTL_SECONDS,
    );
    this.#dependencies = dependencies;
  }

  async quote(
    client: Parameters<AdmissionUsagePort["quote"]>[0],
    request: AdmissionUsageRequest,
  ): Promise<AdmissionUsageQuoteResult> {
    const toolKey = await loadToolKey(client, request.route.route.toolId);
    if (toolKey === null) return unavailable("invalid_configuration");

    let measures: AdmissionUsageMeasures;
    try {
      measures = resolveAdmissionUsageMeasures(toolKey, request.input);
    } catch (error) {
      if (error instanceof TypeError) {
        return unavailable("invalid_configuration");
      }
      throw error;
    }

    const result = await this.#dependencies.estimateUsage(client, {
      actorUserId: request.createdBy,
      workspaceId: request.workspaceId,
      toolVersionId: request.toolVersionId,
      providerModelId: request.route.route.providerModelId,
      measures,
    });
    if (result.kind !== "estimated") {
      return mapPreparationFailure(result.kind);
    }

    let estimatedCostUnits: number;
    try {
      estimatedCostUnits = schedulerCostFromExpectedUsage(
        result.estimate.expected,
      );
    } catch (error) {
      if (error instanceof TypeError) {
        return unavailable("invalid_configuration");
      }
      throw error;
    }

    return {
      estimatedCostUnits,
      policyKey: policyIdentity(result.meterPolicy),
      measures,
    };
  }

  async reserve(
    client: Parameters<AdmissionUsagePort["reserve"]>[0],
    request: AdmissionUsageRequest,
    quote: AdmissionUsageQuote,
  ): Promise<AdmissionUsageReservationResult> {
    const measures = quote.measures;
    if (measures === undefined) return unavailable("invalid_configuration");

    const result = await withMeteringTransaction(
      client,
      (transaction) =>
        this.#dependencies.reserveUsageForAdmission(transaction, {
          actorUserId: request.createdBy,
          workspaceId: request.workspaceId,
          toolVersionId: request.toolVersionId,
          providerModelId: request.route.route.providerModelId,
          measures,
          idempotencyKey: runAdmissionReservationIdempotencyKey(
            request.runIdempotencyKey,
          ),
          reservationTtlSeconds: this.#reservationTtlSeconds,
        }),
    );

    switch (result.kind) {
      case "reserved":
      case "replayed":
        if (
          policyIdentity(result.reservation.meterPolicy) !== quote.policyKey ||
          !sameMeasures(measures, result.reservation.estimate.measures)
        ) {
          throw new Error(
            "Metering reservation does not match its admission quote",
          );
        }
        return result.reservation.reservationId;
      case "allowance_exceeded":
        return safeAllowanceFailure(result);
      case "idempotency_conflict":
        return { kind: "idempotency_conflict" };
      case "workspace_unavailable":
      case "tool_unavailable":
      case "metering_not_configured":
      case "not_entitled":
      case "invalid_configuration":
        return mapPreparationFailure(result.kind);
    }
  }
}

export function createPostgresAdmissionUsagePort(
  options: PostgresAdmissionUsagePortOptions = {},
): AdmissionUsagePort {
  return new PostgresAdmissionUsagePort(options);
}
