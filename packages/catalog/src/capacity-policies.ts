import { recordAuditEvent } from "@relay/audit";
import { type DatabasePool, withTransaction } from "@relay/database";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const CAPACITY_POLICY_REVISE_OPERATION = "capacity_policy.revise";
const MUTATION_KEY_HASH_DOMAIN = "relay-governance-idempotency:v1";
const MUTATION_REQUEST_FINGERPRINT_DOMAIN =
  "relay-capacity-policy-revise-request:v1";
const SCOPE_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MUTATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

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

export type CapacityPolicyJsonPrimitive = string | number | boolean | null;
export type CapacityPolicyJsonValue =
  | CapacityPolicyJsonPrimitive
  | CapacityPolicyJsonObject
  | readonly CapacityPolicyJsonValue[];

export interface CapacityPolicyJsonObject {
  readonly [key: string]: CapacityPolicyJsonValue | undefined;
}

/**
 * Optional well-known capacity defaults. Other configuration fields remain
 * available through CapacityPolicyConfiguration's JSON object index signature.
 */
export interface CapacitySubmissionRateDefaults
  extends CapacityPolicyJsonObject {
  readonly providerPerMinute?: number;
  readonly toolPerMinute?: number;
}

export interface CapacityPolicyConfiguration extends CapacityPolicyJsonObject {
  readonly submissionRateDefaults?: CapacitySubmissionRateDefaults;
}

export interface CapacityPolicyScope {
  readonly scopeType: string;
  readonly scopeId: string;
}

/**
 * Session-backed authorization for an HTTP administration boundary. The
 * database derives the actor and verifies session freshness/current role in
 * the same transaction as the capacity-policy operation.
 */
export interface CapacityPolicySessionAuthorization {
  readonly sessionId: string;
}

export type CapacityPolicyAuthorization =
  | string
  | CapacityPolicySessionAuthorization;

export interface CapacityPolicy extends CapacityPolicyScope {
  readonly policyId: string;
  readonly revision: number;
  readonly configuration: CapacityPolicyConfiguration;
  /** Canonical JSON for configuration, independent of object insertion order. */
  readonly canonicalJson: string;
  /** SHA-256 over the complete immutable revision envelope. */
  readonly immutableHash: string;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
}

export interface CapacityPolicyAuditContext {
  readonly requestId?: string | null;
  readonly traceId?: string | null;
}

export interface ListCapacityPoliciesOptions
  extends CapacityPolicyAuditContext {
  readonly scopeType?: string | null;
  readonly scopeId?: string | null;
  /** Defaults to false, returning one currently effective revision per scope. */
  readonly includeHistory?: boolean;
  /** Database time is used when omitted. */
  readonly effectiveAt?: string | Date | null;
  readonly limit?: number;
}

export interface GetCapacityPolicyInput
  extends CapacityPolicyScope, CapacityPolicyAuditContext {
  /** Select an exact historical revision instead of the current revision. */
  readonly revision?: number;
  /** Database time is used when omitted. Invalid together with revision. */
  readonly effectiveAt?: string | Date | null;
}

export interface ReviseCapacityPolicyInput
  extends CapacityPolicyScope, CapacityPolicyAuditContext {
  /** Zero creates the first revision; otherwise this must equal latest. */
  readonly expectedRevision: number;
  readonly configuration: CapacityPolicyConfiguration;
  readonly effectiveAt: string | Date;
  readonly expiresAt?: string | Date | null;
  /** Raw caller key; only a one-way hash is persisted. */
  readonly mutationKey?: string | null;
}

export type CapacityPolicyReadResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "denied" };

export type GetCapacityPolicyResult =
  | CapacityPolicyReadResult<CapacityPolicy>
  | { readonly kind: "not_found" };

export type ReviseCapacityPolicyResult =
  | {
    readonly kind: "revised";
    readonly value: CapacityPolicy;
    readonly replayed: boolean;
  }
  | {
    readonly kind: "revision_conflict";
    readonly expectedRevision: number;
    readonly actualRevision: number;
    readonly replayed: boolean;
  }
  | { readonly kind: "mutation_key_conflict"; readonly replayed: false }
  | { readonly kind: "denied"; readonly replayed: false };

