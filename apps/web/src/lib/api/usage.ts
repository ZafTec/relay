import { ApiError, fetchJson } from "./client";

const USAGE_PATH = "/api/v1/usage";
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const DECIMAL_AMOUNT_PATTERN = /^(?:0|[1-9][0-9]{0,28})(?:\.[0-9]{1,9})?$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_USAGE_ITEMS = 100;

export const USAGE_PERIODS = [
  "calendar_day",
  "calendar_month",
  "lifetime",
] as const;

export type UsagePeriod = typeof USAGE_PERIODS[number];

export interface UsageSummaryRequest {
  readonly metric?: string;
  readonly period?: UsagePeriod;
}

export interface UsageSummaryItem {
  readonly metric: string;
  readonly unit: string;
  readonly period: UsagePeriod;
  readonly periodStartsAt: string;
  readonly periodEndsAt: string;
  readonly consumedAmount: string;
  readonly reservedAmount: string;
}

export interface UsageSummary {
  readonly generatedAt: string;
  readonly items: readonly UsageSummaryItem[];
  readonly truncated: boolean;
}

export type ParsedUsageSummaryResponse =
  | { readonly kind: "ok"; readonly usage: UsageSummary }
  | { readonly kind: "not_found" };

export type UsageAdapterResult =
  | { readonly kind: "ok"; readonly usage: UsageSummary }
  | { readonly kind: "not-found" }
  | { readonly kind: "auth-expired" }
  | { readonly kind: "degraded"; readonly message: string };

export interface UsageAdapter {
  getSummary(
    request?: UsageSummaryRequest,
    signal?: AbortSignal,
  ): Promise<UsageAdapterResult>;
}

export class InvalidUsageResponseError extends TypeError {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "InvalidUsageResponseError";
  }
}

export class InvalidUsageRequestError extends TypeError {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "InvalidUsageRequestError";
  }
}

type InvalidFactory = (path: string, message: string) => never;

function invalidResponse(path: string, message: string): never {
  throw new InvalidUsageResponseError(path, message);
}

function invalidRequest(path: string, message: string): never {
  throw new InvalidUsageRequestError(path, message);
}

function strictObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  invalid: InvalidFactory,
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    return invalid(path, "must be an object");
  }

  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, "is not supported");
  }
  return value as Record<string, unknown>;
}

function required(
  object: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  if (!Object.hasOwn(object, key)) invalidResponse(`${path}.${key}`, "is required");
  return object[key];
}

function stringValue(
  value: unknown,
  path: string,
  options: {
    readonly minLength: number;
    readonly maxLength: number;
    readonly pattern?: RegExp;
  },
): string {
  if (typeof value !== "string") return invalidResponse(path, "must be a string");
  if (value.length < options.minLength) return invalidResponse(path, "is too short");
  if (value.length > options.maxLength) return invalidResponse(path, "is too long");
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    return invalidResponse(path, "has an invalid format");
  }
  return value;
}

function safeCode(value: unknown, path: string): string {
  return stringValue(value, path, {
    minLength: 1,
    maxLength: 128,
    pattern: SAFE_CODE_PATTERN,
  });
}

function decimalAmount(value: unknown, path: string): string {
  return stringValue(value, path, {
    minLength: 1,
    maxLength: 39,
    pattern: DECIMAL_AMOUNT_PATTERN,
  });
}

function isoTimestamp(value: unknown, path: string): string {
  const timestamp = stringValue(value, path, {
    minLength: 24,
    maxLength: 24,
    pattern: ISO_TIMESTAMP_PATTERN,
  });
  if (!Number.isFinite(Date.parse(timestamp))) {
    return invalidResponse(path, "must be an ISO timestamp");
  }
  return timestamp;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return invalidResponse(path, "must be a boolean");
  return value;
}

function usagePeriod(value: unknown, path: string): UsagePeriod {
  if (
    typeof value !== "string"
    || !(USAGE_PERIODS as readonly string[]).includes(value)
  ) {
    return invalidResponse(path, `must be one of: ${USAGE_PERIODS.join(", ")}`);
  }
  return value as UsagePeriod;
}

function usageItem(value: unknown, path: string): UsageSummaryItem {
  const object = strictObject(value, path, [
    "metric",
    "unit",
    "period",
    "periodStartsAt",
    "periodEndsAt",
    "consumedAmount",
    "reservedAmount",
  ], invalidResponse);
  const periodStartsAt = isoTimestamp(
    required(object, "periodStartsAt", path),
    `${path}.periodStartsAt`,
  );
  const periodEndsAt = isoTimestamp(
    required(object, "periodEndsAt", path),
    `${path}.periodEndsAt`,
  );
  if (periodStartsAt >= periodEndsAt) {
    invalidResponse(path, "periodStartsAt must precede periodEndsAt");
  }

  return {
    metric: safeCode(required(object, "metric", path), `${path}.metric`),
    unit: safeCode(required(object, "unit", path), `${path}.unit`),
    period: usagePeriod(required(object, "period", path), `${path}.period`),
    periodStartsAt,
    periodEndsAt,
    consumedAmount: decimalAmount(
      required(object, "consumedAmount", path),
      `${path}.consumedAmount`,
    ),
    reservedAmount: decimalAmount(
      required(object, "reservedAmount", path),
      `${path}.reservedAmount`,
    ),
  };
}

