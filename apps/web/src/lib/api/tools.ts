import { ApiError, fetchJson } from "./client";

const TOOLS_PATH = "/api/v1/tools";
const TOOL_ID_PATTERN = /^tool_[0-9a-f]{32}$/;
const TOOL_VERSION_ID_PATTERN = /^tver_[0-9a-f]{32}$/;
const TOOL_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOOL_SUMMARY_KEYS = [
  "id",
  "key",
  "name",
  "category",
  "summary",
  "lifecycle",
  "activeVersionId",
  "version",
] as const;
const TOOL_DETAIL_KEYS = [
  ...TOOL_SUMMARY_KEYS,
  "executionMode",
  "maxDurationSeconds",
  "inputSchema",
  "outputSchema",
] as const;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;
const MAX_JSON_BYTES = 256 * 1024;

export type ToolLifecycle = "published" | "deprecated";
export type ToolJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly ToolJsonValue[]
  | { readonly [key: string]: ToolJsonValue };

export interface ToolSummary {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly category: string | null;
  readonly summary: string | null;
  readonly lifecycle: ToolLifecycle;
  readonly activeVersionId: string;
  readonly version: number;
}

export interface ToolDetail extends ToolSummary {
  readonly executionMode: string;
  readonly maxDurationSeconds: number;
  readonly inputSchema: ToolJsonValue;
  readonly outputSchema: ToolJsonValue;
}

export interface ToolCatalogRequest {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly category?: string;
  readonly search?: string;
}

export type ParsedListToolsPayload =
  | {
    readonly kind: "ok";
    readonly items: readonly ToolSummary[];
    readonly nextCursor: string | null;
  }
  | { readonly kind: "not_found" };

export type ParsedGetToolPayload =
  | { readonly kind: "found"; readonly tool: ToolDetail }
  | { readonly kind: "not_found" };

export type ToolCatalogLoadResult =
  | {
    readonly kind: "populated";
    readonly tools: readonly ToolSummary[];
    readonly nextCursor: string | null;
  }
  | { readonly kind: "empty"; readonly nextCursor: string | null }
  | { readonly kind: "not-found" }
  | { readonly kind: "auth-expired" }
  | { readonly kind: "degraded"; readonly message: string };

export type ToolDetailLoadResult =
  | { readonly kind: "found"; readonly tool: ToolDetail }
  | { readonly kind: "not-found" }
  | { readonly kind: "auth-expired" }
  | { readonly kind: "degraded"; readonly message: string };

export interface ToolsCatalogAdapter {
  list(
    request?: ToolCatalogRequest,
    signal?: AbortSignal,
  ): Promise<ToolCatalogLoadResult>;
}

export interface ToolDetailAdapter {
  get(toolKey: string, signal?: AbortSignal): Promise<ToolDetailLoadResult>;
}

export interface ToolsAdapter extends ToolsCatalogAdapter, ToolDetailAdapter {}

export class InvalidToolsResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidToolsResponseError";
  }
}

function invalid(field: string): never {
  throw new InvalidToolsResponseError(`Invalid ${field}`);
}

function strictRecord(
  value: unknown,
  field: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    return invalid(field);
  }

  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid(`${field}.${key}`);
  }
  return record;
}

function required(
  record: Record<string, unknown>,
  key: string,
  field: string,
): unknown {
  if (!Object.hasOwn(record, key)) invalid(`${field}.${key}`);
  return record[key];
}

function requiredString(
  value: unknown,
  field: string,
  options: { readonly maxLength: number; readonly pattern?: RegExp },
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > options.maxLength ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    return invalid(field);
  }
  return value;
}

function nullableString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  return value === null ? null : requiredString(value, field, { maxLength });
}

function positiveInteger(
  value: unknown,
  field: string,
  maximum?: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (maximum !== undefined && value > maximum)
  ) {
    return invalid(field);
  }
  return value;
}

function lifecycle(value: unknown, field: string): ToolLifecycle {
  if (value !== "published" && value !== "deprecated") return invalid(field);
  return value;
}

interface JsonTraversalState {
  nodes: number;
  readonly seen: WeakSet<object>;
}