export class CapacityPolicyValidationError extends TypeError {
  override readonly name = "CapacityPolicyValidationError";

  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field} ${message}`);
  }
}

export class CapacityPolicyIntegrityError extends Error {
  override readonly name = "CapacityPolicyIntegrityError";

  constructor(readonly policyId: string) {
    super(
      `Capacity policy ${policyId} does not match its immutable audit hash`,
    );
  }
}

export class CapacityPolicyIdempotencyInvariantError extends Error {
  override readonly name = "CapacityPolicyIdempotencyInvariantError";
}

interface JsonState {
  nodes: number;
  stringCharacters: number;
  readonly ancestors: WeakSet<object>;
}

interface NormalizedConfiguration {
  readonly value: CapacityPolicyConfiguration;
  readonly canonicalJson: string;
}

interface NormalizedAuditContext {
  readonly requestId: string | null;
  readonly traceId: string | null;
}

interface CapacityPolicyRow extends Record<string, unknown> {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly revision: number;
  readonly configuration: unknown;
  readonly effective_at: Date | string;
  readonly expires_at: Date | string | null;
  readonly recorded_immutable_hash?: string | null;
}

type NormalizedCapacityPolicyAuthorization =
  | { readonly kind: "actor"; readonly actorUserId: string }
  | { readonly kind: "session"; readonly sessionId: string };

interface NormalizedRevisionInput {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly expectedRevision: number;
  readonly configuration: CapacityPolicyConfiguration;
  readonly canonicalJson: string;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly mutationKey: string | null;
  readonly audit: NormalizedAuditContext;
}

interface CapacityPolicyMutationArtifacts {
  readonly keyHash: string;
  readonly requestFingerprint: string;
}

interface GovernanceIdempotencyRow extends Record<string, unknown> {
  readonly request_fingerprint: string;
  readonly response: unknown;
}

type StoredCapacityPolicyMutationResponse =
  | {
    readonly kind: "revised";
    readonly policyId: string;
    readonly revision: number;
  }
  | {
    readonly kind: "revision_conflict";
    readonly expectedRevision: number;
    readonly actualRevision: number;
  };

function validationError(
  field: string,
  message: string,
): CapacityPolicyValidationError {
  return new CapacityPolicyValidationError(field, message);
}

function canonicalizeJson(
  value: unknown,
  path: string,
  depth: number,
  state: JsonState,
): string {
  if (state.nodes >= JSON_LIMITS.maxNodes) {
    throw validationError("configuration", "contains too many JSON values");
  }
  state.nodes += 1;

  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (value.length > JSON_LIMITS.maxStringCharacters) {
      throw validationError(path, "is too long");
    }
    state.stringCharacters += value.length;
    if (state.stringCharacters > JSON_LIMITS.maxTotalStringCharacters) {
      throw validationError(
        "configuration",
        "contains too many string characters",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw validationError(path, "must be a finite JSON number");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw validationError(path, `contains unsupported ${typeof value} value`);
  }
  if (depth >= JSON_LIMITS.maxDepth) {
    throw validationError("configuration", "is nested too deeply");
  }
  if (state.ancestors.has(value)) {
    throw validationError("configuration", "must not contain cycles");
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > JSON_LIMITS.maxArrayEntries) {
        throw validationError(path, "contains too many array entries");
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw validationError(path, "must not contain symbol properties");
      }
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw validationError(path, "must be a dense JSON array");
      }
      const entries = Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (descriptor === undefined || !("value" in descriptor)) {
          throw validationError(`${path}[${index}]`, "must be a data value");
        }
        return canonicalizeJson(
          descriptor.value,
          `${path}[${index}]`,
          depth + 1,
          state,
        );
      });
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw validationError(path, "must contain plain JSON objects only");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw validationError(path, "must not contain symbol properties");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > JSON_LIMITS.maxObjectEntries) {
      throw validationError(path, "contains too many object fields");
    }
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw validationError(
          `${path}.${key}`,
          "must be an enumerable data value",
        );
      }
      if (key.length > JSON_LIMITS.maxKeyCharacters) {
        throw validationError(`${path}.${key}`, "has an overlong field name");
      }
    }
    keys.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const entries = keys.map((key) => {
      const item = descriptors[key].value;
      if (item === undefined) {
        throw validationError(`${path}.${key}`, "must not be undefined");
      }
      return `${JSON.stringify(key)}:${
        canonicalizeJson(item, `${path}.${key}`, depth + 1, state)
      }`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    state.ancestors.delete(value);
  }
}

/** Validates and canonicalizes bounded JSON without invoking toJSON/getters. */
export function canonicalCapacityPolicyJson(value: unknown): string {
  const canonical = canonicalizeJson(value, "configuration", 0, {
    nodes: 0,
    stringCharacters: 0,
    ancestors: new WeakSet(),
  });
  if (
    new TextEncoder().encode(canonical).byteLength >
      JSON_LIMITS.maxCanonicalBytes
  ) {
    throw validationError("configuration", "is too large");
  }
  return canonical;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateRateDefault(value: unknown, field: string): void {
  if (
    !Number.isSafeInteger(value) || (value as number) <= 0 ||
    (value as number) > POSTGRES_INTEGER_MAX
  ) {
    throw validationError(
      field,
      `must be an integer from 1 through ${POSTGRES_INTEGER_MAX}`,
    );
  }
}

function normalizeConfiguration(value: unknown): NormalizedConfiguration {
  if (!isJsonObject(value)) {
    throw validationError("configuration", "must be a JSON object");
  }
  const canonicalJson = canonicalCapacityPolicyJson(value);
  const normalized = JSON.parse(canonicalJson) as CapacityPolicyConfiguration;
  const defaults = normalized.submissionRateDefaults;
  if (defaults !== undefined) {
    if (!isJsonObject(defaults)) {
      throw validationError(
        "configuration.submissionRateDefaults",
        "must be an object",
      );
    }
    const provider = defaults.providerPerMinute;
    const tool = defaults.toolPerMinute;
    if (provider === undefined && tool === undefined) {
      throw validationError(
        "configuration.submissionRateDefaults",
        "must define providerPerMinute or toolPerMinute",
      );
    }
    if (provider !== undefined) {
      validateRateDefault(
        provider,
        "configuration.submissionRateDefaults.providerPerMinute",
      );
    }
    if (tool !== undefined) {
      validateRateDefault(
        tool,
        "configuration.submissionRateDefaults.toolPerMinute",
      );
    }
  }
  return { value: normalized, canonicalJson };
}

function requiredText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw validationError(field, "must not be empty");
  }
  if (value.length > maxLength) {
    throw validationError(field, `must be at most ${maxLength} characters`);
  }
  return value;
}

function normalizeScope(scope: CapacityPolicyScope): CapacityPolicyScope {
  const scopeType = requiredText(scope.scopeType, "scopeType", 64);
  if (!SCOPE_TYPE_PATTERN.test(scopeType)) {
    throw validationError(
      "scopeType",
      "must start with a lowercase letter and contain lowercase letters, digits, dot, underscore, or hyphen",
    );
  }
  const scopeId = requiredText(scope.scopeId, "scopeId", 256);
  if (
    [...scopeId].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint < 0x20 || codePoint === 0x7f;
    })
  ) {
    throw validationError("scopeId", "must not contain control characters");
  }
  return { scopeType, scopeId };
}

function normalizeCorrelationId(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (!CORRELATION_ID_PATTERN.test(value)) {
    throw validationError(
      field,
      "must contain 1-256 letters, digits, dot, underscore, colon, or hyphen",
    );
  }
  return value;
}

function normalizeAuditContext(
  context: CapacityPolicyAuditContext,
): NormalizedAuditContext {
  return {
    requestId: normalizeCorrelationId(context.requestId, "requestId"),
    traceId: normalizeCorrelationId(context.traceId, "traceId"),
  };
}

function normalizeTimestamp(
  value: string | Date,
  field: string,
): string {
  if (typeof value === "string" && !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw validationError(
      field,
      "must be an ISO 8601 timestamp with a timezone",
    );
  }
  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw validationError(field, "must be a valid timestamp");
  }
  return parsed.toISOString();
}

function optionalTimestamp(
  value: string | Date | null | undefined,
  field: string,
): string | null {
  return value === undefined || value === null
    ? null
    : normalizeTimestamp(value, field);
}

function normalizeExpectedRevision(value: number): number {
  if (
    !Number.isSafeInteger(value) || value < 0 ||
    value >= POSTGRES_INTEGER_MAX
  ) {
    throw validationError(
      "expectedRevision",
      `must be an integer from 0 through ${POSTGRES_INTEGER_MAX - 1}`,
    );
  }
  return value;
}

function normalizeRevision(value: number, field = "revision"): number {
  if (
    !Number.isSafeInteger(value) || value <= 0 ||
    value > POSTGRES_INTEGER_MAX
  ) {
    throw validationError(
      field,
      `must be an integer from 1 through ${POSTGRES_INTEGER_MAX}`,
    );
  }
  return value;
}

function normalizeMutationKey(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!MUTATION_KEY_PATTERN.test(value)) {
    throw validationError(
      "mutationKey",
      "must be 16-128 URL-safe characters",
    );
  }
  return value;
}

function normalizeActorUserId(value: string): string {
  return requiredText(value, "actorUserId", 256);
}

function normalizeAuthorization(
  value: CapacityPolicyAuthorization,
): NormalizedCapacityPolicyAuthorization {
  if (typeof value === "string") {
    return { kind: "actor", actorUserId: normalizeActorUserId(value) };
  }
  if (
    typeof value !== "object" || value === null ||
    !Object.hasOwn(value, "sessionId")
  ) {
    throw validationError(
      "authorization",
      "must provide an actor user ID or session ID",
    );
  }
  return {
    kind: "session",
    sessionId: requiredText(value.sessionId, "sessionId", 256),
  };
}

function normalizeRevisionInput(
  input: ReviseCapacityPolicyInput,
): NormalizedRevisionInput {
  const scope = normalizeScope(input);
  const configuration = normalizeConfiguration(input.configuration);
  const effectiveAt = normalizeTimestamp(input.effectiveAt, "effectiveAt");
  const expiresAt = optionalTimestamp(input.expiresAt, "expiresAt");
  if (
    expiresAt !== null &&
    new Date(expiresAt).getTime() <= new Date(effectiveAt).getTime()
  ) {
    throw validationError("expiresAt", "must be later than effectiveAt");
  }
  return {
    ...scope,
    expectedRevision: normalizeExpectedRevision(input.expectedRevision),
    configuration: configuration.value,
    canonicalJson: configuration.canonicalJson,
    effectiveAt,
    expiresAt,
    mutationKey: normalizeMutationKey(input.mutationKey),
    audit: normalizeAuditContext(input),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function createCapacityPolicyMutationArtifacts(
  actorUserId: string,
  input: NormalizedRevisionInput,
): Promise<CapacityPolicyMutationArtifacts | null> {
  if (input.mutationKey === null) return null;
  const keyHash = await sha256Hex(
    `${MUTATION_KEY_HASH_DOMAIN}\0${input.mutationKey}`,
  );
  const requestFingerprint = await sha256Hex(
    `${MUTATION_REQUEST_FINGERPRINT_DOMAIN}\0${
      canonicalCapacityPolicyJson({
        actorUserId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        expectedRevision: input.expectedRevision,
        configuration: input.configuration,
        effectiveAt: input.effectiveAt,
        expiresAt: input.expiresAt,
      })
    }`,
  );
  return { keyHash, requestFingerprint };
}

function idempotencyInvariant(message: string): never {
  throw new CapacityPolicyIdempotencyInvariantError(message);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function storedNonNegativeRevision(value: unknown, field: string): number {
  if (
    !Number.isSafeInteger(value) || (value as number) < 0 ||
    (value as number) > POSTGRES_INTEGER_MAX
  ) {
    return idempotencyInvariant(`Stored ${field} is invalid`);
  }
  return value as number;
}

function storedPolicyId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    return idempotencyInvariant("Stored policyId is invalid");
  }
  const postgresBigintMax = "9223372036854775807";
  if (
    value.length > postgresBigintMax.length ||
    (value.length === postgresBigintMax.length && value > postgresBigintMax)
  ) {
    return idempotencyInvariant("Stored policyId is invalid");
  }
  return value;
}

function parseStoredMutationResponse(
  value: unknown,
): StoredCapacityPolicyMutationResponse {
  if (!isJsonObject(value) || typeof value.kind !== "string") {
    return idempotencyInvariant("Stored capacity policy response is invalid");
  }
  if (value.kind === "revised") {
    if (!hasExactKeys(value, ["kind", "policyId", "revision"])) {
      return idempotencyInvariant("Stored revised response has unsafe fields");
    }
    return {
      kind: "revised",
      policyId: storedPolicyId(value.policyId),
      revision: storedNonNegativeRevision(value.revision, "revision"),
    };
  }
  if (value.kind === "revision_conflict") {
    if (
      !hasExactKeys(value, [
        "kind",
        "expectedRevision",
        "actualRevision",
      ])
    ) {
      return idempotencyInvariant(
        "Stored revision conflict response has unsafe fields",
      );
    }
    return {
      kind: "revision_conflict",
      expectedRevision: storedNonNegativeRevision(
        value.expectedRevision,
        "expectedRevision",
      ),
      actualRevision: storedNonNegativeRevision(
        value.actualRevision,
        "actualRevision",
      ),
    };
  }
  return idempotencyInvariant(
    "Stored capacity policy response kind is invalid",
  );
}

async function immutableHashFor(
  policy: Omit<CapacityPolicy, "immutableHash">,
): Promise<string> {
  return await sha256Hex(
    `relay-capacity-policy:v1\0${
      canonicalCapacityPolicyJson({
        policyId: policy.policyId,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        revision: policy.revision,
        configuration: policy.configuration,
        effectiveAt: policy.effectiveAt,
        expiresAt: policy.expiresAt,
      })
    }`,
  );
}

function databaseTimestamp(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Database returned an invalid ${field}`);
  }
  return parsed.toISOString();
}

