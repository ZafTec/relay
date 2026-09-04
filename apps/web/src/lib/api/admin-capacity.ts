import {
  ApiError,
  type ApiJsonObject,
  type ApiJsonValue,
  fetchJson,
  fetchJsonResponse,
} from "./client";

export type CapacityPolicyJsonValue = ApiJsonValue;
export type CapacityPolicyConfiguration = ApiJsonObject;

export interface AdminCapacityPolicy {
  readonly policyId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly revision: number;
  readonly configuration: CapacityPolicyConfiguration;
  readonly canonicalJson: string;
  readonly immutableHash: string;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
}

export type CapacityPolicy = AdminCapacityPolicy;

export interface ListAdminCapacityPoliciesRequest {
  readonly scopeType?: string | null;
  readonly scopeId?: string | null;
  readonly includeHistory?: boolean;
  readonly effectiveAt?: string | null;
  readonly limit?: number;
}

export interface GetAdminCapacityPolicyRequest {
  readonly revision?: number;
  readonly effectiveAt?: string | null;
}

export interface ReviseAdminCapacityPolicyRequest {
  readonly expectedRevision: number;
  readonly configuration: CapacityPolicyConfiguration;
  readonly effectiveAt: string;
  readonly expiresAt?: string | null;
}

export type AdminCapacityAccessFailure =
  | { readonly kind: "auth-expired" }
  | { readonly kind: "reauthentication-required" }
  | { readonly kind: "denied" }
  | { readonly kind: "not-found" };

export interface AdminCapacityDegradedResult {
  readonly kind: "degraded";
  readonly message: string;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number | null;
}

export interface AdminCapacityUnknownOutcomeResult {
  readonly kind: "unknown-outcome";
  readonly message: string;
  readonly retryable: true;
  readonly retryMode: "exact-request";
  readonly retryAfterSeconds: number | null;
}

export type ListAdminCapacityPoliciesResult =
  | { readonly kind: "ok"; readonly policies: readonly AdminCapacityPolicy[] }
  | AdminCapacityAccessFailure
  | AdminCapacityDegradedResult;

export type GetAdminCapacityPolicyResult =
  | { readonly kind: "found"; readonly policy: AdminCapacityPolicy }
  | AdminCapacityAccessFailure
  | AdminCapacityDegradedResult;

export type ReviseAdminCapacityPolicyResult =
  | {
      readonly kind: "revised";
      readonly value: AdminCapacityPolicy;
      readonly replayed: boolean;
    }
  | { readonly kind: "revision-conflict"; readonly actualRevision: number }
  | { readonly kind: "idempotency-conflict" }
  | AdminCapacityAccessFailure
  | AdminCapacityDegradedResult
  | AdminCapacityUnknownOutcomeResult;

export interface AdminCapacityAdapter {
  list(
    request?: ListAdminCapacityPoliciesRequest,
    signal?: AbortSignal,
  ): Promise<ListAdminCapacityPoliciesResult>;
  get(
    scopeType: string,
    scopeId: string,
    request?: GetAdminCapacityPolicyRequest,
    signal?: AbortSignal,
  ): Promise<GetAdminCapacityPolicyResult>;
  revise(
    scopeType: string,
    scopeId: string,
    request: ReviseAdminCapacityPolicyRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ReviseAdminCapacityPolicyResult>;
}

export class InvalidAdminCapacityResponseError extends TypeError {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "InvalidAdminCapacityResponseError";
  }
}

export class InvalidAdminCapacityRequestError extends TypeError {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "InvalidAdminCapacityRequestError";
  }
}

const ADMIN_CAPACITY_POLICIES_PATH = "/api/v1/admin/capacity-policies";
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX = "9223372036854775807";
const SCOPE_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const JSON_LIMITS = {
  maxArrayEntries: 1_024,
  maxCanonicalBytes: 128 * 1_024,
  maxDepth: 16,
  maxKeyCharacters: 256,
  maxNodes: 4_096,
  maxObjectEntries: 256,
  maxStringCharacters: 64 * 1_024,
  maxTotalStringCharacters: 256 * 1_024,
} as const;

type InvalidFactory = (path: string, message: string) => never;

function invalidResponse(path: string, message: string): never {
  throw new InvalidAdminCapacityResponseError(path, message);
}