function jsonValue(
  value: unknown,
  field: string,
  depth: number,
  state: JsonTraversalState,
): ToolJsonValue {
  state.nodes += 1;
  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) {
    return invalid(field);
  }

  if (
    value === null || typeof value === "boolean" || typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalid(field);
    return value;
  }
  if (typeof value !== "object") return invalid(field);
  if (state.seen.has(value)) return invalid(field);
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return invalid(field);
  }

  state.seen.add(value);
  let parsed: ToolJsonValue;
  if (Array.isArray(value)) {
    parsed = value.map((item, index) =>
      jsonValue(item, `${field}[${index}]`, depth + 1, state)
    );
  } else {
    const object: Record<string, ToolJsonValue> = Object.create(null) as Record<
      string,
      ToolJsonValue
    >;
    for (const [key, item] of Object.entries(value)) {
      if (
        key.length === 0 || key.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(key)
      ) {
        return invalid(field);
      }
      object[key] = jsonValue(item, `${field}.${key}`, depth + 1, state);
    }
    parsed = object;
  }
  state.seen.delete(value);
  return parsed;
}

function parsedJsonValue(value: unknown, field: string): ToolJsonValue {
  const parsed = jsonValue(value, field, 0, {
    nodes: 0,
    seen: new WeakSet<object>(),
  });
  if (
    new TextEncoder().encode(JSON.stringify(parsed)).byteLength > MAX_JSON_BYTES
  ) {
    return invalid(field);
  }
  return parsed;
}

function parseToolSummary(value: unknown, field: string): ToolSummary {
  const tool = strictRecord(value, field, TOOL_SUMMARY_KEYS);
  return {
    id: requiredString(required(tool, "id", field), `${field}.id`, {
      maxLength: 37,
      pattern: TOOL_ID_PATTERN,
    }),
    key: requiredString(required(tool, "key", field), `${field}.key`, {
      maxLength: 128,
      pattern: TOOL_KEY_PATTERN,
    }),
    name: requiredString(required(tool, "name", field), `${field}.name`, {
      maxLength: 255,
    }),
    category: nullableString(
      required(tool, "category", field),
      `${field}.category`,
      64,
    ),
    summary: nullableString(
      required(tool, "summary", field),
      `${field}.summary`,
      1_024,
    ),
    lifecycle: lifecycle(
      required(tool, "lifecycle", field),
      `${field}.lifecycle`,
    ),
    activeVersionId: requiredString(
      required(tool, "activeVersionId", field),
      `${field}.activeVersionId`,
      { maxLength: 37, pattern: TOOL_VERSION_ID_PATTERN },
    ),
    version: positiveInteger(
      required(tool, "version", field),
      `${field}.version`,
    ),
  };
}

function parseToolDetail(value: unknown, field: string): ToolDetail {
  const tool = strictRecord(value, field, TOOL_DETAIL_KEYS);
  const summary = parseToolSummary({
    id: required(tool, "id", field),
    key: required(tool, "key", field),
    name: required(tool, "name", field),
    category: required(tool, "category", field),
    summary: required(tool, "summary", field),
    lifecycle: required(tool, "lifecycle", field),
    activeVersionId: required(tool, "activeVersionId", field),
    version: required(tool, "version", field),
  }, field);

  return {
    ...summary,
    executionMode: requiredString(
      required(tool, "executionMode", field),
      `${field}.executionMode`,
      { maxLength: 64 },
    ),
    maxDurationSeconds: positiveInteger(
      required(tool, "maxDurationSeconds", field),
      `${field}.maxDurationSeconds`,
      86_400,
    ),
    inputSchema: parsedJsonValue(
      required(tool, "inputSchema", field),
      `${field}.inputSchema`,
    ),
    outputSchema: parsedJsonValue(
      required(tool, "outputSchema", field),
      `${field}.outputSchema`,
    ),
  };
}

export function parseListToolsPayload(value: unknown): ParsedListToolsPayload {
  const field = "tool catalog response";
  const response = strictRecord(value, field, ["kind", "items", "nextCursor"]);
  const kind = requiredString(
    required(response, "kind", field),
    `${field}.kind`,
    {
      maxLength: 16,
    },
  );

  if (kind === "not_found") {
    strictRecord(value, field, ["kind"]);
    return { kind };
  }
  if (kind !== "ok") return invalid(`${field}.kind`);

  const rawItems = required(response, "items", field);
  if (!Array.isArray(rawItems) || rawItems.length > MAX_PAGE_SIZE) {
    return invalid(`${field}.items`);
  }

  const rawCursor = required(response, "nextCursor", field);
  const nextCursor = rawCursor === null
    ? null
    : requiredString(rawCursor, `${field}.nextCursor`, {
      maxLength: MAX_CURSOR_LENGTH,
      pattern: CURSOR_PATTERN,
    });

  return {
    kind,
    items: rawItems.map((item, index) =>
      parseToolSummary(item, `${field}.items[${index}]`)
    ),
    nextCursor,
  };
}

