import { type Context, Hono, type Next } from "@hono/hono";
import type { Auth } from "@relay/auth";
import {
  canonicalCapacityPolicyJson,
  type CapacityPolicy,
  type CapacityPolicyConfiguration,
  type GetCapacityPolicyInput,
  type ListCapacityPoliciesOptions,
  type ReviseCapacityPolicyInput,
  type ReviseCapacityPolicyResult,
} from "@relay/catalog";
import {
  authenticationRequired,
  authorizationDenied,
  errorResponse,
  HttpAdapterError,
  idempotencyConflict,
  invalidRequest,
  notFound,
  reauthenticationRequired,
} from "../http/errors.ts";
import {
  assertNoQuery,
  DEFAULT_MAX_JSON_BODY_BYTES,
  readJsonBody,
} from "../http/request.ts";
import {
  createSessionMiddleware,
  type SessionVariables,
} from "../middleware/session.ts";

export const ADMIN_CAPACITY_POLICIES_PATH =
  "/api/v1/admin/capacity-policies" as const;
export const ADMIN_CAPACITY_POLICY_PATH =
  "/api/v1/admin/capacity-policies/:scopeType/:scopeId" as const;
export const ADMIN_CAPACITY_PATHS = Object.freeze({
  policies: ADMIN_CAPACITY_POLICIES_PATH,
  policy: ADMIN_CAPACITY_POLICY_PATH,
});

export const DEFAULT_MAX_ADMIN_CAPACITY_QUERY_BYTES = 8 * 1024;

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MAX_CONFIGURED_JSON_BODY_BYTES = 16 * 1024 * 1024;
const MAX_CONFIGURED_QUERY_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SCOPE_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const POSITIVE_BIGINT_PATTERN = /^[1-9][0-9]{0,18}$/u;
const PUBLIC_FIELD_PATTERN = /^[A-Za-z0-9_$.[\]-]{1,128}$/u;
const LIST_QUERY_FIELDS = new Set([
  "scopeType",
  "scopeId",
  "includeHistory",
  "effectiveAt",
  "limit",
]);
const GET_QUERY_FIELDS = new Set(["revision", "effectiveAt"]);
const REVISE_BODY_FIELDS = [
  "expectedRevision",
  "configuration",
  "effectiveAt",
  "expiresAt",
] as const;
const POLICY_FIELDS = [
  "policyId",
  "scopeType",
  "scopeId",
  "revision",
  "configuration",
  "canonicalJson",
  "immutableHash",
  "effectiveAt",
  "expiresAt",
] as const;

interface AdminCapacityEnvironment {
  Variables: SessionVariables & {
    requestId: string;
  };
}

export interface AdminCapacitySession {
  /** Better Auth session ID; the service must derive the actor server-side. */
  readonly sessionId: string;
}

export type AdminCapacityReadResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "denied" }
  | { readonly kind: "reauthentication_required" };

export type AdminCapacityGetResult = AdminCapacityReadResult<CapacityPolicy> | {
  readonly kind: "not_found";
};

export type AdminCapacityReviseResult = ReviseCapacityPolicyResult | {
  readonly kind: "reauthentication_required";
  readonly replayed?: false;
} | {
  readonly kind: "idempotency_conflict";
  readonly replayed?: false;
};

/**
 * The implementation owns session resolution and must enforce a fresh, current
 * superadmin grant in the same authoritative boundary as each catalog action.
 */
export interface AdminCapacityService {
  list(
    session: AdminCapacitySession,
    options: ListCapacityPoliciesOptions,
  ): Promise<AdminCapacityReadResult<readonly CapacityPolicy[]>>;
  get(
    session: AdminCapacitySession,
    input: GetCapacityPolicyInput,
  ): Promise<AdminCapacityGetResult>;
  revise(
    session: AdminCapacitySession,
    input: ReviseCapacityPolicyInput,
  ): Promise<AdminCapacityReviseResult>;
}