async function mapPolicy(row: CapacityPolicyRow): Promise<CapacityPolicy> {
  const configuration = normalizeConfiguration(row.configuration);
  const policyWithoutHash: Omit<CapacityPolicy, "immutableHash"> = {
    policyId: String(row.id),
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    revision: normalizeRevision(row.revision),
    configuration: configuration.value,
    canonicalJson: configuration.canonicalJson,
    effectiveAt: databaseTimestamp(row.effective_at, "effective_at"),
    expiresAt: row.expires_at === null
      ? null
      : databaseTimestamp(row.expires_at, "expires_at"),
  };
  const immutableHash = await immutableHashFor(policyWithoutHash);
  const recordedHash = row.recorded_immutable_hash;
  if (
    recordedHash !== undefined && recordedHash !== null &&
    (!SHA256_PATTERN.test(recordedHash) || recordedHash !== immutableHash)
  ) {
    throw new CapacityPolicyIntegrityError(policyWithoutHash.policyId);
  }
  return { ...policyWithoutHash, immutableHash };
}

async function hasCurrentSuperadminAuthorization(
  queryable: Pick<DatabasePool, "query">,
  actorUserId: string,
): Promise<boolean> {
  // Grant/revoke uses the exclusive form of this same transaction lock. A
  // shared lock lets reads proceed together while preventing authorization
  // from changing between this check and the operation's audit record.
  await queryable.query(
    `select pg_catalog.pg_advisory_xact_lock_shared(
       pg_catalog.hashtextextended('relay.system-role:mutations', 0)
     )`,
  );
  const result = await queryable.query(
    `select 1
       from relay.system_role_assignments
      where user_id = $1 and revoked_at is null
      limit 1`,
    [actorUserId],
  );
  return result.rows.length > 0;
}

