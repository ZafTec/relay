const KEY_HASH_DOMAIN = "relay.artifact-mutation-idempotency-key:v1";
const REQUEST_FINGERPRINT_DOMAIN =
  "relay.artifact-mutation-request-fingerprint:v1";
const LOCK_DOMAIN = "relay.artifact-mutation-idempotency:v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OPERATION_SET = new Set<string>([
  "create_upload",
  "complete_upload",
  "create_share",
  "revoke_share",
]);
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 10_000;
const MAX_CANONICAL_BYTES = 1024 * 1024;

export const ARTIFACT_MUTATION_OPERATIONS = [
  "create_upload",
  "complete_upload",
  "create_share",
  "revoke_share",
] as const;

export type ArtifactMutationOperation =
  (typeof ARTIFACT_MUTATION_OPERATIONS)[number];

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export interface ArtifactMutationQueryResult<Row> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

/** Structural subset implemented by both `pg.Pool` and `pg.PoolClient`. */
export interface ArtifactMutationQueryExecutor {
  query<Row>(
    text: string,
    params?: unknown[],
  ): Promise<ArtifactMutationQueryResult<Row>>;
}

export interface ArtifactUploadResultReference {
  readonly kind: "artifact_upload";
  readonly uploadId: string;
}

export interface ShareLinkResultReference {
  readonly kind: "share_link";
  readonly shareLinkId: string;
}

export interface ArtifactMutationResultReferenceMap {
  readonly create_upload: ArtifactUploadResultReference;
  readonly complete_upload: ArtifactUploadResultReference;
  readonly create_share: ShareLinkResultReference;
  readonly revoke_share: ShareLinkResultReference;
}

export type ArtifactMutationResultReference<
  Operation extends ArtifactMutationOperation = ArtifactMutationOperation,
> = ArtifactMutationResultReferenceMap[Operation];

export interface ClaimArtifactMutationInput<
  Operation extends ArtifactMutationOperation = ArtifactMutationOperation,
> {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly operation: Operation;
  /** Raw client key. It is hashed before any database query. */
  readonly idempotencyKey: string;
  /** Request semantics to fingerprint; the value itself is never persisted. */
  readonly request: unknown;
}

export interface ArtifactMutationClaim<
  Operation extends ArtifactMutationOperation = ArtifactMutationOperation,
> {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly operation: Operation;
  readonly idempotencyKeyHash: string;
  readonly requestFingerprint: string;
}

export type ClaimArtifactMutationResult<
  Operation extends ArtifactMutationOperation,
> =
  | {
    readonly kind: "claimed";
    readonly claim: ArtifactMutationClaim<Operation>;
  }
  | {
    readonly kind: "replay";
    readonly reference: ArtifactMutationResultReference<Operation>;
  }
  | { readonly kind: "conflict" };

export type CompleteArtifactMutationResult<
  Operation extends ArtifactMutationOperation,
> =
  | {
    readonly kind: "completed" | "replay";
    readonly reference: ArtifactMutationResultReference<Operation>;
  }
  | { readonly kind: "conflict" };

interface NormalizationState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

interface IdempotencyRow {
  readonly workspace_id: string;
  readonly actor_user_id: string;
  readonly operation: string;
  readonly idempotency_key_hash: string;
  readonly request_hash: string;
  readonly response: unknown;
}

export class ArtifactIdempotencyInvariantError extends Error {
  override readonly name = "ArtifactIdempotencyInvariantError";
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function requireSafeText(
  value: string,
  field: string,
  maxLength = 255,
): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maxLength ||
    value.trim() !== value || hasControlCharacter(value)
  ) {
    throw new TypeError(`${field} has an invalid format`);
  }
  return value;
}

function requireOperation(value: string): ArtifactMutationOperation {
  if (!OPERATION_SET.has(value)) {
    throw new TypeError("operation is not an artifact mutation operation");
  }
  return value as ArtifactMutationOperation;
}