export interface AdminCapacityRouteDependencies {
  readonly auth: Auth;
  readonly service: AdminCapacityService;
  readonly allowedOrigins: readonly string[];
  readonly maxJsonBodyBytes?: number;
  readonly maxQueryBytes?: number;
  readonly createRequestId?: () => string;
  readonly onUnexpectedError?: (
    error: unknown,
    requestId: string,
    routePath: string,
  ) => void;
}

interface ParsedListQuery {
  readonly scopeType: string | null;
  readonly scopeId: string | null;
  readonly includeHistory: boolean;
  readonly effectiveAt: string | null;
  readonly limit: number;
}

interface ParsedGetQuery {
  readonly revision?: number;
  readonly effectiveAt: string | null;
}

interface ParsedReviseBody {
  readonly expectedRevision: number;
  readonly configuration: CapacityPolicyConfiguration;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
}

type ParsedReviseResult =
  | {
    readonly kind: "revised";
    readonly value: CapacityPolicy;
    readonly replayed: boolean;
  }
  | {
    readonly kind: "revision_conflict";
    readonly actualRevision: number;
  }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "denied" }
  | { readonly kind: "reauthentication_required" };

function configuredLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: "maxJsonBodyBytes" | "maxQueryBytes",
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) || selected < 1 || selected > maximum
  ) {
    throw new TypeError(`${field} must be a positive bounded integer`);
  }
  return selected;
}

function parseHttpOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("origin must be an HTTP(S) origin");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" || parsed.password !== "" ||
    parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
  ) {
    throw new TypeError("origin must be an HTTP(S) origin");
  }
  return parsed.origin;
}

function configuredOrigins(values: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("allowedOrigins are required");
  }
  return new Set(values.map((value) => {
    try {
      return parseHttpOrigin(value);
    } catch {
      throw new TypeError("allowedOrigins must contain HTTP(S) origins");
    }
  }));
}

function requestId(
  context: Context<AdminCapacityEnvironment>,
  factory: (() => string) | undefined,
): string {
  const inherited = context.get("requestId");
  if (typeof inherited === "string" && REQUEST_ID_PATTERN.test(inherited)) {
    return inherited;
  }
  try {
    const candidate = factory?.() ?? `req_${crypto.randomUUID()}`;
    if (REQUEST_ID_PATTERN.test(candidate)) return candidate;
  } catch {
    // Correlation is best effort and must not reject an admin request.
  }
  return `req_${crypto.randomUUID()}`;
}

function prepareResponse(
  context: Context<AdminCapacityEnvironment>,
  factory: (() => string) | undefined,
): string {
  const id = requestId(context, factory);
  context.set("requestId", id);
  context.header("x-request-id", id);
  context.header("cache-control", "no-store");
  context.header("x-content-type-options", "nosniff");
  return id;
}

function traceId(request: Request): string | null {
  const match = TRACEPARENT_PATTERN.exec(
    request.headers.get("traceparent") ?? "",
  );
  if (
    match === null || /^0{32}$/.test(match[1]) || /^0{16}$/.test(match[2])
  ) {
    return null;
  }
  return match[1];
}

function auditContext(
  context: Context<AdminCapacityEnvironment>,
): { readonly requestId: string; readonly traceId: string | null } {
  return {
    requestId: context.get("requestId"),
    traceId: traceId(context.req.raw),
  };
}

function assertTrustedMutationOrigin(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): void {
  if (request.method !== "POST") return;
  const value = request.headers.get("origin");
  if (value === null) throw authorizationDenied();

  let origin: string;
  try {
    origin = parseHttpOrigin(value);
  } catch {
    throw authorizationDenied();
  }
  if (origin !== value || !allowedOrigins.has(origin)) {
    throw authorizationDenied();
  }
}

function requireAdminSession(
  context: Context<AdminCapacityEnvironment>,
): AdminCapacitySession {
  const current = context.get("session");
  const sessionId = current?.session.id;
  if (
    typeof sessionId !== "string" || sessionId.trim() === "" ||
    sessionId.length > 256
  ) {
    throw authenticationRequired();
  }
  return { sessionId };
}

