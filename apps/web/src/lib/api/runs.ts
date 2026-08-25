import { ApiError, fetchJson } from "./client";

export const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
] as const;

export const RUN_RESULT_COMPLETENESS = [
  "pending",
  "complete",
  "partial",
  "failed",
] as const;

export type RunStatus = typeof RUN_STATUSES[number];
export type RunResultCompleteness = typeof RUN_RESULT_COMPLETENESS[number];
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface RunToolReference {
  readonly key: string;
  readonly name: string;
  readonly versionId: string;
  readonly version: number;
}

export interface RunSummary {
  readonly id: string;
  readonly tool: RunToolReference;
  readonly status: RunStatus;
  readonly resultCompleteness: RunResultCompleteness | null;
  readonly acceptedAt: string;
  readonly startedAt: string | null;
  readonly terminalAt: string | null;
}

export interface RunOutputItem {
  readonly ordinal: number;
  readonly name: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly artifactId: string | null;
  readonly artifactVersionId: string | null;
  readonly errorCode: string | null;
}

export interface RunOutputSet {
  readonly id: string;
  readonly requestedCount: number;
  readonly producedCount: number;
  readonly completeness: RunResultCompleteness;
  readonly warnings: readonly JsonValue[];
  readonly items: readonly RunOutputItem[];
}

export interface RunReservationSummary {
  readonly id: string;
  readonly metric: string;
  readonly unit: string;
  readonly amount: string;
  readonly status: "active" | "committed" | "released" | "expired";
  readonly expiresAt: string;
}

export interface RunDetail extends RunSummary {
  readonly input: JsonValue;
  readonly outputSet: RunOutputSet | null;
  readonly reservation: RunReservationSummary | null;
}

export interface ListRunsRequest {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly statuses?: readonly RunStatus[];
  readonly toolKey?: string;
  readonly acceptedAfter?: string;
  readonly acceptedBefore?: string;
}

export type ListRunsAdapterResult =
  | {
      readonly kind: "ok";
      readonly items: readonly RunSummary[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "auth-expired" }
  | { readonly kind: "degraded"; readonly message: string };

export type GetRunAdapterResult =
  | { readonly kind: "found"; readonly run: RunDetail }
  | { readonly kind: "not_found" }
  | { readonly kind: "auth-expired" }
  | { readonly kind: "degraded"; readonly message: string };

export type CancelRunAdapterResult =
  | {
      readonly kind: "cancelled" | "cancel_requested" | "already_terminal";
      readonly run: RunDetail;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "auth-expired" }
  | { readonly kind: "degraded"; readonly message: string };

export interface RunsAdapter {
  list(
    request?: ListRunsRequest,
    signal?: AbortSignal,
  ): Promise<ListRunsAdapterResult>;
  get(runId: string, signal?: AbortSignal): Promise<GetRunAdapterResult>;
  cancel(runId: string): Promise<CancelRunAdapterResult>;
}

export class InvalidRunResponseError extends TypeError {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "InvalidRunResponseError";
  }
}

const RUNS_PATH = "/api/v1/runs";
const RUN_ID_PATTERN = /^run_[0-9a-f]{32}$/;
const TOOL_VERSION_ID_PATTERN = /^tver_[0-9a-f]{32}$/;
const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{32}$/;
const ARTIFACT_VERSION_ID_PATTERN = /^aver_[0-9a-f]{32}$/;
const OUTPUT_SET_ID_PATTERN = /^outset_[0-9a-f]{32}$/;
const RESERVATION_ID_PATTERN = /^reservation_[0-9a-f]{32}$/;
const TOOL_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const DECIMAL_AMOUNT_PATTERN = /^(?:0|[1-9][0-9]{0,28})(?:\.[0-9]{1,9})?$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;
const MAX_JSON_BYTES = 256 * 1_024;

function invalid(path: string, message: string): never {
  throw new InvalidRunResponseError(path, message);
}

function strictObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
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
  if (!Object.hasOwn(object, key)) invalid(`${path}.${key}`, "is required");
  return object[key];
}

function stringValue(
  value: unknown,
  path: string,
  options: {
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: RegExp;
    readonly trim?: boolean;
  } = {},
): string {
  if (typeof value !== "string") return invalid(path, "must be a string");
  const parsed = options.trim ? value.trim() : value;
  if (options.minLength !== undefined && parsed.length < options.minLength) {
    invalid(path, "is too short");
  }
  if (options.maxLength !== undefined && parsed.length > options.maxLength) {
    invalid(path, "is too long");
  }
  if (options.pattern !== undefined && !options.pattern.test(parsed)) {
    invalid(path, "has an invalid format");
  }
  return parsed;
}

