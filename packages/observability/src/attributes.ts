import type { Attributes } from "@opentelemetry/api";
import { isNormalizedErrorType } from "./errors.ts";
import {
  httpStatusClass,
  normalizeHttpMethod,
  sanitizeIdentifier,
  sanitizeRouteTemplate,
  sanitizeVersion,
  UNKNOWN_ROUTE,
} from "./redaction.ts";

export const TELEMETRY_ATTRIBUTE_KEYS = [
  "attempt.number",
  "db.system.name",
  "error.type",
  "http.request.method",
  "http.response.status_class",
  "http.route",
  "job.handler",
  "job.state",
  "messaging.system",
  "model",
  "operation",
  "outcome",
  "provider",
  "queue.name",
  "queue.reason",
  "scheduling.class",
  "storage.system",
  "tool.key",
  "tool.version",
] as const;

export type TelemetryAttributeKey = typeof TELEMETRY_ATTRIBUTE_KEYS[number];
export type TelemetryAttributeValue = string | number;
export type TelemetryAttributes = Partial<
  Readonly<Record<TelemetryAttributeKey, TelemetryAttributeValue>>
>;

export const CONTROLLED_TELEMETRY_ATTRIBUTE_KEYS = [
  "http.route",
  "job.handler",
  "model",
  "operation",
  "provider",
  "queue.name",
  "queue.reason",
  "scheduling.class",
  "tool.key",
  "tool.version",
] as const satisfies readonly TelemetryAttributeKey[];

export type ControlledTelemetryAttributeKey =
  typeof CONTROLLED_TELEMETRY_ATTRIBUTE_KEYS[number];

export interface AttributeGuardOptions {
  /** Maximum distinct values admitted per controlled key before its sentinel. */
  readonly maxValuesPerKey?: number;
  /** Optional exact allow-lists for catalog/config-controlled values. */
  readonly allowedValues?: Partial<
    Readonly<Record<ControlledTelemetryAttributeKey, readonly string[]>>
  >;
}

const DEFAULT_MAX_VALUES_PER_KEY = 64;
const OTHER = "other";
const FIXED_OUTCOMES = new Set([
  "accepted",
  "cancelled",
  "deferred",
  "denied",
  "failure",
  "rejected",
  "retry",
  "success",
  "timeout",
]);
const FIXED_JOB_STATES = new Set([
  "active",
  "cancelled",
  "completed",
  "delayed",
  "failed",
  "stalled",
  "waiting",
]);
const FIXED_DATABASE_SYSTEMS = new Set(["postgresql", "redis"]);
const FIXED_MESSAGING_SYSTEMS = new Set(["bullmq"]);
const FIXED_STORAGE_SYSTEMS = new Set(["s3"]);
const STATUS_CLASSES = new Set(["1xx", "2xx", "3xx", "4xx", "5xx", "unknown"]);

const CONTROLLED_KEYS = new Set<ControlledTelemetryAttributeKey>(
  CONTROLLED_TELEMETRY_ATTRIBUTE_KEYS,
);

function isAttributeKey(value: string): value is TelemetryAttributeKey {
  return (TELEMETRY_ATTRIBUTE_KEYS as readonly string[]).includes(value);
}

function isControlledKey(
  value: string,
): value is ControlledTelemetryAttributeKey {
  return (CONTROLLED_TELEMETRY_ATTRIBUTE_KEYS as readonly string[]).includes(
    value,
  );
}

function overflowValue(key: ControlledTelemetryAttributeKey): string {
  return key === "http.route" ? UNKNOWN_ROUTE : OTHER;
}