function publicField(value: string): string {
  return PUBLIC_FIELD_PATTERN.test(value) ? value : "$input";
}

function reject(field: string, reason: string): never {
  throw invalidRequest({ field: publicField(field), reason });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function strictInputObject(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(value)) reject("$input", "invalid_type");
  for (const key of Object.keys(value)) {
    if (!allowedFields.includes(key)) reject(key, "unexpected_field");
  }
  for (const key of requiredFields) {
    if (!Object.hasOwn(value, key)) reject(key, "missing_field");
  }
  return value;
}

function requiredScopeType(value: unknown): string {
  if (typeof value !== "string" || !SCOPE_TYPE_PATTERN.test(value)) {
    reject("scopeType", "invalid_value");
  }
  return value;
}

function requiredScopeId(value: unknown): string {
  if (
    typeof value !== "string" || value.trim() === "" || value.length > 256 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint < 0x20 || codePoint === 0x7f;
    })
  ) {
    reject("scopeId", "invalid_value");
  }
  return value;
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < minimum || value > maximum
  ) {
    reject(field, "invalid_value");
  }
  return value;
}

function queryInteger(
  value: string | undefined,
  field: string,
  minimum: number,
  maximum: number,
  fallback?: number,
): number | undefined {
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    reject(field, "invalid_value");
  }
  return integer(Number(value), field, minimum, maximum);
}

function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    reject(field, "invalid_value");
  }
  return value;
}

function queryValues(
  request: Request,
  allowedFields: ReadonlySet<string>,
  maxQueryBytes: number,
): Readonly<Record<string, string>> {
  const search = new URL(request.url).search;
  if (new TextEncoder().encode(search).byteLength > maxQueryBytes) {
    reject("query", "query_too_large");
  }

  const params = new URLSearchParams(search);
  const values: Record<string, string> = Object.create(null);
  const visited = new Set<string>();
  for (const key of params.keys()) {
    if (visited.has(key)) continue;
    visited.add(key);
    if (!allowedFields.has(key)) {
      reject(key, "unsupported_query_parameter");
    }
    const entries = params.getAll(key);
    if (entries.length !== 1) {
      reject(key, "duplicate_query_parameter");
    }
    values[key] = entries[0];
  }
  return values;
}

function parseListQuery(
  request: Request,
  maxQueryBytes: number,
): ParsedListQuery {
  const query = queryValues(request, LIST_QUERY_FIELDS, maxQueryBytes);
  const scopeType = query.scopeType === undefined
    ? null
    : requiredScopeType(query.scopeType);
  const scopeId = query.scopeId === undefined
    ? null
    : requiredScopeId(query.scopeId);
  if (scopeId !== null && scopeType === null) {
    reject("scopeId", "requires_scope_type");
  }
  let includeHistory = false;
  if (query.includeHistory !== undefined) {
    if (query.includeHistory === "true") includeHistory = true;
    else if (query.includeHistory !== "false") {
      reject("includeHistory", "invalid_value");
    }
  }
  const effectiveAt = query.effectiveAt === undefined
    ? null
    : timestamp(query.effectiveAt, "effectiveAt");
  if (includeHistory && effectiveAt !== null) {
    reject("effectiveAt", "incompatible_query_parameters");
  }
  return {
    scopeType,
    scopeId,
    includeHistory,
    effectiveAt,
    limit: queryInteger(query.limit, "limit", 1, 200, 100)!,
  };
}

function parseGetQuery(
  request: Request,
  maxQueryBytes: number,
): ParsedGetQuery {
  const query = queryValues(request, GET_QUERY_FIELDS, maxQueryBytes);
  const revision = queryInteger(
    query.revision,
    "revision",
    1,
    POSTGRES_INTEGER_MAX,
  );
  const effectiveAt = query.effectiveAt === undefined
    ? null
    : timestamp(query.effectiveAt, "effectiveAt");
  if (revision !== undefined && effectiveAt !== null) {
    reject("effectiveAt", "incompatible_query_parameters");
  }
  return {
    ...(revision === undefined ? {} : { revision }),
    effectiveAt,
  };
}