function integerValue(
  value: unknown,
  path: string,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): number {
  if (!Number.isSafeInteger(value)) return invalid(path, "must be a safe integer");
  const parsed = value as number;
  if (options.minimum !== undefined && parsed < options.minimum) {
    invalid(path, `must be at least ${options.minimum}`);
  }
  if (options.maximum !== undefined && parsed > options.maximum) {
    invalid(path, `must be at most ${options.maximum}`);
  }
  return parsed;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  path: string,
  values: Values,
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    return invalid(path, `must be one of: ${values.join(", ")}`);
  }
  return value as Values[number];
}

function nullable<T>(
  value: unknown,
  path: string,
  parser: (candidate: unknown, candidatePath: string) => T,
): T | null {
  return value === null ? null : parser(value, path);
}

function optional<T>(
  object: Record<string, unknown>,
  key: string,
  path: string,
  parser: (candidate: unknown, candidatePath: string) => T,
): T | undefined {
  return Object.hasOwn(object, key) && object[key] !== undefined
    ? parser(object[key], `${path}.${key}`)
    : undefined;
}

function optionalNullable<T>(
  object: Record<string, unknown>,
  key: string,
  path: string,
  parser: (candidate: unknown, candidatePath: string) => T,
): T | null | undefined {
  if (!Object.hasOwn(object, key) || object[key] === undefined) return undefined;
  return object[key] === null ? null : parser(object[key], `${path}.${key}`);
}

function arrayValue<T>(
  value: unknown,
  path: string,
  parser: (candidate: unknown, candidatePath: string) => T,
  options: { readonly minimum?: number; readonly maximum: number },
): readonly T[] {
  if (!Array.isArray(value)) return invalid(path, "must be an array");
  if (options.minimum !== undefined && value.length < options.minimum) {
    invalid(path, "contains too few items");
  }
  if (value.length > options.maximum) invalid(path, "contains too many items");
  return value.map((item, index) => parser(item, `${path}[${index}]`));
}

function isoTimestamp(value: unknown, path: string): string {
  const parsed = stringValue(value, path, {
    minLength: 24,
    maxLength: 24,
    pattern: ISO_TIMESTAMP_PATTERN,
  });
  if (!Number.isFinite(Date.parse(parsed))) invalid(path, "must be an ISO timestamp");
  return parsed;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

interface JsonTraversalState {
  nodes: number;
  readonly seen: WeakSet<object>;
}

function inspectJson(
  value: unknown,
  path: string,
  depth: number,
  state: JsonTraversalState,
): JsonValue {
  state.nodes += 1;
  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) {
    return invalid(path, "is too complex");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalid(path, "must be finite");
    return value;
  }
  if (typeof value === "string") return value;
  if (typeof value !== "object") return invalid(path, "must be JSON-compatible");
  if (state.seen.has(value)) return invalid(path, "must not contain cycles");
  if (
    !Array.isArray(value)
    && Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null
  ) {
    return invalid(path, "must contain JSON objects");
  }

  state.seen.add(value);
  let parsed: JsonValue;
  if (Array.isArray(value)) {
    parsed = value.map((item, index) => inspectJson(item, `${path}[${index}]`, depth + 1, state));
  } else {
    const object: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, item] of Object.entries(value)) {
      if (key.length === 0 || key.length > 256 || hasControlCharacter(key)) {
        invalid(path, "contains an invalid key");
      }
      object[key] = inspectJson(item, `${path}.${key}`, depth + 1, state);
    }
    parsed = object;
  }
  state.seen.delete(value);
  return parsed;
}

function jsonValue(value: unknown, path: string): JsonValue {
  const parsed = inspectJson(value, path, 0, { nodes: 0, seen: new WeakSet() });
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > MAX_JSON_BYTES) {
    invalid(path, "is too large");
  }
  return parsed;
}

function runToolReference(value: unknown, path: string): RunToolReference {
  const object = strictObject(value, path, ["key", "name", "versionId", "version"]);
  return {
    key: stringValue(required(object, "key", path), `${path}.key`, {
      minLength: 1,
      maxLength: 128,
      pattern: TOOL_KEY_PATTERN,
    }),
    name: stringValue(required(object, "name", path), `${path}.name`, {
      minLength: 1,
      maxLength: 255,
    }),
    versionId: stringValue(required(object, "versionId", path), `${path}.versionId`, {
      pattern: TOOL_VERSION_ID_PATTERN,
    }),
    version: integerValue(required(object, "version", path), `${path}.version`, {
      minimum: 1,
    }),
  };
}