function normalizeAttribute(
  key: TelemetryAttributeKey,
  value: unknown,
): string | number | null {
  if (value === undefined || value === null) return null;

  switch (key) {
    case "attempt.number":
      return Number.isSafeInteger(value) && Number(value) >= 0 &&
          Number(value) <= 100
        ? Number(value)
        : null;
    case "http.request.method":
      return normalizeHttpMethod(value);
    case "http.response.status_class":
      if (typeof value === "number") return httpStatusClass(value);
      return typeof value === "string" && STATUS_CLASSES.has(value)
        ? value
        : "unknown";
    case "http.route":
      return sanitizeRouteTemplate(value);
    case "error.type":
      return isNormalizedErrorType(value) ? value : null;
    case "outcome":
      return typeof value === "string" && FIXED_OUTCOMES.has(value)
        ? value
        : OTHER;
    case "job.state":
      return typeof value === "string" && FIXED_JOB_STATES.has(value)
        ? value
        : OTHER;
    case "db.system.name":
      return typeof value === "string" && FIXED_DATABASE_SYSTEMS.has(value)
        ? value
        : null;
    case "messaging.system":
      return typeof value === "string" && FIXED_MESSAGING_SYSTEMS.has(value)
        ? value
        : null;
    case "storage.system":
      return typeof value === "string" && FIXED_STORAGE_SYSTEMS.has(value)
        ? value
        : null;
    case "tool.version":
      return sanitizeVersion(value);
    default:
      return sanitizeIdentifier(value, 96);
  }
}

/**
 * Enforces a fixed key set and a hard per-key cardinality ceiling. Unknown keys
 * (including user/job/request IDs, URLs, object keys, and prompts) are dropped.
 */
export class AttributeGuard {
  readonly #maxValuesPerKey: number;
  readonly #allowedValues = new Map<
    TelemetryAttributeKey,
    ReadonlySet<string>
  >();
  readonly #seenValues = new Map<TelemetryAttributeKey, Set<string>>();

  constructor(options: AttributeGuardOptions = {}) {
    const maximum = options.maxValuesPerKey ?? DEFAULT_MAX_VALUES_PER_KEY;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1_024) {
      throw new TypeError(
        "maxValuesPerKey must be an integer between 1 and 1024",
      );
    }
    this.#maxValuesPerKey = maximum;

    for (
      const [rawKey, rawValues] of Object.entries(options.allowedValues ?? {})
    ) {
      if (!isControlledKey(rawKey) || !Array.isArray(rawValues)) {
        throw new TypeError(
          "allowedValues contains an unsupported controlled attribute key",
        );
      }
      const values = new Set<string>();
      for (const rawValue of rawValues) {
        const value = normalizeAttribute(rawKey, rawValue);
        if (
          typeof value !== "string" || value === overflowValue(rawKey)
        ) {
          throw new TypeError(
            `allowedValues contains an invalid ${rawKey} value`,
          );
        }
        values.add(value);
      }
      if (values.size > this.#maxValuesPerKey) {
        throw new TypeError(
          `allowedValues for ${rawKey} exceeds maxValuesPerKey`,
        );
      }
      this.#allowedValues.set(rawKey, values);
    }
  }

  sanitize(
    input: TelemetryAttributes | Record<string, unknown> | undefined,
  ): Attributes {
    if (input === undefined || input === null || typeof input !== "object") {
      return {};
    }

    const output: Attributes = {};
    let entries: [string, unknown][];
    try {
      entries = Object.entries(input);
    } catch {
      return output;
    }

    for (const [rawKey, rawValue] of entries) {
      if (!isAttributeKey(rawKey)) continue;
      const normalized = normalizeAttribute(rawKey, rawValue);
      if (normalized === null) continue;

      if (
        typeof normalized === "string" && isControlledKey(rawKey) &&
        CONTROLLED_KEYS.has(rawKey)
      ) {
        output[rawKey] = this.#admit(rawKey, normalized);
      } else {
        output[rawKey] = normalized;
      }
    }
    return output;
  }

  #admit(key: ControlledTelemetryAttributeKey, value: string): string {
    const overflow = overflowValue(key);
    if (value === overflow) return overflow;

    const allowed = this.#allowedValues.get(key);
    if (allowed !== undefined) return allowed.has(value) ? value : overflow;

    let seen = this.#seenValues.get(key);
    if (seen === undefined) {
      seen = new Set();
      this.#seenValues.set(key, seen);
    }
    if (seen.has(value)) return value;
    if (seen.size >= this.#maxValuesPerKey) return overflow;
    seen.add(value);
    return value;
  }
}