function capacityValidationField(error: unknown): string {
  if (
    typeof error !== "object" || error === null ||
    (error as { name?: unknown }).name !== "CapacityPolicyValidationError"
  ) {
    return "$input";
  }
  const field = (error as { field?: unknown }).field;
  if (typeof field !== "string") return "$input";
  if (field === "configuration" || field.startsWith("configuration.")) {
    return "configuration";
  }
  return [
      "scopeType",
      "scopeId",
      "expectedRevision",
      "effectiveAt",
      "expiresAt",
      "mutationKey",
      "limit",
      "requestId",
      "traceId",
    ].includes(field)
    ? field
    : "$input";
}

function isCapacityValidationError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { name?: unknown }).name === "CapacityPolicyValidationError";
}

function normalizedConfiguration(
  value: unknown,
): CapacityPolicyConfiguration {
  if (!isPlainObject(value)) reject("configuration", "invalid_type");
  try {
    return JSON.parse(
      canonicalCapacityPolicyJson(value),
    ) as CapacityPolicyConfiguration;
  } catch (error) {
    if (isCapacityValidationError(error)) {
      reject(capacityValidationField(error), "invalid_value");
    }
    throw error;
  }
}

function parseReviseBody(value: unknown): ParsedReviseBody {
  const object = strictInputObject(value, REVISE_BODY_FIELDS, [
    "expectedRevision",
    "configuration",
    "effectiveAt",
  ]);
  const effectiveAt = timestamp(object.effectiveAt, "effectiveAt");
  const expiresAt = object.expiresAt === undefined || object.expiresAt === null
    ? null
    : timestamp(object.expiresAt, "expiresAt");
  if (
    expiresAt !== null &&
    new Date(expiresAt).getTime() <= new Date(effectiveAt).getTime()
  ) {
    reject("expiresAt", "must_follow_effective_at");
  }
  return {
    expectedRevision: integer(
      object.expectedRevision,
      "expectedRevision",
      0,
      POSTGRES_INTEGER_MAX - 1,
    ),
    configuration: normalizedConfiguration(object.configuration),
    effectiveAt,
    expiresAt,
  };
}

function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (value === null) reject("idempotency-key", "missing_header");
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    reject("idempotency-key", "invalid_header");
  }
  return value;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function serviceObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(value) || !hasExactKeys(value, keys)) {
    throw new TypeError("admin capacity service returned an invalid result");
  }
  return value;
}

function validScopeType(value: unknown): value is string {
  return typeof value === "string" && SCOPE_TYPE_PATTERN.test(value);
}

function validScopeId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" &&
    value.length <= 256 && ![...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint < 0x20 || codePoint === 0x7f;
    });
}

function validPolicyId(value: unknown): value is string {
  return typeof value === "string" && POSITIVE_BIGINT_PATTERN.test(value) &&
    BigInt(value) <= POSTGRES_BIGINT_MAX;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(new Date(value).getTime());
}