function runSummary(value: unknown, path: string): RunSummary {
  const object = strictObject(value, path, [
    "id",
    "tool",
    "status",
    "resultCompleteness",
    "acceptedAt",
    "startedAt",
    "terminalAt",
  ]);
  return {
    id: stringValue(required(object, "id", path), `${path}.id`, {
      pattern: RUN_ID_PATTERN,
    }),
    tool: runToolReference(required(object, "tool", path), `${path}.tool`),
    status: enumValue(required(object, "status", path), `${path}.status`, RUN_STATUSES),
    resultCompleteness: nullable(
      required(object, "resultCompleteness", path),
      `${path}.resultCompleteness`,
      (item, itemPath) => enumValue(item, itemPath, RUN_RESULT_COMPLETENESS),
    ),
    acceptedAt: isoTimestamp(required(object, "acceptedAt", path), `${path}.acceptedAt`),
    startedAt: nullable(required(object, "startedAt", path), `${path}.startedAt`, isoTimestamp),
    terminalAt: nullable(required(object, "terminalAt", path), `${path}.terminalAt`, isoTimestamp),
  };
}

function outputItem(value: unknown, path: string): RunOutputItem {
  const object = strictObject(value, path, [
    "ordinal",
    "name",
    "status",
    "artifactId",
    "artifactVersionId",
    "errorCode",
  ]);
  const status = enumValue(
    required(object, "status", path),
    `${path}.status`,
    ["pending", "succeeded", "failed"] as const,
  );
  const artifactId = nullable(
    required(object, "artifactId", path),
    `${path}.artifactId`,
    (item, itemPath) => stringValue(item, itemPath, { pattern: ARTIFACT_ID_PATTERN }),
  );
  const artifactVersionId = nullable(
    required(object, "artifactVersionId", path),
    `${path}.artifactVersionId`,
    (item, itemPath) => stringValue(item, itemPath, { pattern: ARTIFACT_VERSION_ID_PATTERN }),
  );
  const errorCode = nullable(
    required(object, "errorCode", path),
    `${path}.errorCode`,
    (item, itemPath) => stringValue(item, itemPath, { pattern: SAFE_CODE_PATTERN }),
  );

  if (
    (status === "succeeded" && (artifactId === null || artifactVersionId === null || errorCode !== null))
    || (status === "failed" && (artifactId !== null || artifactVersionId !== null || errorCode === null))
    || (status === "pending" && (artifactId !== null || artifactVersionId !== null || errorCode !== null))
  ) {
    invalid(path, "output item fields do not match its status");
  }

  return {
    ordinal: integerValue(required(object, "ordinal", path), `${path}.ordinal`, { minimum: 0 }),
    name: stringValue(required(object, "name", path), `${path}.name`, {
      minLength: 1,
      maxLength: 255,
    }),
    status,
    artifactId,
    artifactVersionId,
    errorCode,
  };
}

function outputSet(value: unknown, path: string): RunOutputSet {
  const object = strictObject(value, path, [
    "id",
    "requestedCount",
    "producedCount",
    "completeness",
    "warnings",
    "items",
  ]);
  const requestedCount = integerValue(
    required(object, "requestedCount", path),
    `${path}.requestedCount`,
    { minimum: 1, maximum: 100 },
  );
  return {
    id: stringValue(required(object, "id", path), `${path}.id`, {
      pattern: OUTPUT_SET_ID_PATTERN,
    }),
    requestedCount,
    producedCount: integerValue(
      required(object, "producedCount", path),
      `${path}.producedCount`,
      { minimum: 0, maximum: requestedCount },
    ),
    completeness: enumValue(
      required(object, "completeness", path),
      `${path}.completeness`,
      RUN_RESULT_COMPLETENESS,
    ),
    warnings: arrayValue(
      required(object, "warnings", path),
      `${path}.warnings`,
      jsonValue,
      { maximum: 100 },
    ),
    items: arrayValue(
      required(object, "items", path),
      `${path}.items`,
      outputItem,
      { maximum: 100 },
    ),
  };
}

function reservation(value: unknown, path: string): RunReservationSummary {
  const object = strictObject(value, path, [
    "id",
    "metric",
    "unit",
    "amount",
    "status",
    "expiresAt",
  ]);
  return {
    id: stringValue(required(object, "id", path), `${path}.id`, {
      pattern: RESERVATION_ID_PATTERN,
    }),
    metric: stringValue(required(object, "metric", path), `${path}.metric`, {
      pattern: SAFE_CODE_PATTERN,
    }),
    unit: stringValue(required(object, "unit", path), `${path}.unit`, {
      minLength: 1,
      maxLength: 64,
    }),
    amount: stringValue(required(object, "amount", path), `${path}.amount`, {
      minLength: 1,
      maxLength: 39,
      pattern: DECIMAL_AMOUNT_PATTERN,
    }),
    status: enumValue(
      required(object, "status", path),
      `${path}.status`,
      ["active", "committed", "released", "expired"] as const,
    ),
    expiresAt: isoTimestamp(required(object, "expiresAt", path), `${path}.expiresAt`),
  };
}