export function parseGetToolPayload(value: unknown): ParsedGetToolPayload {
  const field = "tool detail response";
  const response = strictRecord(value, field, ["kind", "tool"]);
  const kind = requiredString(
    required(response, "kind", field),
    `${field}.kind`,
    {
      maxLength: 16,
    },
  );

  if (kind === "not_found") {
    strictRecord(value, field, ["kind"]);
    return { kind };
  }
  if (kind !== "found") return invalid(`${field}.kind`);

  return {
    kind,
    tool: parseToolDetail(required(response, "tool", field), `${field}.tool`),
  };
}

function optionalRequestString(
  value: string | undefined,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return requiredString(trimmed, field, { maxLength });
}

function catalogPath(request: ToolCatalogRequest): string {
  const params = new URLSearchParams();
  if (request.cursor !== undefined && request.cursor !== null) {
    params.set(
      "cursor",
      requiredString(request.cursor, "catalog request.cursor", {
        maxLength: MAX_CURSOR_LENGTH,
        pattern: CURSOR_PATTERN,
      }),
    );
  }
  if (request.limit !== undefined) {
    params.set(
      "limit",
      String(
        positiveInteger(request.limit, "catalog request.limit", MAX_PAGE_SIZE),
      ),
    );
  }
  const category = optionalRequestString(
    request.category,
    "catalog request.category",
    64,
  );
  const search = optionalRequestString(
    request.search,
    "catalog request.search",
    100,
  );
  if (category !== undefined) params.set("category", category);
  if (search !== undefined) params.set("search", search);
  const query = params.toString();
  return query.length === 0 ? TOOLS_PATH : `${TOOLS_PATH}?${query}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException &&
      error.name === "AbortError") ||
    (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError"
    )
  );
}

function catalogFailure(error: unknown): ToolCatalogLoadResult {
  if (error instanceof ApiError && error.status === 401) {
    return { kind: "auth-expired" };
  }
  if (error instanceof ApiError && error.status === 404) {
    return { kind: "not-found" };
  }
  if (error instanceof InvalidToolsResponseError) {
    return {
      kind: "degraded",
      message:
        "Relay returned an unreadable tool catalog. No tool data was shown.",
    };
  }
  return {
    kind: "degraded",
    message: error instanceof TypeError
      ? "Relay could not reach the tool catalog. Check the connection and try again."
      : "Relay could not load the tool catalog. No tool data was shown.",
  };
}

function detailFailure(error: unknown): ToolDetailLoadResult {
  if (error instanceof ApiError && error.status === 401) {
    return { kind: "auth-expired" };
  }
  if (error instanceof ApiError && error.status === 404) {
    return { kind: "not-found" };
  }
  if (error instanceof InvalidToolsResponseError) {
    return {
      kind: "degraded",
      message:
        "Couldn’t read this tool’s details. Please try again.",
    };
  }
  return {
    kind: "degraded",
    message: error instanceof TypeError
      ? "Relay could not reach the tool catalog. Check the connection and try again."
      : "Couldn’t load this tool’s details. Please try again.",
  };
}

export const httpToolsCatalogAdapter: ToolsCatalogAdapter = {
  async list(request = {}, signal) {
    try {
      const payload = parseListToolsPayload(
        await fetchJson<unknown>(catalogPath(request), { signal }),
      );
      if (payload.kind === "not_found") return { kind: "not-found" };
      return payload.items.length === 0
        ? { kind: "empty", nextCursor: payload.nextCursor }
        : {
          kind: "populated",
          tools: payload.items,
          nextCursor: payload.nextCursor,
        };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return catalogFailure(error);
    }
  },
};

export const httpToolDetailAdapter: ToolDetailAdapter = {
  async get(toolKey, signal) {
    if (toolKey.length > 128 || !TOOL_KEY_PATTERN.test(toolKey)) {
      return { kind: "not-found" };
    }

    try {
      const payload = parseGetToolPayload(
        await fetchJson<unknown>(
          `${TOOLS_PATH}/${encodeURIComponent(toolKey)}`,
          { signal },
        ),
      );
      if (payload.kind === "not_found") return { kind: "not-found" };
      if (payload.tool.key !== toolKey) {
        return {
          kind: "degraded",
          message:
            "The requested tool’s details are unavailable. Please try again.",
        };
      }
      return payload;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return detailFailure(error);
    }
  },
};

export const httpToolsAdapter: ToolsAdapter = {
  list: httpToolsCatalogAdapter.list,
  get: httpToolDetailAdapter.get,
};