function invalidRequest(path: string, message: string): never {
  throw new InvalidAdminCapacityRequestError(path, message);
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
  invalid: InvalidFactory,
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
    readonly nonBlank?: boolean;
  },
  invalid: InvalidFactory,
): string {
  if (typeof value !== "string") return invalid(path, "must be a string");
  if (options.minLength !== undefined && value.length < options.minLength) {
    invalid(path, "is too short");
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    invalid(path, "is too long");
  }
  if (options.nonBlank === true && value.trim() === "") {
    invalid(path, "must not be blank");
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    invalid(path, "has an invalid format");
  }
  return value;
}

function integerValue(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  invalid: InvalidFactory,
): number {
  if (!Number.isSafeInteger(value)) return invalid(path, "must be a safe integer");
  const parsed = value as number;
  if (parsed < minimum || parsed > maximum) {
    invalid(path, `must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function booleanValue(value: unknown, path: string, invalid: InvalidFactory): boolean {
  if (typeof value !== "boolean") return invalid(path, "must be a boolean");
  return value;
}

function optional<T>(
  object: Record<string, unknown>,
  key: string,
  path: string,
  parser: (value: unknown, candidatePath: string) => T,
): T | undefined {
  return Object.hasOwn(object, key) && object[key] !== undefined
    ? parser(object[key], `${path}.${key}`)
    : undefined;
}

function optionalNullable<T>(
  object: Record<string, unknown>,
  key: string,
  path: string,
  parser: (value: unknown, candidatePath: string) => T,
): T | null | undefined {
  if (!Object.hasOwn(object, key) || object[key] === undefined) return undefined;
  return object[key] === null ? null : parser(object[key], `${path}.${key}`);
}

function scopeTypeValue(value: unknown, path: string, invalid: InvalidFactory): string {
  return stringValue(
    value,
    path,
    { minLength: 1, maxLength: 64, pattern: SCOPE_TYPE_PATTERN },
    invalid,
  );
}

function scopeIdValue(value: unknown, path: string, invalid: InvalidFactory): string {
  const parsed = stringValue(
    value,
    path,
    { minLength: 1, maxLength: 256, nonBlank: true },
    invalid,
  );
  for (const character of parsed) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      invalid(path, "contains a control character");
    }
  }
  return parsed;
}

function timestampValue(value: unknown, path: string, invalid: InvalidFactory): string {
  const parsed = stringValue(
    value,
    path,
    { minLength: 20, maxLength: 35, pattern: ISO_TIMESTAMP_PATTERN },
    invalid,
  );
  if (!Number.isFinite(new Date(parsed).getTime())) {
    invalid(path, "must be a valid ISO timestamp");
  }
  return parsed;
}

function policyIdValue(value: unknown, path: string, invalid: InvalidFactory): string {
  const parsed = stringValue(value, path, { minLength: 1, maxLength: 19 }, invalid);
  if (
    !/^[1-9][0-9]*$/.test(parsed)
    || parsed.length > POSTGRES_BIGINT_MAX.length
    || (parsed.length === POSTGRES_BIGINT_MAX.length && parsed > POSTGRES_BIGINT_MAX)
  ) {
    invalid(path, "must be a positive PostgreSQL bigint string");
  }
  return parsed;
}

interface JsonState {
  nodes: number;
  stringCharacters: number;
  readonly ancestors: WeakSet<object>;
}

function inspectJson(
  value: unknown,
  path: string,
  depth: number,
  state: JsonState,
  invalid: InvalidFactory,
): ApiJsonValue {
  if (state.nodes >= JSON_LIMITS.maxNodes) invalid(path, "contains too many JSON values");
  state.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalid(path, "must be a finite JSON number");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > JSON_LIMITS.maxStringCharacters) invalid(path, "is too long");
    state.stringCharacters += value.length;
    if (state.stringCharacters > JSON_LIMITS.maxTotalStringCharacters) {
      invalid("$request.configuration", "contains too many string characters");
    }
    return value;
  }
  if (typeof value !== "object") return invalid(path, "must be JSON-compatible");
  if (depth >= JSON_LIMITS.maxDepth) invalid(path, "is nested too deeply");
  if (state.ancestors.has(value)) invalid(path, "must not contain cycles");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > JSON_LIMITS.maxArrayEntries) {
        invalid(path, "contains too many array entries");
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        invalid(path, "must not contain symbol properties");
      }
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        invalid(path, "must be a dense JSON array");
      }
      return value.map((item, index) =>
        inspectJson(item, `${path}[${index}]`, depth + 1, state, invalid));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalid(path, "must contain plain JSON objects only");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      invalid(path, "must not contain symbol properties");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > JSON_LIMITS.maxObjectEntries) {
      invalid(path, "contains too many object fields");
    }
    const result: Record<string, ApiJsonValue> = Object.create(null) as Record<
      string,
      ApiJsonValue
    >;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !("value" in descriptor)
        || key.length > JSON_LIMITS.maxKeyCharacters
      ) {
        invalid(`${path}.${key}`, "must be an enumerable bounded data value");
      }
      result[key] = inspectJson(
        descriptor.value,
        `${path}.${key}`,
        depth + 1,
        state,
        invalid,
      );
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function canonicalJson(value: ApiJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as ApiJsonObject;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

function configurationValue(
  value: unknown,
  path: string,
  invalid: InvalidFactory,
): { readonly value: CapacityPolicyConfiguration; readonly canonical: string } {
  const parsed = inspectJson(
    value,
    path,
    0,
    { nodes: 0, stringCharacters: 0, ancestors: new WeakSet() },
    invalid,
  );
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid(path, "must be a JSON object");
  }
  const canonical = canonicalJson(parsed);
  if (new TextEncoder().encode(canonical).byteLength > JSON_LIMITS.maxCanonicalBytes) {
    invalid(path, "is too large");
  }
  return { value: parsed as CapacityPolicyConfiguration, canonical };
}

function capacityPolicy(
  value: unknown,
  path: string,
): AdminCapacityPolicy {
  const object = strictObject(value, path, [
    "policyId",
    "scopeType",
    "scopeId",
    "revision",
    "configuration",
    "canonicalJson",
    "immutableHash",
    "effectiveAt",
    "expiresAt",
  ], invalidResponse);
  const configuration = configurationValue(
    required(object, "configuration", path, invalidResponse),
    `${path}.configuration`,
    invalidResponse,
  );
  const returnedCanonical = stringValue(
    required(object, "canonicalJson", path, invalidResponse),
    `${path}.canonicalJson`,
    { maxLength: JSON_LIMITS.maxCanonicalBytes },
    invalidResponse,
  );
  if (returnedCanonical !== configuration.canonical) {
    invalidResponse(`${path}.canonicalJson`, "does not match configuration");
  }
  const effectiveAt = timestampValue(
    required(object, "effectiveAt", path, invalidResponse),
    `${path}.effectiveAt`,
    invalidResponse,
  );
  const expiresAt = required(object, "expiresAt", path, invalidResponse) === null
    ? null
    : timestampValue(object.expiresAt, `${path}.expiresAt`, invalidResponse);
  if (
    expiresAt !== null
    && new Date(expiresAt).getTime() <= new Date(effectiveAt).getTime()
  ) {
    invalidResponse(`${path}.expiresAt`, "must follow effectiveAt");
  }
  return {
    policyId: policyIdValue(
      required(object, "policyId", path, invalidResponse),
      `${path}.policyId`,
      invalidResponse,
    ),
    scopeType: scopeTypeValue(
      required(object, "scopeType", path, invalidResponse),
      `${path}.scopeType`,
      invalidResponse,
    ),
    scopeId: scopeIdValue(
      required(object, "scopeId", path, invalidResponse),
      `${path}.scopeId`,
      invalidResponse,
    ),
    revision: integerValue(
      required(object, "revision", path, invalidResponse),
      `${path}.revision`,
      1,
      POSTGRES_INTEGER_MAX,
      invalidResponse,
    ),
    configuration: configuration.value,
    canonicalJson: returnedCanonical,
    immutableHash: stringValue(
      required(object, "immutableHash", path, invalidResponse),
      `${path}.immutableHash`,
      { minLength: 64, maxLength: 64, pattern: SHA256_PATTERN },
      invalidResponse,
    ),
    effectiveAt,
    expiresAt,
  };
}

export function parseAdminCapacityListResponse(
  value: unknown,
  maximum = 200,
): { readonly policies: readonly AdminCapacityPolicy[] } {
  const path = "$input";
  const object = strictObject(value, path, ["policies"], invalidResponse);
  const policies = required(object, "policies", path, invalidResponse);
  if (!Array.isArray(policies)) invalidResponse(`${path}.policies`, "must be an array");
  if (policies.length > maximum) invalidResponse(`${path}.policies`, "contains too many items");
  return {
    policies: policies.map((policy, index) =>
      capacityPolicy(policy, `${path}.policies[${index}]`)),
  };
}

export function parseAdminCapacityPolicyResponse(value: unknown): AdminCapacityPolicy {
  return capacityPolicy(value, "$input");
}

export function parseReviseAdminCapacityResponse(
  value: unknown,
  scopeType: string,
  scopeId: string,
  expectedRevision: number,
): Extract<ReviseAdminCapacityPolicyResult, { readonly kind: "revised" }> {
  const path = "$input";
  const object = strictObject(value, path, ["kind", "value", "replayed"], invalidResponse);
  if (required(object, "kind", path, invalidResponse) !== "revised") {
    invalidResponse(`${path}.kind`, "must be revised");
  }
  const policy = capacityPolicy(
    required(object, "value", path, invalidResponse),
    `${path}.value`,
  );
  if (
    policy.scopeType !== scopeType
    || policy.scopeId !== scopeId
    || policy.revision !== expectedRevision + 1
  ) {
    invalidResponse(`${path}.value`, "does not match the requested revision");
  }
  return {
    kind: "revised",
    value: policy,
    replayed: booleanValue(
      required(object, "replayed", path, invalidResponse),
      `${path}.replayed`,
      invalidResponse,
    ),
  };
}

function parseListRequest(value: unknown): Required<ListAdminCapacityPoliciesRequest> {
  const path = "$request";
  const object = strictObject(
    value,
    path,
    ["scopeType", "scopeId", "includeHistory", "effectiveAt", "limit"],
    invalidRequest,
  );
  const scopeType = optionalNullable(object, "scopeType", path, (item, itemPath) =>
    scopeTypeValue(item, itemPath, invalidRequest)) ?? null;
  const scopeId = optionalNullable(object, "scopeId", path, (item, itemPath) =>
    scopeIdValue(item, itemPath, invalidRequest)) ?? null;
  const includeHistory = optional(object, "includeHistory", path, (item, itemPath) =>
    booleanValue(item, itemPath, invalidRequest)) ?? false;
  const effectiveAt = optionalNullable(object, "effectiveAt", path, (item, itemPath) =>
    timestampValue(item, itemPath, invalidRequest)) ?? null;
  const limit = optional(object, "limit", path, (item, itemPath) =>
    integerValue(item, itemPath, 1, 200, invalidRequest)) ?? 100;
  if (scopeId !== null && scopeType === null) {
    invalidRequest(`${path}.scopeId`, "requires scopeType");
  }
  if (includeHistory && effectiveAt !== null) {
    invalidRequest(`${path}.effectiveAt`, "is incompatible with includeHistory");
  }
  return { scopeType, scopeId, includeHistory, effectiveAt, limit };
}

function parseGetRequest(value: unknown): GetAdminCapacityPolicyRequest {
  const path = "$request";
  const object = strictObject(value, path, ["revision", "effectiveAt"], invalidRequest);
  const revision = optional(object, "revision", path, (item, itemPath) =>
    integerValue(item, itemPath, 1, POSTGRES_INTEGER_MAX, invalidRequest));
  const effectiveAt = optionalNullable(object, "effectiveAt", path, (item, itemPath) =>
    timestampValue(item, itemPath, invalidRequest));
  if (revision !== undefined && effectiveAt != null) {
    invalidRequest(`${path}.effectiveAt`, "is incompatible with revision");
  }
  return {
    ...(revision === undefined ? {} : { revision }),
    ...(effectiveAt === undefined ? {} : { effectiveAt }),
  };
}

function parseReviseRequest(value: unknown): ReviseAdminCapacityPolicyRequest {
  const path = "$request";
  const object = strictObject(
    value,
    path,
    ["expectedRevision", "configuration", "effectiveAt", "expiresAt"],
    invalidRequest,
  );
  const configuration = configurationValue(
    required(object, "configuration", path, invalidRequest),
    `${path}.configuration`,
    invalidRequest,
  ).value;
  const effectiveAt = timestampValue(
    required(object, "effectiveAt", path, invalidRequest),
    `${path}.effectiveAt`,
    invalidRequest,
  );
  const expiresAt = optionalNullable(object, "expiresAt", path, (item, itemPath) =>
    timestampValue(item, itemPath, invalidRequest));
  if (
    expiresAt !== undefined
    && expiresAt !== null
    && new Date(expiresAt).getTime() <= new Date(effectiveAt).getTime()
  ) {
    invalidRequest(`${path}.expiresAt`, "must follow effectiveAt");
  }
  return {
    expectedRevision: integerValue(
      required(object, "expectedRevision", path, invalidRequest),
      `${path}.expectedRevision`,
      0,
      POSTGRES_INTEGER_MAX - 1,
      invalidRequest,
    ),
    configuration,
    effectiveAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function idempotencyKeyValue(value: unknown): string {
  return stringValue(
    value,
    "$request.idempotencyKey",
    { minLength: 16, maxLength: 128, pattern: IDEMPOTENCY_KEY_PATTERN },
    invalidRequest,
  );
}

export function adminCapacityListPath(
  request: ListAdminCapacityPoliciesRequest = {},
): string {
  const parsed = parseListRequest(request);
  const query = new URLSearchParams();
  if (parsed.scopeType !== null) query.set("scopeType", parsed.scopeType);
  if (parsed.scopeId !== null) query.set("scopeId", parsed.scopeId);
  if (parsed.includeHistory) query.set("includeHistory", "true");
  if (parsed.effectiveAt !== null) query.set("effectiveAt", parsed.effectiveAt);
  if (parsed.limit !== 100) query.set("limit", String(parsed.limit));
  const serialized = query.toString();
  return serialized === "" ? ADMIN_CAPACITY_POLICIES_PATH : `${ADMIN_CAPACITY_POLICIES_PATH}?${serialized}`;
}

function policyBasePath(scopeType: string, scopeId: string): string {
  const parsedType = scopeTypeValue(scopeType, "$request.scopeType", invalidRequest);
  const parsedId = scopeIdValue(scopeId, "$request.scopeId", invalidRequest);
  return `${ADMIN_CAPACITY_POLICIES_PATH}/${encodeURIComponent(parsedType)}/${encodeURIComponent(parsedId)}`;
}

export function adminCapacityPolicyPath(
  scopeType: string,
  scopeId: string,
  request: GetAdminCapacityPolicyRequest = {},
): string {
  const base = policyBasePath(scopeType, scopeId);
  const parsed = parseGetRequest(request);
  const query = new URLSearchParams();
  if (parsed.revision !== undefined) query.set("revision", String(parsed.revision));
  if (parsed.effectiveAt != null) query.set("effectiveAt", parsed.effectiveAt);
  const serialized = query.toString();
  return serialized === "" ? base : `${base}?${serialized}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
    || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

function accessFailure(error: ApiError): AdminCapacityAccessFailure | null {
  if (error.status === 401 && error.code === "reauthentication_required") {
    return { kind: "reauthentication-required" };
  }
  if (error.status === 401 && error.code === "authentication_required") {
    return { kind: "auth-expired" };
  }
  if (error.status === 403 && error.code === "authorization_denied") {
    return { kind: "denied" };
  }
  if (error.status === 404 && error.code === "not_found") {
    return { kind: "not-found" };
  }
  return null;
}

function degraded(
  message: string,
  retryable = false,
  retryAfterSeconds: number | null = null,
): AdminCapacityDegradedResult {
  return { kind: "degraded", message, retryable, retryAfterSeconds };
}

function unknownOutcome(
  retryAfterSeconds: number | null = null,
): AdminCapacityUnknownOutcomeResult {
  return {
    kind: "unknown-outcome",
    message: "Relay could not confirm the capacity revision. Retry only the exact request with the same idempotency key after reconciling policy history.",
    retryable: true,
    retryMode: "exact-request",
    retryAfterSeconds,
  };
}

function readFailure(
  error: unknown,
): AdminCapacityAccessFailure | AdminCapacityDegradedResult {
  if (error instanceof ApiError) {
    const access = accessFailure(error);
    if (access !== null) return access;
  }
  if (error instanceof InvalidAdminCapacityResponseError || error instanceof SyntaxError) {
    return degraded("Relay returned an unreadable capacity policy response. No policy data was shown.");
  }
  if (error instanceof InvalidAdminCapacityRequestError) {
    return degraded("Relay could not prepare the capacity policy request. Review the fields and try again.");
  }
  return degraded(
    error instanceof TypeError
      ? "Relay could not reach the capacity policy service. Check the connection and try again."
      : "Relay could not load capacity policies. No policy data was changed.",
  );
}

function revisionConflict(error: ApiError): number | null {
  if (error.status !== 409 || error.code !== "invalid_request" || error.details === null) {
    return null;
  }
  try {
    const path = "$error.details";
    const object = strictObject(
      error.details,
      path,
      ["reason", "actualRevision"],
      invalidResponse,
    );
    if (required(object, "reason", path, invalidResponse) !== "revision_conflict") {
      return null;
    }
    return integerValue(
      required(object, "actualRevision", path, invalidResponse),
      `${path}.actualRevision`,
      0,
      POSTGRES_INTEGER_MAX,
      invalidResponse,
    );
  } catch {
    return null;
  }
}

function mutationFailure(error: ApiError): ReviseAdminCapacityPolicyResult {
  const access = accessFailure(error);
  if (access !== null) return access;
  if (error.status === 409 && error.code === "idempotency_conflict") {
    return { kind: "idempotency-conflict" };
  }
  const actualRevision = revisionConflict(error);
  if (actualRevision !== null) return { kind: "revision-conflict", actualRevision };
  if (error.status >= 500) return unknownOutcome(error.retryAfterSeconds);
  return degraded(
    "Relay rejected the capacity revision. No automatic retry was attempted.",
    error.retryable === true,
    error.retryAfterSeconds,
  );
}

export const httpAdminCapacityAdapter: AdminCapacityAdapter = {
  async list(request = {}, signal) {
    let path: string;
    let limit: number;
    try {
      const parsed = parseListRequest(request);
      path = adminCapacityListPath(parsed);
      limit = parsed.limit;
    } catch (error) {
      return readFailure(error);
    }
    try {
      const response = await fetchJson<unknown>(path, { cache: "no-store", signal });
      return { kind: "ok", ...parseAdminCapacityListResponse(response, limit) };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return readFailure(error);
    }
  },

  async get(scopeType, scopeId, request = {}, signal) {
    let path: string;
    try {
      path = adminCapacityPolicyPath(scopeType, scopeId, request);
    } catch (error) {
      return readFailure(error);
    }
    try {
      return {
        kind: "found",
        policy: parseAdminCapacityPolicyResponse(
          await fetchJson<unknown>(path, { cache: "no-store", signal }),
        ),
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return readFailure(error);
    }
  },

  async revise(scopeType, scopeId, request, idempotencyKey, signal) {
    let path: string;
    let parsedRequest: ReviseAdminCapacityPolicyRequest;
    let parsedKey: string;
    try {
      path = policyBasePath(scopeType, scopeId);
      parsedRequest = parseReviseRequest(request);
      parsedKey = idempotencyKeyValue(idempotencyKey);
    } catch {
      return degraded(
        "Relay could not prepare the capacity revision. Review the fields and reuse a stable idempotency key.",
      );
    }

    try {
      const response = await fetchJsonResponse<unknown>(path, {
        method: "POST",
        cache: "no-store",
        signal,
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": parsedKey,
        },
        body: JSON.stringify(parsedRequest),
      });
      if (response.status !== 200) {
        throw new InvalidAdminCapacityResponseError(
          "$response.status",
          "must be 200 for a revised policy",
        );
      }
      return parseReviseAdminCapacityResponse(
        response.data,
        scopeType,
        scopeId,
        parsedRequest.expectedRevision,
      );
    } catch (error) {
      if (error instanceof ApiError) return mutationFailure(error);
      return unknownOutcome();
    }
  },
};