function runDetail(value: unknown, path: string): RunDetail {
  const object = strictObject(value, path, [
    "id",
    "tool",
    "status",
    "resultCompleteness",
    "acceptedAt",
    "startedAt",
    "terminalAt",
    "input",
    "outputSet",
    "reservation",
  ]);
  const summary = runSummary({
    id: object.id,
    tool: object.tool,
    status: object.status,
    resultCompleteness: object.resultCompleteness,
    acceptedAt: object.acceptedAt,
    startedAt: object.startedAt,
    terminalAt: object.terminalAt,
  }, path);
  return {
    ...summary,
    input: jsonValue(required(object, "input", path), `${path}.input`),
    outputSet: nullable(required(object, "outputSet", path), `${path}.outputSet`, outputSet),
    reservation: nullable(
      required(object, "reservation", path),
      `${path}.reservation`,
      reservation,
    ),
  };
}

export function parseListRunsResponse(
  value: unknown,
): Extract<ListRunsAdapterResult, { kind: "ok" | "not_found" }> {
  const path = "$input";
  const object = strictObject(value, path, ["kind", "items", "nextCursor"]);
  const kind = enumValue(
    required(object, "kind", path),
    `${path}.kind`,
    ["ok", "not_found"] as const,
  );
  if (kind === "not_found") {
    strictObject(value, path, ["kind"]);
    return { kind };
  }
  return {
    kind,
    items: arrayValue(
      required(object, "items", path),
      `${path}.items`,
      runSummary,
      { maximum: MAX_PAGE_SIZE },
    ),
    nextCursor: nullable(
      required(object, "nextCursor", path),
      `${path}.nextCursor`,
      (item, itemPath) => stringValue(item, itemPath, {
        minLength: 1,
        maxLength: MAX_CURSOR_LENGTH,
        pattern: CURSOR_PATTERN,
      }),
    ),
  };
}

export function parseGetRunResponse(
  value: unknown,
): Extract<GetRunAdapterResult, { kind: "found" | "not_found" }> {
  const path = "$input";
  const object = strictObject(value, path, ["kind", "run"]);
  const kind = enumValue(
    required(object, "kind", path),
    `${path}.kind`,
    ["found", "not_found"] as const,
  );
  if (kind === "not_found") {
    strictObject(value, path, ["kind"]);
    return { kind };
  }
  return { kind, run: runDetail(required(object, "run", path), `${path}.run`) };
}

export function parseCancelRunResponse(
  value: unknown,
): Extract<
  CancelRunAdapterResult,
  { kind: "cancelled" | "cancel_requested" | "already_terminal" | "not_found" }
> {
  const path = "$input";
  const object = strictObject(value, path, ["kind", "run"]);
  const kind = enumValue(
    required(object, "kind", path),
    `${path}.kind`,
    ["cancelled", "cancel_requested", "already_terminal", "not_found"] as const,
  );
  if (kind === "not_found") {
    strictObject(value, path, ["kind"]);
    return { kind };
  }
  const run = runDetail(required(object, "run", path), `${path}.run`);
  const terminal = run.status === "succeeded"
    || run.status === "failed"
    || run.status === "cancelled";
  if (
    (kind === "cancelled" && run.status !== "cancelled")
    || (kind === "cancel_requested" && run.status !== "cancel_requested")
    || (kind === "already_terminal" && !terminal)
  ) {
    invalid(path, "cancellation result does not match the returned run status");
  }
  return { kind, run };
}

export function isRunId(value: string | undefined): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