async function authorizedActorUserId(
  queryable: Pick<DatabasePool, "query">,
  authorization: NormalizedCapacityPolicyAuthorization,
): Promise<string | null> {
  if (authorization.kind === "actor") {
    return await hasCurrentSuperadminAuthorization(
        queryable,
        authorization.actorUserId,
      )
      ? authorization.actorUserId
      : null;
  }

  const { rows } = await queryable.query<{ actor_user_id: string }>(
    `select relay.require_fresh_superadmin_session($1) as actor_user_id`,
    [authorization.sessionId],
  );
  if (rows.length !== 1) {
    throw new CapacityPolicyIntegrityError("session-authorization");
  }
  return normalizeActorUserId(rows[0].actor_user_id);
}

function policyAuditSnapshot(policy: CapacityPolicy): Record<string, unknown> {
  return {
    immutableHash: policy.immutableHash,
    policyId: policy.policyId,
    scopeType: policy.scopeType,
    scopeId: policy.scopeId,
    revision: policy.revision,
    effectiveAt: policy.effectiveAt,
    expiresAt: policy.expiresAt,
    configuration: policy.configuration,
  };
}

const POLICY_COLUMNS = `
  policy.id::text as id,
  policy.scope_type,
  policy.scope_id,
  policy.revision,
  policy.configuration,
  policy.effective_at,
  policy.expires_at,
  (
    select event.after_snapshot ->> 'immutableHash'
      from relay.audit_events as event
     where event.action = 'capacity_policy.revise'
       and event.target_type = 'capacity_policy'
       and event.target_id = policy.id::text
       and event.outcome = 'success'
       and event.after_snapshot ->> 'immutableHash' is not null
     order by event.id
     limit 1
  ) as recorded_immutable_hash`;