function parsePolicy(value: unknown): CapacityPolicy {
  try {
    const object = serviceObject(value, POLICY_FIELDS);
    if (
      !validPolicyId(object.policyId) || !validScopeType(object.scopeType) ||
      !validScopeId(object.scopeId) ||
      typeof object.revision !== "number" ||
      !Number.isSafeInteger(object.revision) || object.revision < 1 ||
      object.revision > POSTGRES_INTEGER_MAX ||
      typeof object.canonicalJson !== "string" ||
      typeof object.immutableHash !== "string" ||
      !SHA256_PATTERN.test(object.immutableHash) ||
      !validTimestamp(object.effectiveAt) ||
      (object.expiresAt !== null && !validTimestamp(object.expiresAt))
    ) {
      throw new TypeError("invalid policy");
    }
    const canonicalJson = canonicalCapacityPolicyJson(object.configuration);
    if (canonicalJson !== object.canonicalJson) {
      throw new TypeError("invalid canonical configuration");
    }
    const configuration = JSON.parse(
      canonicalJson,
    ) as CapacityPolicyConfiguration;
    if (
      object.expiresAt !== null &&
      new Date(object.expiresAt).getTime() <=
        new Date(object.effectiveAt).getTime()
    ) {
      throw new TypeError("invalid expiry");
    }
    return {
      policyId: object.policyId,
      scopeType: object.scopeType,
      scopeId: object.scopeId,
      revision: object.revision,
      configuration,
      canonicalJson,
      immutableHash: object.immutableHash,
      effectiveAt: object.effectiveAt,
      expiresAt: object.expiresAt,
    };
  } catch {
    throw new TypeError("admin capacity service returned an invalid result");
  }
}

function parseReadFailure(
  object: Record<string, unknown>,
): "denied" | "reauthentication_required" | "not_found" | undefined {
  if (
    object.kind === "denied" || object.kind === "reauthentication_required" ||
    object.kind === "not_found"
  ) {
    if (!hasExactKeys(object, ["kind"])) {
      throw new TypeError("admin capacity service returned an invalid result");
    }
    return object.kind;
  }
  return undefined;
}

function parseListResult(
  value: unknown,
  limit: number,
): AdminCapacityReadResult<readonly CapacityPolicy[]> {
  if (!isPlainObject(value)) {
    throw new TypeError("admin capacity service returned an invalid result");
  }
  const failure = parseReadFailure(value);
  if (failure !== undefined) {
    if (failure === "not_found") {
      throw new TypeError("admin capacity service returned an invalid result");
    }
    return { kind: failure };
  }
  const object = serviceObject(value, ["kind", "value"]);
  if (
    object.kind !== "ok" || !Array.isArray(object.value) ||
    object.value.length > limit
  ) {
    throw new TypeError("admin capacity service returned an invalid result");
  }
  return { kind: "ok", value: object.value.map(parsePolicy) };
}

function parseGetResult(
  value: unknown,
): AdminCapacityGetResult {
  if (!isPlainObject(value)) {
    throw new TypeError("admin capacity service returned an invalid result");
  }
  const failure = parseReadFailure(value);
  if (failure !== undefined) return { kind: failure };
  const object = serviceObject(value, ["kind", "value"]);
  if (object.kind !== "ok") {
    throw new TypeError("admin capacity service returned an invalid result");
  }
  return { kind: "ok", value: parsePolicy(object.value) };
}

function parseMutationAuthorizationFailure(
  object: Record<string, unknown>,
): "denied" | "reauthentication_required" | undefined {
  if (object.kind !== "denied" && object.kind !== "reauthentication_required") {
    return undefined;
  }
  if (
    !hasExactKeys(object, ["kind"]) &&
    !(hasExactKeys(object, ["kind", "replayed"]) &&
      object.replayed === false)
  ) {
    throw new TypeError("admin capacity service returned an invalid result");
  }
  return object.kind;
}