function parseListRequest(value: ListRunsRequest): ListRunsRequest {
  const path = "$request";
  const object = strictObject(value, path, [
    "cursor",
    "limit",
    "statuses",
    "toolKey",
    "acceptedAfter",
    "acceptedBefore",
  ]);
  const cursor = optionalNullable(object, "cursor", path, (item, itemPath) =>
    stringValue(item, itemPath, {
      minLength: 1,
      maxLength: MAX_CURSOR_LENGTH,
      pattern: CURSOR_PATTERN,
    }));
  const limit = optional(object, "limit", path, (item, itemPath) =>
    integerValue(item, itemPath, { minimum: 1, maximum: MAX_PAGE_SIZE }));
  const statuses = optional(object, "statuses", path, (item, itemPath) => {
    const parsed = arrayValue(
      item,
      itemPath,
      (status, statusPath) => enumValue(status, statusPath, RUN_STATUSES),
      { minimum: 1, maximum: RUN_STATUSES.length },
    );
    if (new Set(parsed).size !== parsed.length) invalid(itemPath, "must not contain duplicates");
    return parsed;
  });
  const toolKey = optional(object, "toolKey", path, (item, itemPath) =>
    stringValue(item, itemPath, {
      minLength: 1,
      maxLength: 128,
      pattern: TOOL_KEY_PATTERN,
    }));
  const acceptedAfter = optional(object, "acceptedAfter", path, isoTimestamp);
  const acceptedBefore = optional(object, "acceptedBefore", path, isoTimestamp);
  if (
    acceptedAfter !== undefined
    && acceptedBefore !== undefined
    && acceptedAfter >= acceptedBefore
  ) {
    invalid(path, "acceptedAfter must precede acceptedBefore");
  }

  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(toolKey === undefined ? {} : { toolKey }),
    ...(acceptedAfter === undefined ? {} : { acceptedAfter }),
    ...(acceptedBefore === undefined ? {} : { acceptedBefore }),
  };
}

function listPath(request: ListRunsRequest): string {
  const parsed = parseListRequest(request);
  const query = new URLSearchParams();
  if (parsed.cursor !== undefined && parsed.cursor !== null) query.set("cursor", parsed.cursor);
  if (parsed.limit !== undefined) query.set("limit", String(parsed.limit));
  if (parsed.statuses !== undefined) {
    for (const status of parsed.statuses) query.append("statuses", status);
  }
  if (parsed.toolKey !== undefined) query.set("toolKey", parsed.toolKey);
  if (parsed.acceptedAfter !== undefined) query.set("acceptedAfter", parsed.acceptedAfter);
  if (parsed.acceptedBefore !== undefined) query.set("acceptedBefore", parsed.acceptedBefore);
  const serialized = query.toString();
  return serialized.length === 0 ? RUNS_PATH : `${RUNS_PATH}?${serialized}`;
}

function runPath(runId: string): string {
  const parsed = stringValue(runId, "$request.runId", { pattern: RUN_ID_PATTERN });
  return `${RUNS_PATH}/${encodeURIComponent(parsed)}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
    || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

export const httpRunsAdapter: RunsAdapter = {
  async list(request = {}, signal) {
    try {
      const response = await fetchJson<unknown>(listPath(request), {
        cache: "no-store",
        signal,
      });
      return parseListRunsResponse(response);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ApiError && error.status === 401) return { kind: "auth-expired" };
      if (error instanceof ApiError && error.status === 404) return { kind: "not_found" };
      if (error instanceof InvalidRunResponseError) {
        return {
          kind: "degraded",
          message: "Relay returned an unreadable run list. No run data was shown.",
        };
      }
      return {
        kind: "degraded",
        message: error instanceof TypeError
          ? "Relay could not reach the run registry. Check the connection and try again."
          : "Relay could not load runs. No run data was changed.",
      };
    }
  },

  async get(runId, signal) {
    try {
      const response = await fetchJson<unknown>(runPath(runId), {
        cache: "no-store",
        signal,
      });
      return parseGetRunResponse(response);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ApiError && error.status === 401) return { kind: "auth-expired" };
      if (error instanceof ApiError && error.status === 404) return { kind: "not_found" };
      if (error instanceof InvalidRunResponseError) {
        return {
          kind: "degraded",
          message: "Relay returned an unreadable run record. No run details were shown.",
        };
      }
      return {
        kind: "degraded",
        message: error instanceof TypeError
          ? "Relay could not reach the run registry. Check the connection and try again."
          : "Relay could not load this run. No run data was changed.",
      };
    }
  },

  async cancel(runId) {
    try {
      const response = await fetchJson<unknown>(`${runPath(runId)}/cancel`, {
        method: "POST",
      });
      return parseCancelRunResponse(response);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return { kind: "auth-expired" };
      if (error instanceof ApiError && error.status === 404) return { kind: "not_found" };
      if (error instanceof InvalidRunResponseError) {
        return {
          kind: "degraded",
          message: "Relay returned an unreadable cancellation result. The request was not repeated.",
        };
      }
      return {
        kind: "degraded",
        message: "Relay could not confirm the cancellation result. The request was not repeated. Refresh the run or try cancellation again.",
      };
    }
  },
};