function normalize(
  value: unknown,
  depth: number,
  state: NormalizationState,
): CanonicalJsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
    throw new TypeError("canonical JSON value is too complex");
  }
  if (
    value === null || typeof value === "boolean" || typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON numbers must be finite");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
  }
  if (state.ancestors.has(value)) {
    throw new TypeError("canonical JSON value must not contain cycles");
  }

  if (Array.isArray(value)) {
    state.ancestors.add(value);
    try {
      const result: CanonicalJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("canonical JSON arrays must not be sparse");
        }
        result.push(normalize(value[index], depth + 1, state));
      }
      return Object.freeze(result);
    } finally {
      state.ancestors.delete(value);
    }
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("canonical JSON accepts only plain objects");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key === "symbol" &&
      Object.getOwnPropertyDescriptor(value, key)?.enumerable
    ) {
      throw new TypeError("canonical JSON does not support symbol keys");
    }
  }

  state.ancestors.add(value);
  try {
    const result: Record<string, CanonicalJsonValue> = Object.create(null);
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
        throw new TypeError("canonical JSON does not evaluate accessors");
      }
      result[key] = normalize(object[key], depth + 1, state);
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(value);
  }
}

function serializeCanonical(value: CanonicalJsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonical).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return "{" +
    entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${serializeCanonical(item)}`
    ).join(",") + "}";
}

export function normalizeCanonicalJson(value: unknown): CanonicalJsonValue {
  return normalize(value, 0, { ancestors: new WeakSet(), nodes: 0 });
}

export function canonicalJson(value: unknown): string {
  const serialized = serializeCanonical(normalizeCanonicalJson(value));
  if (new TextEncoder().encode(serialized).byteLength > MAX_CANONICAL_BYTES) {
    throw new TypeError("canonical JSON value is too large");
  }
  return serialized;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function fingerprintArtifactMutationRequest(
  operation: ArtifactMutationOperation,
  request: unknown,
): Promise<string> {
  const normalizedOperation = requireOperation(operation);
  return await sha256Hex(
    `${REQUEST_FINGERPRINT_DOMAIN}\0${normalizedOperation}\0${
      canonicalJson(request)
    }`,
  );
}

export async function hashArtifactMutationIdempotencyKey(input: {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly operation: ArtifactMutationOperation;
  readonly idempotencyKey: string;
}): Promise<string> {
  const workspaceId = requireSafeText(input.workspaceId, "workspaceId");
  const actorUserId = requireSafeText(input.actorUserId, "actorUserId");
  const operation = requireOperation(input.operation);
  const idempotencyKey = requireSafeText(
    input.idempotencyKey,
    "idempotencyKey",
  );
  return await sha256Hex(
    `${KEY_HASH_DOMAIN}\0${workspaceId}\0${actorUserId}\0${operation}\0${idempotencyKey}`,
  );
}

function expectedReferenceType(
  operation: ArtifactMutationOperation,
): ArtifactMutationResultReference["kind"] {
  return operation === "create_upload" || operation === "complete_upload"
    ? "artifact_upload"
    : "share_link";
}

function normalizeReference<Operation extends ArtifactMutationOperation>(
  operation: Operation,
  reference: ArtifactMutationResultReference<Operation>,
): ArtifactMutationResultReference<Operation> {
  const expected = expectedReferenceType(operation);
  if (
    reference === null || typeof reference !== "object" ||
    reference.kind !== expected
  ) {
    throw new TypeError(
      "result reference does not match the mutation operation",
    );
  }
  const keys = Object.keys(reference).sort();
  const expectedKeys = expected === "artifact_upload"
    ? ["kind", "uploadId"]
    : ["kind", "shareLinkId"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError("result reference must contain only its typed ID");
  }
  if (expected === "artifact_upload") {
    const uploadId = requireSafeText(
      (reference as ArtifactUploadResultReference).uploadId,
      "uploadId",
    );
    return Object.freeze({
      kind: expected,
      uploadId,
    }) as ArtifactMutationResultReference<Operation>;
  }
  const shareLinkId = requireSafeText(
    (reference as ShareLinkResultReference).shareLinkId,
    "shareLinkId",
  );
  return Object.freeze({
    kind: expected,
    shareLinkId,
  }) as ArtifactMutationResultReference<Operation>;
}

function parseStoredResponse<Operation extends ArtifactMutationOperation>(
  operation: Operation,
  response: unknown,
): ArtifactMutationResultReference<Operation> {
  let value = response;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new ArtifactIdempotencyInvariantError(
        "Artifact idempotency result reference is not valid JSON",
      );
    }
  }
  try {
    return normalizeReference(
      operation,
      value as ArtifactMutationResultReference<Operation>,
    );
  } catch (error) {
    throw new ArtifactIdempotencyInvariantError(
      "Artifact idempotency row has an invalid result reference",
      { cause: error },
    );
  }
}

function claimFrom<Operation extends ArtifactMutationOperation>(
  workspaceId: string,
  actorUserId: string,
  operation: Operation,
  idempotencyKeyHash: string,
  requestFingerprint: string,
): ArtifactMutationClaim<Operation> {
  return Object.freeze({
    workspaceId,
    actorUserId,
    operation,
    idempotencyKeyHash,
    requestFingerprint,
  });
}

async function lockKey(
  queryable: ArtifactMutationQueryExecutor,
  claim: ArtifactMutationClaim,
): Promise<void> {
  await queryable.query(
    `select pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended($1::text, 0)
     )`,
    [
      `${LOCK_DOMAIN}:${claim.workspaceId}:${claim.actorUserId}:${claim.operation}:${claim.idempotencyKeyHash}`,
    ],
  );
}

function validateClaim<Operation extends ArtifactMutationOperation>(
  claim: ArtifactMutationClaim<Operation>,
): ArtifactMutationClaim<Operation> {
  const workspaceId = requireSafeText(claim.workspaceId, "workspaceId");
  const actorUserId = requireSafeText(claim.actorUserId, "actorUserId");
  const operation = requireOperation(claim.operation) as Operation;
  if (
    !SHA256_PATTERN.test(claim.idempotencyKeyHash) ||
    !SHA256_PATTERN.test(claim.requestFingerprint)
  ) {
    throw new TypeError("claim contains invalid hash metadata");
  }
  return claimFrom(
    workspaceId,
    actorUserId,
    operation,
    claim.idempotencyKeyHash,
    claim.requestFingerprint,
  );
}

function sameReference<Operation extends ArtifactMutationOperation>(
  operation: Operation,
  left: ArtifactMutationResultReference<Operation>,
  right: ArtifactMutationResultReference<Operation>,
): boolean {
  if (expectedReferenceType(operation) === "artifact_upload") {
    return (left as ArtifactUploadResultReference).uploadId ===
      (right as ArtifactUploadResultReference).uploadId;
  }
  return (left as ShareLinkResultReference).shareLinkId ===
    (right as ShareLinkResultReference).shareLinkId;
}

async function readExisting<Operation extends ArtifactMutationOperation>(
  queryable: ArtifactMutationQueryExecutor,
  claim: ArtifactMutationClaim<Operation>,
): Promise<IdempotencyRow | null> {
  const result = await queryable.query<IdempotencyRow>(
    `select workspace_id, actor_user_id, operation,
            idempotency_key_hash, request_hash, response
       from relay.artifact_mutation_idempotency
      where workspace_id = $1 and actor_user_id = $2 and operation = $3
        and idempotency_key_hash = $4`,
    [
      claim.workspaceId,
      claim.actorUserId,
      claim.operation,
      claim.idempotencyKeyHash,
    ],
  );
  return result.rows[0] ?? null;
}

function replayOrConflict<Operation extends ArtifactMutationOperation>(
  claim: ArtifactMutationClaim<Operation>,
  row: IdempotencyRow,
): {
  readonly kind: "replay";
  readonly reference: ArtifactMutationResultReference<Operation>;
} | { readonly kind: "conflict" } {
  if (row.request_hash !== claim.requestFingerprint) {
    return { kind: "conflict" };
  }
  return {
    kind: "replay",
    reference: parseStoredResponse(claim.operation, row.response),
  };
}

/**
 * PostgreSQL repository for the immutable
 * `relay.artifact_mutation_idempotency` table.
 *
 * `claim` and `complete` must run in the same caller-owned transaction as the
 * artifact mutation. The transaction-scoped advisory lock serializes identical
 * keys across processes. Completion inserts only hashes and a small typed
 * resource reference into the schema's `response` column—never raw keys,
 * requests, response bodies, bearer tokens, or signed URLs.
 */
export class PostgresArtifactMutationIdempotencyRepository {
  async claim<Operation extends ArtifactMutationOperation>(
    queryable: ArtifactMutationQueryExecutor,
    input: ClaimArtifactMutationInput<Operation>,
  ): Promise<ClaimArtifactMutationResult<Operation>> {
    const workspaceId = requireSafeText(input.workspaceId, "workspaceId");
    const actorUserId = requireSafeText(input.actorUserId, "actorUserId");
    const operation = requireOperation(input.operation) as Operation;
    const [idempotencyKeyHash, requestFingerprint] = await Promise.all([
      hashArtifactMutationIdempotencyKey({
        workspaceId,
        actorUserId,
        operation,
        idempotencyKey: input.idempotencyKey,
      }),
      fingerprintArtifactMutationRequest(operation, {
        workspaceId,
        actorUserId,
        request: input.request,
      }),
    ]);
    const claim = claimFrom(
      workspaceId,
      actorUserId,
      operation,
      idempotencyKeyHash,
      requestFingerprint,
    );
    await lockKey(queryable, claim);
    const existing = await readExisting(queryable, claim);
    if (existing === null) return { kind: "claimed", claim };
    return replayOrConflict(claim, existing);
  }

  async complete<Operation extends ArtifactMutationOperation>(
    queryable: ArtifactMutationQueryExecutor,
    rawClaim: ArtifactMutationClaim<Operation>,
    rawReference: ArtifactMutationResultReference<Operation>,
  ): Promise<CompleteArtifactMutationResult<Operation>> {
    const claim = validateClaim(rawClaim);
    const reference = normalizeReference(claim.operation, rawReference);
    await lockKey(queryable, claim);

    const existing = await readExisting(queryable, claim);
    if (existing !== null) {
      const replay = replayOrConflict(claim, existing);
      if (replay.kind === "conflict") return replay;
      return sameReference(claim.operation, replay.reference, reference)
        ? { kind: "replay", reference: replay.reference }
        : { kind: "conflict" };
    }

    const inserted = await queryable.query<IdempotencyRow>(
      `insert into relay.artifact_mutation_idempotency (
         workspace_id, actor_user_id, operation, idempotency_key_hash,
         request_hash, response
       ) values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (workspace_id, actor_user_id, operation, idempotency_key_hash)
       do nothing
       returning workspace_id, actor_user_id, operation,
                 idempotency_key_hash, request_hash, response`,
      [
        claim.workspaceId,
        claim.actorUserId,
        claim.operation,
        claim.idempotencyKeyHash,
        claim.requestFingerprint,
        JSON.stringify(reference),
      ],
    );
    if (inserted.rows.length === 1) {
      return { kind: "completed", reference };
    }

    const concurrent = await readExisting(queryable, claim);
    if (concurrent === null) {
      throw new ArtifactIdempotencyInvariantError(
        "Artifact idempotency row disappeared after an insert conflict",
      );
    }
    const replay = replayOrConflict(claim, concurrent);
    if (replay.kind === "conflict") return replay;
    return sameReference(claim.operation, replay.reference, reference)
      ? { kind: "replay", reference: replay.reference }
      : { kind: "conflict" };
  }
}

export const postgresArtifactMutationIdempotencyRepository =
  new PostgresArtifactMutationIdempotencyRepository();