function usageSummary(value: unknown, path: string): UsageSummary {
  const object = strictObject(
    value,
    path,
    ["generatedAt", "items", "truncated"],
    invalidResponse,
  );
  const rawItems = required(object, "items", path);
  if (!Array.isArray(rawItems)) {
    return invalidResponse(`${path}.items`, "must be an array");
  }
  if (rawItems.length > MAX_USAGE_ITEMS) {
    return invalidResponse(
      `${path}.items`,
      `must contain at most ${MAX_USAGE_ITEMS} items`,
    );
  }

  return {
    generatedAt: isoTimestamp(
      required(object, "generatedAt", path),
      `${path}.generatedAt`,
    ),
    items: rawItems.map((item, index) => usageItem(item, `${path}.items[${index}]`)),
    truncated: booleanValue(
      required(object, "truncated", path),
      `${path}.truncated`,
    ),
  };
}

export function parseUsageSummaryResponse(
  value: unknown,
): ParsedUsageSummaryResponse {
  const path = "$input";
  const object = strictObject(value, path, ["kind", "usage"], invalidResponse);
  const kind = stringValue(required(object, "kind", path), `${path}.kind`, {
    minLength: 1,
    maxLength: 16,
  });

  if (kind === "not_found") {
    strictObject(value, path, ["kind"], invalidResponse);
    return { kind };
  }
  if (kind !== "ok") return invalidResponse(`${path}.kind`, "must be ok or not_found");

  return {
    kind,
    usage: usageSummary(required(object, "usage", path), `${path}.usage`),
  };
}

export function isUsageMetric(value: string): boolean {
  return SAFE_CODE_PATTERN.test(value);
}

function parsedRequest(request: UsageSummaryRequest): UsageSummaryRequest {
  const path = "$request";
  const object = strictObject(
    request,
    path,
    ["metric", "period"],
    invalidRequest,
  );
  const metric = object.metric;
  const period = object.period;

  if (
    metric !== undefined
    && (typeof metric !== "string" || !SAFE_CODE_PATTERN.test(metric))
  ) {
    invalidRequest(`${path}.metric`, "has an invalid format");
  }
  if (
    period !== undefined
    && (
      typeof period !== "string"
      || !(USAGE_PERIODS as readonly string[]).includes(period)
    )
  ) {
    invalidRequest(`${path}.period`, `must be one of: ${USAGE_PERIODS.join(", ")}`);
  }

  return {
    ...(metric === undefined ? {} : { metric: metric as string }),
    ...(period === undefined ? {} : { period: period as UsagePeriod }),
  };
}

export function usageSummaryPath(request: UsageSummaryRequest = {}): string {
  const parsed = parsedRequest(request);
  const query = new URLSearchParams();
  if (parsed.metric !== undefined) query.set("metric", parsed.metric);
  if (parsed.period !== undefined) query.set("period", parsed.period);
  const serialized = query.toString();
  return serialized.length === 0 ? USAGE_PATH : `${USAGE_PATH}?${serialized}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined"
      && error instanceof DOMException
      && error.name === "AbortError")
    || (
      typeof error === "object"
      && error !== null
      && "name" in error
      && error.name === "AbortError"
    )
  );
}

function usageFailure(error: unknown): UsageAdapterResult {
  if (error instanceof ApiError && error.status === 401) {
    return { kind: "auth-expired" };
  }
  if (error instanceof ApiError && error.status === 404) {
    return { kind: "not-found" };
  }
  if (
    error instanceof InvalidUsageResponseError
    || error instanceof SyntaxError
  ) {
    return {
      kind: "degraded",
      message: "Relay returned an unreadable usage summary. No usage data was shown.",
    };
  }
  if (error instanceof InvalidUsageRequestError) {
    return {
      kind: "degraded",
      message: "Relay could not prepare the usage filters. Review the fields and try again.",
    };
  }
  return {
    kind: "degraded",
    message: error instanceof TypeError
      ? "Relay could not reach the usage service. Check the connection and try again."
      : "Relay could not load the usage summary. No usage data was shown.",
  };
}

export const httpUsageAdapter: UsageAdapter = {
  async getSummary(request = {}, signal) {
    try {
      const response = parseUsageSummaryResponse(
        await fetchJson<unknown>(usageSummaryPath(request), {
          cache: "no-store",
          signal,
        }),
      );
      return response.kind === "not_found" ? { kind: "not-found" } : response;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return usageFailure(error);
    }
  },
};