async function lockCapacityPolicyMutationKey(
  queryable: Pick<DatabasePool, "query">,
  actorUserId: string,
  keyHash: string,
): Promise<void> {
  await queryable.query(
    `select pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended($1 || ':' || $2 || ':' || $3, 0)
     )`,
    [CAPACITY_POLICY_REVISE_OPERATION, actorUserId, keyHash],
  );
}

async function findGovernanceReplay(
  queryable: Pick<DatabasePool, "query">,
  actorUserId: string,
  artifacts: CapacityPolicyMutationArtifacts,
): Promise<GovernanceIdempotencyRow | null> {
  const { rows } = await queryable.query<GovernanceIdempotencyRow>(
    `select request_fingerprint, response
       from relay.governance_operation_idempotency
      where operation = $1
        and operator_user_id = $2
        and idempotency_key_hash = $3`,
    [CAPACITY_POLICY_REVISE_OPERATION, actorUserId, artifacts.keyHash],
  );
  return rows[0] ?? null;
}

async function storeGovernanceResponse(
  queryable: Pick<DatabasePool, "query">,
  actorUserId: string,
  artifacts: CapacityPolicyMutationArtifacts,
  response: StoredCapacityPolicyMutationResponse,
): Promise<void> {
  await queryable.query(
    `insert into relay.governance_operation_idempotency
       (operation, operator_user_id, idempotency_key_hash,
        request_fingerprint, response)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [
      CAPACITY_POLICY_REVISE_OPERATION,
      actorUserId,
      artifacts.keyHash,
      artifacts.requestFingerprint,
      JSON.stringify(response),
    ],
  );
}

async function replayMutationResponse(
  queryable: Pick<DatabasePool, "query">,
  input: NormalizedRevisionInput,
  response: StoredCapacityPolicyMutationResponse,
): Promise<ReviseCapacityPolicyResult> {
  if (response.kind === "revision_conflict") {
    if (response.expectedRevision !== input.expectedRevision) {
      return idempotencyInvariant(
        "Stored revision conflict does not match the request",
      );
    }
    return { ...response, replayed: true };
  }
  if (response.revision !== input.expectedRevision + 1) {
    return idempotencyInvariant(
      "Stored revised response does not match the expected revision",
    );
  }
  const { rows } = await queryable.query<CapacityPolicyRow>(
    `select ${POLICY_COLUMNS}
       from relay.capacity_policies as policy
      where policy.id = $1::bigint
        and policy.scope_type = $2
        and policy.scope_id = $3
        and policy.revision = $4`,
    [
      response.policyId,
      input.scopeType,
      input.scopeId,
      response.revision,
    ],
  );
  if (rows.length !== 1) {
    return idempotencyInvariant(
      "Stored revised response does not resolve to its capacity policy",
    );
  }
  return { kind: "revised", value: await mapPolicy(rows[0]), replayed: true };
}

async function auditDenied(
  queryable: Pick<DatabasePool, "query">,
  actorUserId: string,
  action: string,
  context: NormalizedAuditContext,
  selector: Record<string, unknown>,
): Promise<void> {
  await recordAuditEvent(queryable, {
    actorType: "user",
    actorUserId,
    action,
    targetType: "capacity_policy",
    outcome: "denied",
    reasonCode: "superadmin_required",
    beforeSnapshot: selector,
    requestId: context.requestId,
    traceId: context.traceId,
  });
}

/**
 * Lists current policies by default. `includeHistory` returns every immutable
 * revision, newest first within each scope.
 */
export async function listCapacityPolicies(
  pool: DatabasePool,
  authorizationInput: CapacityPolicyAuthorization,
  options: ListCapacityPoliciesOptions = {},
): Promise<CapacityPolicyReadResult<readonly CapacityPolicy[]>> {
  const authorization = normalizeAuthorization(authorizationInput);
  const audit = normalizeAuditContext(options);
  const scopeType =
    options.scopeType === undefined || options.scopeType === null
      ? null
      : normalizeScope({ scopeType: options.scopeType, scopeId: "filter" })
        .scopeType;

  let scopeId: string | null = null;
  if (options.scopeId !== undefined && options.scopeId !== null) {
    if (scopeType === null) {
      throw validationError("scopeId", "requires scopeType");
    }
    scopeId = normalizeScope({ scopeType, scopeId: options.scopeId }).scopeId;
  }
  const effectiveAt = options.effectiveAt === undefined ||
      options.effectiveAt === null
    ? null
    : normalizeTimestamp(options.effectiveAt, "effectiveAt");
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw validationError("limit", "must be an integer from 1 through 200");
  }
  const includeHistory = options.includeHistory ?? false;
  if (includeHistory && effectiveAt !== null) {
    throw validationError(
      "effectiveAt",
      "cannot be combined with includeHistory",
    );
  }
  const selector = { scopeType, scopeId, includeHistory, effectiveAt, limit };

  return await withTransaction(pool, async (client) => {
    const actor = await authorizedActorUserId(client, authorization);
    if (actor === null) {
      if (authorization.kind !== "actor") {
        throw new CapacityPolicyIntegrityError("session-authorization");
      }
      await auditDenied(
        client,
        authorization.actorUserId,
        "capacity_policy.list",
        audit,
        selector,
      );
      return { kind: "denied" };
    }

    const query = includeHistory
      ? `select ${POLICY_COLUMNS}
           from relay.capacity_policies as policy
          where ($1::text is null or policy.scope_type = $1)
            and ($2::text is null or policy.scope_id = $2)
          order by policy.scope_type, policy.scope_id, policy.revision desc
          limit $3`
      : `with current_policy as (
           select distinct on (candidate.scope_type, candidate.scope_id)
                  candidate.*
             from relay.capacity_policies as candidate
            where candidate.effective_at <= coalesce(
                    $3::timestamptz,
                    pg_catalog.statement_timestamp()
                  )
              and (
                candidate.expires_at is null or
                candidate.expires_at > coalesce(
                  $3::timestamptz,
                  pg_catalog.statement_timestamp()
                )
              )
              and ($1::text is null or candidate.scope_type = $1)
              and ($2::text is null or candidate.scope_id = $2)
            order by candidate.scope_type, candidate.scope_id,
                     candidate.revision desc
         )
         select ${POLICY_COLUMNS}
           from current_policy as policy
          order by policy.scope_type, policy.scope_id
          limit $4`;
    const values = includeHistory
      ? [scopeType, scopeId, limit]
      : [scopeType, scopeId, effectiveAt, limit];
    const { rows } = await client.query<CapacityPolicyRow>(query, values);
    const policies = await Promise.all(rows.map(mapPolicy));
    await recordAuditEvent(client, {
      actorType: "user",
      actorUserId: actor,
      action: "capacity_policy.list",
      targetType: "capacity_policy",
      outcome: "success",
      afterSnapshot: {
        ...selector,
        count: policies.length,
        policyIds: policies.map((policy: CapacityPolicy) => policy.policyId),
      },
      requestId: audit.requestId,
      traceId: audit.traceId,
    });
    return { kind: "ok", value: policies };
  });
}

/** Gets an exact revision, or the highest revision effective at the given time. */
export async function getCapacityPolicy(
  pool: DatabasePool,
  authorizationInput: CapacityPolicyAuthorization,
  input: GetCapacityPolicyInput,
): Promise<GetCapacityPolicyResult> {
  const authorization = normalizeAuthorization(authorizationInput);
  const scope = normalizeScope(input);
  const audit = normalizeAuditContext(input);
  if (
    input.revision !== undefined && input.effectiveAt !== undefined &&
    input.effectiveAt !== null
  ) {
    throw validationError("effectiveAt", "cannot be combined with revision");
  }
  const revision = input.revision === undefined
    ? null
    : normalizeRevision(input.revision);
  const effectiveAt = input.effectiveAt === undefined ||
      input.effectiveAt === null
    ? null
    : normalizeTimestamp(input.effectiveAt, "effectiveAt");
  const selector = { ...scope, revision, effectiveAt };

  return await withTransaction(pool, async (client) => {
    const actor = await authorizedActorUserId(client, authorization);
    if (actor === null) {
      if (authorization.kind !== "actor") {
        throw new CapacityPolicyIntegrityError("session-authorization");
      }
      await auditDenied(
        client,
        authorization.actorUserId,
        "capacity_policy.get",
        audit,
        selector,
      );
      return { kind: "denied" };
    }

    const query = revision === null
      ? `select ${POLICY_COLUMNS}
           from relay.capacity_policies as policy
          where policy.scope_type = $1
            and policy.scope_id = $2
            and policy.effective_at <= coalesce(
                  $3::timestamptz,
                  pg_catalog.statement_timestamp()
                )
            and (
              policy.expires_at is null or
              policy.expires_at > coalesce(
                $3::timestamptz,
                pg_catalog.statement_timestamp()
              )
            )
          order by policy.revision desc
          limit 1`
      : `select ${POLICY_COLUMNS}
           from relay.capacity_policies as policy
          where policy.scope_type = $1
            and policy.scope_id = $2
            and policy.revision = $3`;
    const { rows } = await client.query<CapacityPolicyRow>(query, [
      scope.scopeType,
      scope.scopeId,
      revision === null ? effectiveAt : revision,
    ]);
    if (rows.length === 0) {
      await recordAuditEvent(client, {
        actorType: "user",
        actorUserId: actor,
        action: "capacity_policy.get",
        targetType: "capacity_policy",
        outcome: "failure",
        reasonCode: "not_found",
        beforeSnapshot: selector,
        requestId: audit.requestId,
        traceId: audit.traceId,
      });
      return { kind: "not_found" };
    }

    const policy = await mapPolicy(rows[0]);
    await recordAuditEvent(client, {
      actorType: "user",
      actorUserId: actor,
      action: "capacity_policy.get",
      targetType: "capacity_policy",
      targetId: policy.policyId,
      outcome: "success",
      afterSnapshot: {
        immutableHash: policy.immutableHash,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        revision: policy.revision,
      },
      requestId: audit.requestId,
      traceId: audit.traceId,
    });
    return { kind: "ok", value: policy };
  });
}

/**
 * Appends a revision after comparing `expectedRevision` with the latest stored
 * revision. Existing rows are never updated or deleted by this service.
 */
export async function reviseCapacityPolicy(
  pool: DatabasePool,
  authorizationInput: CapacityPolicyAuthorization,
  input: ReviseCapacityPolicyInput,
): Promise<ReviseCapacityPolicyResult> {
  const authorization = normalizeAuthorization(authorizationInput);
  const normalized = normalizeRevisionInput(input);
  const requestedHash = await sha256Hex(normalized.canonicalJson);

  return await withTransaction(pool, async (client) => {
    const actor = await authorizedActorUserId(client, authorization);
    if (actor === null) {
      if (authorization.kind !== "actor") {
        throw new CapacityPolicyIntegrityError("session-authorization");
      }
      await auditDenied(
        client,
        authorization.actorUserId,
        "capacity_policy.revise",
        normalized.audit,
        {
          scopeType: normalized.scopeType,
          scopeId: normalized.scopeId,
          expectedRevision: normalized.expectedRevision,
          requestedConfigurationHash: requestedHash,
        },
      );
      return { kind: "denied", replayed: false };
    }

    const mutation = await createCapacityPolicyMutationArtifacts(
      actor,
      normalized,
    );
    if (mutation !== null) {
      await lockCapacityPolicyMutationKey(client, actor, mutation.keyHash);
      const existing = await findGovernanceReplay(client, actor, mutation);
      if (existing !== null) {
        if (existing.request_fingerprint !== mutation.requestFingerprint) {
          await recordAuditEvent(client, {
            actorType: "user",
            actorUserId: actor,
            action: "capacity_policy.revise",
            targetType: "capacity_policy",
            outcome: "failure",
            reasonCode: "mutation_key_conflict",
            beforeSnapshot: {
              scopeType: normalized.scopeType,
              scopeId: normalized.scopeId,
              expectedRevision: normalized.expectedRevision,
              requestedConfigurationHash: requestedHash,
            },
            requestId: normalized.audit.requestId,
            traceId: normalized.audit.traceId,
          });
          return { kind: "mutation_key_conflict", replayed: false };
        }
        return await replayMutationResponse(
          client,
          normalized,
          parseStoredMutationResponse(existing.response),
        );
      }
    }

    await client.query(
      `select pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           'relay.capacity-policy:' || $1 || ':' || $2,
           0
         )
       )`,
      [normalized.scopeType, normalized.scopeId],
    );
    const latestRows = await client.query<CapacityPolicyRow>(
      `select ${POLICY_COLUMNS}
         from relay.capacity_policies as policy
        where policy.scope_type = $1 and policy.scope_id = $2
        order by policy.revision desc
        limit 1
        for update of policy`,
      [normalized.scopeType, normalized.scopeId],
    );
    const latest = latestRows.rows.length === 0
      ? null
      : await mapPolicy(latestRows.rows[0]);
    const actualRevision = latest?.revision ?? 0;
    if (actualRevision !== normalized.expectedRevision) {
      const response: StoredCapacityPolicyMutationResponse = {
        kind: "revision_conflict",
        expectedRevision: normalized.expectedRevision,
        actualRevision,
      };
      if (mutation !== null) {
        await storeGovernanceResponse(client, actor, mutation, response);
      }
      await recordAuditEvent(client, {
        actorType: "user",
        actorUserId: actor,
        action: "capacity_policy.revise",
        targetType: "capacity_policy",
        targetId: latest?.policyId ?? null,
        outcome: "failure",
        reasonCode: "revision_conflict",
        beforeSnapshot: latest === null ? null : policyAuditSnapshot(latest),
        afterSnapshot: {
          scopeType: normalized.scopeType,
          scopeId: normalized.scopeId,
          expectedRevision: normalized.expectedRevision,
          actualRevision,
          requestedConfigurationHash: requestedHash,
        },
        requestId: normalized.audit.requestId,
        traceId: normalized.audit.traceId,
      });
      return { ...response, replayed: false };
    }

    const nextRevision = actualRevision + 1;
    const inserted = await client.query<CapacityPolicyRow>(
      `insert into relay.capacity_policies
         (scope_type, scope_id, revision, configuration, effective_at, expires_at)
       values ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)
       returning id::text, scope_type, scope_id, revision, configuration,
                 effective_at, expires_at`,
      [
        normalized.scopeType,
        normalized.scopeId,
        nextRevision,
        normalized.canonicalJson,
        normalized.effectiveAt,
        normalized.expiresAt,
      ],
    );
    const policy = await mapPolicy(inserted.rows[0]);
    const response: StoredCapacityPolicyMutationResponse = {
      kind: "revised",
      policyId: policy.policyId,
      revision: policy.revision,
    };
    if (mutation !== null) {
      await storeGovernanceResponse(client, actor, mutation, response);
    }
    await recordAuditEvent(client, {
      actorType: "user",
      actorUserId: actor,
      action: "capacity_policy.revise",
      targetType: "capacity_policy",
      targetId: policy.policyId,
      outcome: "success",
      beforeSnapshot: latest === null ? null : policyAuditSnapshot(latest),
      afterSnapshot: policyAuditSnapshot(policy),
      requestId: normalized.audit.requestId,
      traceId: normalized.audit.traceId,
    });
    return { kind: "revised", value: policy, replayed: false };
  });
}