function parseReviseResult(
  value: unknown,
  input: ParsedReviseBody,
  scopeType: string,
  scopeId: string,
): ParsedReviseResult {
  if (!isPlainObject(value)) {
    throw new TypeError("admin capacity service returned an invalid result");
  }
  const authorization = parseMutationAuthorizationFailure(value);
  if (authorization !== undefined) return { kind: authorization };

  switch (value.kind) {
    case "revised": {
      const object = serviceObject(value, ["kind", "value", "replayed"]);
      if (!isBoolean(object.replayed)) {
        throw new TypeError(
          "admin capacity service returned an invalid result",
        );
      }
      const policy = parsePolicy(object.value);
      if (
        policy.scopeType !== scopeType || policy.scopeId !== scopeId ||
        policy.revision !== input.expectedRevision + 1
      ) {
        throw new TypeError(
          "admin capacity service returned an invalid result",
        );
      }
      return { kind: "revised", value: policy, replayed: object.replayed };
    }
    case "revision_conflict": {
      const object = serviceObject(value, [
        "kind",
        "expectedRevision",
        "actualRevision",
        "replayed",
      ]);
      if (
        object.expectedRevision !== input.expectedRevision ||
        typeof object.actualRevision !== "number" ||
        !Number.isSafeInteger(object.actualRevision) ||
        object.actualRevision < 0 ||
        object.actualRevision > POSTGRES_INTEGER_MAX ||
        !isBoolean(object.replayed)
      ) {
        throw new TypeError(
          "admin capacity service returned an invalid result",
        );
      }
      return {
        kind: "revision_conflict",
        actualRevision: object.actualRevision,
      };
    }
    case "mutation_key_conflict":
    case "idempotency_conflict": {
      if (
        !hasExactKeys(value, ["kind"]) &&
        !(hasExactKeys(value, ["kind", "replayed"]) &&
          value.replayed === false)
      ) {
        throw new TypeError(
          "admin capacity service returned an invalid result",
        );
      }
      return { kind: "idempotency_conflict" };
    }
    default:
      throw new TypeError("admin capacity service returned an invalid result");
  }
}

function throwReadFailure(
  kind: "denied" | "reauthentication_required" | "not_found",
): never {
  switch (kind) {
    case "denied":
      throw authorizationDenied();
    case "reauthentication_required":
      throw reauthenticationRequired();
    case "not_found":
      throw notFound();
  }
}

function revisionConflict(actualRevision: number): HttpAdapterError {
  return new HttpAdapterError({
    status: 409,
    code: "invalid_request",
    message: "The request conflicts with the current capacity policy revision.",
    details: { reason: "revision_conflict", actualRevision },
  });
}

function isIdempotencyConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "CapacityPolicyIdempotencyConflictError" ||
    error.name === "GovernanceIdempotencyConflictError";
}

function mapServiceError(error: unknown): unknown {
  if (error instanceof HttpAdapterError) return error;
  if (isCapacityValidationError(error)) {
    return invalidRequest({
      field: capacityValidationField(error),
      reason: "invalid_value",
    });
  }
  if (isIdempotencyConflictError(error)) return idempotencyConflict();
  return error;
}

function createMiddleware(
  dependencies: AdminCapacityRouteDependencies,
): (context: Context<AdminCapacityEnvironment>, next: Next) => Promise<void> {
  return async (context, next) => {
    prepareResponse(context, dependencies.createRequestId);
    await next();
  };
}

function originMiddleware(
  allowedOrigins: ReadonlySet<string>,
): (context: Context<AdminCapacityEnvironment>, next: Next) => Promise<void> {
  return async (context, next) => {
    assertTrustedMutationOrigin(context.req.raw, allowedOrigins);
    await next();
  };
}

function assertService(service: AdminCapacityService): void {
  if (
    service === undefined || service === null ||
    typeof service.list !== "function" || typeof service.get !== "function" ||
    typeof service.revise !== "function"
  ) {
    throw new TypeError("an admin capacity service is required");
  }
}

export function adminCapacityPolicyPath(
  scopeType: string,
  scopeId: string,
): string {
  return `${ADMIN_CAPACITY_POLICIES_PATH}/${encodeURIComponent(scopeType)}/${
    encodeURIComponent(scopeId)
  }`;
}

export function createAdminCapacityRoutes(
  dependencies: AdminCapacityRouteDependencies,
): Hono<AdminCapacityEnvironment> {
  if (dependencies?.auth === undefined) {
    throw new TypeError("auth is required");
  }
  assertService(dependencies.service);
  const allowedOrigins = configuredOrigins(dependencies.allowedOrigins);
  const maxJsonBodyBytes = configuredLimit(
    dependencies.maxJsonBodyBytes,
    DEFAULT_MAX_JSON_BODY_BYTES,
    MAX_CONFIGURED_JSON_BODY_BYTES,
    "maxJsonBodyBytes",
  );
  const maxQueryBytes = configuredLimit(
    dependencies.maxQueryBytes,
    DEFAULT_MAX_ADMIN_CAPACITY_QUERY_BYTES,
    MAX_CONFIGURED_QUERY_BYTES,
    "maxQueryBytes",
  );
  const routes = new Hono<AdminCapacityEnvironment>();
  const prepare = createMiddleware(dependencies);
  const checkOrigin = originMiddleware(allowedOrigins);
  const session = createSessionMiddleware(dependencies.auth);

  routes.use(`${ADMIN_CAPACITY_POLICIES_PATH}/*`, prepare);
  routes.use(`${ADMIN_CAPACITY_POLICIES_PATH}/*`, checkOrigin);
  routes.use(`${ADMIN_CAPACITY_POLICIES_PATH}/*`, session);

  routes.onError((error, context) => {
    const id = prepareResponse(context, dependencies.createRequestId);
    const mapped = mapServiceError(error);
    if (!(mapped instanceof HttpAdapterError)) {
      try {
        dependencies.onUnexpectedError?.(error, id, context.req.routePath);
      } catch {
        // Error reporting is best effort and must not replace the response.
      }
    }
    return errorResponse(context, mapped, id);
  });

  routes.get(ADMIN_CAPACITY_POLICIES_PATH, async (context) => {
    const session = requireAdminSession(context);
    const query = parseListQuery(context.req.raw, maxQueryBytes);
    const result = parseListResult(
      await dependencies.service.list(session, {
        ...query,
        ...auditContext(context),
      }),
      query.limit,
    );
    if (result.kind !== "ok") throwReadFailure(result.kind);
    return context.json({ policies: result.value });
  });

  routes.get(ADMIN_CAPACITY_POLICY_PATH, async (context) => {
    const session = requireAdminSession(context);
    const scopeType = requiredScopeType(context.req.param("scopeType"));
    const scopeId = requiredScopeId(context.req.param("scopeId"));
    const query = parseGetQuery(context.req.raw, maxQueryBytes);
    const result = parseGetResult(
      await dependencies.service.get(session, {
        scopeType,
        scopeId,
        ...query,
        ...auditContext(context),
      }),
    );
    if (result.kind !== "ok") throwReadFailure(result.kind);
    return context.json(result.value);
  });

  routes.post(ADMIN_CAPACITY_POLICY_PATH, async (context) => {
    assertNoQuery(context.req.raw);
    const session = requireAdminSession(context);
    const scopeType = requiredScopeType(context.req.param("scopeType"));
    const scopeId = requiredScopeId(context.req.param("scopeId"));
    const mutationKey = requireIdempotencyKey(context.req.raw);
    const input = parseReviseBody(
      await readJsonBody(context.req.raw, maxJsonBodyBytes),
    );
    const result = parseReviseResult(
      await dependencies.service.revise(session, {
        scopeType,
        scopeId,
        ...input,
        mutationKey,
        ...auditContext(context),
      }),
      input,
      scopeType,
      scopeId,
    );
    switch (result.kind) {
      case "revised":
        return context.json(result);
      case "revision_conflict":
        throw revisionConflict(result.actualRevision);
      case "idempotency_conflict":
        throw idempotencyConflict();
      case "denied":
        throw authorizationDenied();
      case "reauthentication_required":
        throw reauthenticationRequired();
    }
  });

  const adminNotFound = (context: Context<AdminCapacityEnvironment>) =>
    errorResponse(
      context,
      notFound(),
      prepareResponse(context, dependencies.createRequestId),
    );
  routes.all(ADMIN_CAPACITY_POLICIES_PATH, adminNotFound);
  routes.all(`${ADMIN_CAPACITY_POLICIES_PATH}/*`, adminNotFound);

  return routes;
}
