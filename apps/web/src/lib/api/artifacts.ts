import { ApiError, fetchJson } from "./client";

export const ARTIFACT_VERSION_SOURCES = ["upload", "generated", "restore"] as const;
export const ARTIFACT_VERIFICATION_STATUSES = [
  "pending",
  "head_verified",
  "cryptographically_verified",
  "failed",
] as const;
export const SHARE_LINK_STATUSES = ["active", "expired", "exhausted", "revoked"] as const;

export type ArtifactVersionSource = typeof ARTIFACT_VERSION_SOURCES[number];
export type ArtifactVerificationStatus = typeof ARTIFACT_VERIFICATION_STATUSES[number];
export type ShareLinkStatus = typeof SHARE_LINK_STATUSES[number];
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface ArtifactVersionResource {
  readonly id: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly contentMd5: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly source: ArtifactVersionSource;
  readonly sourceRunId: string | null;
  readonly parentVersionId: string | null;
  readonly metadata: JsonObject;
  readonly verificationStatus: ArtifactVerificationStatus;
  readonly createdAt: string;
}

export interface ArtifactSummary {
  readonly id: string;
  readonly name: string;
  readonly mediaKind: string;
  readonly sourceRunId: string | null;
  readonly currentVersion: ArtifactVersionResource | null;
  readonly shared: boolean;
  readonly createdAt: string;
}

export interface ShareLinkResource {
  readonly id: string;
  readonly artifactId: string;
  readonly artifactVersionId: string | null;
  readonly followCurrent: boolean;
  readonly expiresAt: string | null;
  readonly maxResolutions: number | null;
  readonly resolutionCount: number;
  readonly requireAuth: boolean;
  readonly contentDisposition: "attachment" | "inline";
  readonly status: ShareLinkStatus;
  readonly createdAt: string;
}

export interface ArtifactDetail extends ArtifactSummary {
  readonly versions: readonly ArtifactVersionResource[];
  readonly shares: readonly ShareLinkResource[];
}

export interface ListArtifactsRequest {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly mediaKind?: string;
  readonly sourceRunId?: string;
  readonly shared?: boolean;
  readonly search?: string;
}

export interface CreateShareLinkRequest {
  readonly artifactId: string;
  readonly followCurrent: boolean;
  readonly artifactVersionId?: string | null;
  readonly expiresAt?: string | null;
  readonly maxResolutions?: number | null;
  readonly requireAuth?: boolean;
  readonly contentDisposition: "attachment" | "inline";
}

export type ListArtifactsAdapterResult =
  | {
      readonly kind: "ok";
      readonly items: readonly ArtifactSummary[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "auth-expired" }
  | { readonly kind: "degraded"; readonly message: string };

export type GetArtifactAdapterResult =
  | { readonly kind: "found"; readonly artifact: ArtifactDetail }
  | { readonly kind: "not_found" }
  | { readonly kind: "auth-expired" }
  | { readonly kind: "degraded"; readonly message: string };

export type CreateShareLinkAdapterResult =
  | {
      readonly kind: "created";
      readonly shareLinkId: string;
      readonly token: string;
      readonly publicPath: string;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" }
  | { readonly kind: "auth-expired" }
  | { readonly kind: "degraded"; readonly message: string }
  | { readonly kind: "unknown_outcome"; readonly message: string };

export type RevokeShareLinkAdapterResult =
  | { readonly kind: "revoked" }
  | { readonly kind: "already_revoked" }
  | { readonly kind: "not_found" }
  | { readonly kind: "auth-expired" }
  | { readonly kind: "degraded"; readonly message: string };

export interface ArtifactsAdapter {
  list(
    request?: ListArtifactsRequest,
    signal?: AbortSignal,
  ): Promise<ListArtifactsAdapterResult>;
  get(artifactId: string, signal?: AbortSignal): Promise<GetArtifactAdapterResult>;
  createShareLink(request: CreateShareLinkRequest): Promise<CreateShareLinkAdapterResult>;
  revokeShareLink(
    artifactId: string,
    shareLinkId: string,
  ): Promise<RevokeShareLinkAdapterResult>;
}

export class InvalidArtifactResponseError extends TypeError {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "InvalidArtifactResponseError";
  }
}

const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{32}$/;
const ARTIFACT_VERSION_ID_PATTERN = /^aver_[0-9a-f]{32}$/;
const RUN_ID_PATTERN = /^run_[0-9a-f]{32}$/;
const SHARE_LINK_ID_PATTERN = /^share_[0-9a-f]{32}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTENT_MD5_PATTERN = /^[A-Za-z0-9+/]{22}==$/;
const MEDIA_KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const MIME_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RAW_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\//i;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;
const MAX_METADATA_BYTES = 64 * 1_024;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 2_048;

function invalid(path: string, message: string): never {
  throw new InvalidArtifactResponseError(path, message);
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

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return invalid(path, "must be a boolean");
  return value;
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

function isoTimestamp(value: unknown, path: string): string {
  const parsed = stringValue(value, path, {
    minLength: 24,
    maxLength: 24,
    pattern: ISO_TIMESTAMP_PATTERN,
  });
  if (!Number.isFinite(Date.parse(parsed))) invalid(path, "must be an ISO timestamp");
  return parsed;
}

function identifier(value: unknown, path: string, pattern: RegExp): string {
  return stringValue(value, path, { pattern });
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
  if (typeof value === "string") {
    if (RAW_URL_PATTERN.test(value)) return invalid(path, "must not contain a URL");
    return value;
  }
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
      if (RAW_URL_PATTERN.test(key)) invalid(path, "must not contain a URL");
      object[key] = inspectJson(item, `${path}.${key}`, depth + 1, state);
    }
    parsed = object;
  }
  state.seen.delete(value);
  return parsed;
}

function jsonObject(value: unknown, path: string): JsonObject {
  const parsed = inspectJson(value, path, 0, { nodes: 0, seen: new WeakSet() });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid(path, "must be a JSON object");
  }
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > MAX_METADATA_BYTES) {
    invalid(path, "is too large");
  }
  return parsed as JsonObject;
}

function arrayValue<T>(
  value: unknown,
  path: string,
  parser: (candidate: unknown, candidatePath: string) => T,
  maximum: number,
): readonly T[] {
  if (!Array.isArray(value)) return invalid(path, "must be an array");
  if (value.length > maximum) invalid(path, `must contain at most ${maximum} items`);
  return value.map((item, index) => parser(item, `${path}[${index}]`));
}

function artifactVersion(value: unknown, path: string): ArtifactVersionResource {
  const object = strictObject(value, path, [
    "id",
    "sequence",
    "sha256",
    "contentMd5",
    "sizeBytes",
    "mimeType",
    "width",
    "height",
    "durationMs",
    "source",
    "sourceRunId",
    "parentVersionId",
    "metadata",
    "verificationStatus",
    "createdAt",
  ]);

  return {
    id: identifier(required(object, "id", path), `${path}.id`, ARTIFACT_VERSION_ID_PATTERN),
    sequence: integerValue(required(object, "sequence", path), `${path}.sequence`, { minimum: 1 }),
    sha256: stringValue(required(object, "sha256", path), `${path}.sha256`, { pattern: SHA256_PATTERN }),
    contentMd5: stringValue(required(object, "contentMd5", path), `${path}.contentMd5`, {
      pattern: CONTENT_MD5_PATTERN,
    }),
    sizeBytes: integerValue(required(object, "sizeBytes", path), `${path}.sizeBytes`, { minimum: 0 }),
    mimeType: stringValue(required(object, "mimeType", path), `${path}.mimeType`, {
      minLength: 1,
      maxLength: 255,
      pattern: MIME_TYPE_PATTERN,
    }),
    width: nullable(required(object, "width", path), `${path}.width`, (item, itemPath) =>
      integerValue(item, itemPath, { minimum: 1 })),
    height: nullable(required(object, "height", path), `${path}.height`, (item, itemPath) =>
      integerValue(item, itemPath, { minimum: 1 })),
    durationMs: nullable(required(object, "durationMs", path), `${path}.durationMs`, (item, itemPath) =>
      integerValue(item, itemPath, { minimum: 1 })),
    source: enumValue(
      required(object, "source", path),
      `${path}.source`,
      ARTIFACT_VERSION_SOURCES,
    ),
    sourceRunId: nullable(
      required(object, "sourceRunId", path),
      `${path}.sourceRunId`,
      (item, itemPath) => identifier(item, itemPath, RUN_ID_PATTERN),
    ),
    parentVersionId: nullable(
      required(object, "parentVersionId", path),
      `${path}.parentVersionId`,
      (item, itemPath) => identifier(item, itemPath, ARTIFACT_VERSION_ID_PATTERN),
    ),
    metadata: jsonObject(required(object, "metadata", path), `${path}.metadata`),
    verificationStatus: enumValue(
      required(object, "verificationStatus", path),
      `${path}.verificationStatus`,
      ARTIFACT_VERIFICATION_STATUSES,
    ),
    createdAt: isoTimestamp(required(object, "createdAt", path), `${path}.createdAt`),
  };
}

function artifactSummary(value: unknown, path: string): ArtifactSummary {
  const object = strictObject(value, path, [
    "id",
    "name",
    "mediaKind",
    "sourceRunId",
    "currentVersion",
    "shared",
    "createdAt",
  ]);

  return {
    id: identifier(required(object, "id", path), `${path}.id`, ARTIFACT_ID_PATTERN),
    name: stringValue(required(object, "name", path), `${path}.name`, {
      minLength: 1,
      maxLength: 255,
    }),
    mediaKind: stringValue(required(object, "mediaKind", path), `${path}.mediaKind`, {
      pattern: MEDIA_KIND_PATTERN,
    }),
    sourceRunId: nullable(
      required(object, "sourceRunId", path),
      `${path}.sourceRunId`,
      (item, itemPath) => identifier(item, itemPath, RUN_ID_PATTERN),
    ),
    currentVersion: nullable(
      required(object, "currentVersion", path),
      `${path}.currentVersion`,
      artifactVersion,
    ),
    shared: booleanValue(required(object, "shared", path), `${path}.shared`),
    createdAt: isoTimestamp(required(object, "createdAt", path), `${path}.createdAt`),
  };
}

function shareLink(value: unknown, path: string): ShareLinkResource {
  const object = strictObject(value, path, [
    "id",
    "artifactId",
    "artifactVersionId",
    "followCurrent",
    "expiresAt",
    "maxResolutions",
    "resolutionCount",
    "requireAuth",
    "contentDisposition",
    "status",
    "createdAt",
  ]);
  const followCurrent = booleanValue(required(object, "followCurrent", path), `${path}.followCurrent`);
  const artifactVersionId = nullable(
    required(object, "artifactVersionId", path),
    `${path}.artifactVersionId`,
    (item, itemPath) => identifier(item, itemPath, ARTIFACT_VERSION_ID_PATTERN),
  );
  if (followCurrent === (artifactVersionId !== null)) {
    invalid(`${path}.artifactVersionId`, "must be null only for follow-current links");
  }

  return {
    id: identifier(required(object, "id", path), `${path}.id`, SHARE_LINK_ID_PATTERN),
    artifactId: identifier(required(object, "artifactId", path), `${path}.artifactId`, ARTIFACT_ID_PATTERN),
    artifactVersionId,
    followCurrent,
    expiresAt: nullable(required(object, "expiresAt", path), `${path}.expiresAt`, isoTimestamp),
    maxResolutions: nullable(
      required(object, "maxResolutions", path),
      `${path}.maxResolutions`,
      (item, itemPath) => integerValue(item, itemPath, { minimum: 1 }),
    ),
    resolutionCount: integerValue(
      required(object, "resolutionCount", path),
      `${path}.resolutionCount`,
      { minimum: 0 },
    ),
    requireAuth: booleanValue(required(object, "requireAuth", path), `${path}.requireAuth`),
    contentDisposition: enumValue(
      required(object, "contentDisposition", path),
      `${path}.contentDisposition`,
      ["attachment", "inline"] as const,
    ),
    status: enumValue(required(object, "status", path), `${path}.status`, SHARE_LINK_STATUSES),
    createdAt: isoTimestamp(required(object, "createdAt", path), `${path}.createdAt`),
  };
}

function artifactDetail(value: unknown, path: string): ArtifactDetail {
  const object = strictObject(value, path, [
    "id",
    "name",
    "mediaKind",
    "sourceRunId",
    "currentVersion",
    "shared",
    "createdAt",
    "versions",
    "shares",
  ]);
  const summary = artifactSummary({
    id: object.id,
    name: object.name,
    mediaKind: object.mediaKind,
    sourceRunId: object.sourceRunId,
    currentVersion: object.currentVersion,
    shared: object.shared,
    createdAt: object.createdAt,
  }, path);

  return {
    ...summary,
    versions: arrayValue(required(object, "versions", path), `${path}.versions`, artifactVersion, 1_000),
    shares: arrayValue(required(object, "shares", path), `${path}.shares`, shareLink, 1_000),
  };
}

export function parseListArtifactsResponse(value: unknown): Extract<ListArtifactsAdapterResult, { kind: "ok" | "not_found" }> {
  const path = "$input";
  const object = strictObject(value, path, ["kind", "items", "nextCursor"]);
  const kind = enumValue(required(object, "kind", path), `${path}.kind`, ["ok", "not_found"] as const);
  if (kind === "not_found") {
    strictObject(value, path, ["kind"]);
    return { kind };
  }
  return {
    kind,
    items: arrayValue(required(object, "items", path), `${path}.items`, artifactSummary, MAX_PAGE_SIZE),
    nextCursor: nullable(required(object, "nextCursor", path), `${path}.nextCursor`, (item, itemPath) =>
      stringValue(item, itemPath, {
        minLength: 1,
        maxLength: MAX_CURSOR_LENGTH,
        pattern: CURSOR_PATTERN,
      })),
  };
}

export function parseGetArtifactResponse(value: unknown): Extract<GetArtifactAdapterResult, { kind: "found" | "not_found" }> {
  const path = "$input";
  const object = strictObject(value, path, ["kind", "artifact"]);
  const kind = enumValue(required(object, "kind", path), `${path}.kind`, ["found", "not_found"] as const);
  if (kind === "not_found") {
    strictObject(value, path, ["kind"]);
    return { kind };
  }
  return { kind, artifact: artifactDetail(required(object, "artifact", path), `${path}.artifact`) };
}

export function parseCreateShareLinkResponse(
  value: unknown,
): Extract<CreateShareLinkAdapterResult, { kind: "created" | "not_found" | "conflict" }> {
  const path = "$input";
  const object = strictObject(value, path, ["kind", "shareLinkId", "token", "publicPath"]);
  const kind = enumValue(
    required(object, "kind", path),
    `${path}.kind`,
    ["created", "not_found", "conflict"] as const,
  );
  if (kind !== "created") {
    strictObject(value, path, ["kind"]);
    return { kind };
  }

  const token = stringValue(required(object, "token", path), `${path}.token`, {
    pattern: SHARE_TOKEN_PATTERN,
  });
  const publicPath = stringValue(required(object, "publicPath", path), `${path}.publicPath`, {
    pattern: /^\/s\/[A-Za-z0-9_-]{43}$/,
  });
  if (publicPath !== `/s/${token}`) {
    invalid(`${path}.publicPath`, "must identify the returned token");
  }

  return {
    kind,
    shareLinkId: identifier(
      required(object, "shareLinkId", path),
      `${path}.shareLinkId`,
      SHARE_LINK_ID_PATTERN,
    ),
    token,
    publicPath,
  };
}

export function parseRevokeShareLinkResponse(
  value: unknown,
): Extract<RevokeShareLinkAdapterResult, { kind: "revoked" | "already_revoked" | "not_found" }> {
  const path = "$input";
  const object = strictObject(value, path, ["kind"]);
  return {
    kind: enumValue(
      required(object, "kind", path),
      `${path}.kind`,
      ["revoked", "already_revoked", "not_found"] as const,
    ),
  };
}

export function isArtifactId(value: string | undefined): value is string {
  return typeof value === "string" && ARTIFACT_ID_PATTERN.test(value);
}

function parseListRequest(value: ListArtifactsRequest): ListArtifactsRequest {
  const path = "$request";
  const object = strictObject(value, path, [
    "cursor",
    "limit",
    "mediaKind",
    "sourceRunId",
    "shared",
    "search",
  ]);
  const cursor = optionalNullable(object, "cursor", path, (item, itemPath) =>
    stringValue(item, itemPath, {
      minLength: 1,
      maxLength: MAX_CURSOR_LENGTH,
      pattern: CURSOR_PATTERN,
    }));
  const limit = optional(object, "limit", path, (item, itemPath) =>
    integerValue(item, itemPath, { minimum: 1, maximum: MAX_PAGE_SIZE }));
  const mediaKind = optional(object, "mediaKind", path, (item, itemPath) =>
    stringValue(item, itemPath, { pattern: MEDIA_KIND_PATTERN }));
  const sourceRunId = optional(object, "sourceRunId", path, (item, itemPath) =>
    identifier(item, itemPath, RUN_ID_PATTERN));
  const shared = optional(object, "shared", path, booleanValue);
  const search = optional(object, "search", path, (item, itemPath) =>
    stringValue(item, itemPath, { minLength: 1, maxLength: 100, trim: true }));

  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
    ...(mediaKind === undefined ? {} : { mediaKind }),
    ...(sourceRunId === undefined ? {} : { sourceRunId }),
    ...(shared === undefined ? {} : { shared }),
    ...(search === undefined ? {} : { search }),
  };
}

function parseCreateShareRequest(value: CreateShareLinkRequest): CreateShareLinkRequest {
  const path = "$request";
  const object = strictObject(value, path, [
    "artifactId",
    "followCurrent",
    "artifactVersionId",
    "expiresAt",
    "maxResolutions",
    "requireAuth",
    "contentDisposition",
  ]);
  const followCurrent = booleanValue(required(object, "followCurrent", path), `${path}.followCurrent`);
  const artifactVersionId = optionalNullable(object, "artifactVersionId", path, (item, itemPath) =>
    identifier(item, itemPath, ARTIFACT_VERSION_ID_PATTERN));
  if (
    (followCurrent && artifactVersionId != null)
    || (!followCurrent && artifactVersionId == null)
  ) {
    invalid(
      `${path}.artifactVersionId`,
      "must be absent for follow-current links and present for pinned links",
    );
  }
  const expiresAt = optionalNullable(object, "expiresAt", path, isoTimestamp);
  const maxResolutions = optionalNullable(object, "maxResolutions", path, (item, itemPath) =>
    integerValue(item, itemPath, { minimum: 1 }));
  const requireAuth = optional(object, "requireAuth", path, booleanValue);

  return {
    artifactId: identifier(required(object, "artifactId", path), `${path}.artifactId`, ARTIFACT_ID_PATTERN),
    followCurrent,
    ...(artifactVersionId === undefined ? {} : { artifactVersionId }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(maxResolutions === undefined ? {} : { maxResolutions }),
    ...(requireAuth === undefined ? {} : { requireAuth }),
    contentDisposition: enumValue(
      required(object, "contentDisposition", path),
      `${path}.contentDisposition`,
      ["attachment", "inline"] as const,
    ),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function listPath(request: ListArtifactsRequest): string {
  const parsed = parseListRequest(request);
  const query = new URLSearchParams();
  if (parsed.cursor !== undefined && parsed.cursor !== null) query.set("cursor", parsed.cursor);
  if (parsed.limit !== undefined) query.set("limit", String(parsed.limit));
  if (parsed.mediaKind !== undefined) query.set("mediaKind", parsed.mediaKind);
  if (parsed.sourceRunId !== undefined) query.set("sourceRunId", parsed.sourceRunId);
  if (parsed.shared !== undefined) query.set("shared", String(parsed.shared));
  if (parsed.search !== undefined) query.set("search", parsed.search);
  const serialized = query.toString();
  return serialized.length > 0 ? `/api/v1/artifacts?${serialized}` : "/api/v1/artifacts";
}

function artifactPath(artifactId: string): string {
  const parsed = identifier(artifactId, "$request.artifactId", ARTIFACT_ID_PATTERN);
  return `/api/v1/artifacts/${encodeURIComponent(parsed)}`;
}

export const httpArtifactsAdapter: ArtifactsAdapter = {
  async list(request = {}, signal) {
    try {
      const response = await fetchJson<unknown>(listPath(request), {
        cache: "no-store",
        signal,
      });
      return parseListArtifactsResponse(response);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ApiError && error.status === 401) return { kind: "auth-expired" };
      if (error instanceof ApiError && error.status === 404) return { kind: "not_found" };
      if (error instanceof InvalidArtifactResponseError) {
        return {
          kind: "degraded",
          message: "Relay returned an unreadable artifact list. No artifact data was shown.",
        };
      }
      return {
        kind: "degraded",
        message: error instanceof TypeError
          ? "Relay could not reach the artifact registry. Check the connection and try again."
          : "Relay could not load artifacts. No artifact data was changed.",
      };
    }
  },

  async get(artifactId, signal) {
    try {
      const response = await fetchJson<unknown>(artifactPath(artifactId), {
        cache: "no-store",
        signal,
      });
      return parseGetArtifactResponse(response);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ApiError && error.status === 401) return { kind: "auth-expired" };
      if (error instanceof ApiError && error.status === 404) return { kind: "not_found" };
      if (error instanceof InvalidArtifactResponseError) {
        return {
          kind: "degraded",
          message: "Relay returned an unreadable artifact record. No artifact details were shown.",
        };
      }
      return {
        kind: "degraded",
        message: error instanceof TypeError
          ? "Relay could not reach the artifact registry. Check the connection and try again."
          : "Relay could not load this artifact. No artifact data was changed.",
      };
    }
  },

  async createShareLink(request) {
    let parsed: CreateShareLinkRequest;
    try {
      parsed = parseCreateShareRequest(request);
    } catch {
      return {
        kind: "degraded",
        message: "The share policy could not be prepared. Review the fields and try again.",
      };
    }

    try {
      const { artifactId, ...body } = parsed;
      const response = await fetchJson<unknown>(`${artifactPath(artifactId)}/share-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseCreateShareLinkResponse(response);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return { kind: "auth-expired" };
      if (error instanceof ApiError && error.status === 404) return { kind: "not_found" };
      if (error instanceof ApiError && error.status === 409) return { kind: "conflict" };
      return {
        kind: "unknown_outcome",
        message: "Relay could not confirm whether the share link was created. Do not retry this request. Close the panel and inspect the share records.",
      };
    }
  },

  async revokeShareLink(artifactId, shareLinkId) {
    try {
      const path = `${artifactPath(artifactId)}/share-links/${encodeURIComponent(
        identifier(shareLinkId, "$request.shareLinkId", SHARE_LINK_ID_PATTERN),
      )}`;
      const response = await fetchJson<unknown>(path, { method: "DELETE" });
      return parseRevokeShareLinkResponse(response);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return { kind: "auth-expired" };
      if (error instanceof ApiError && error.status === 404) return { kind: "not_found" };
      if (error instanceof InvalidArtifactResponseError) {
        return {
          kind: "degraded",
          message: "Relay returned an unreadable revoke result. The operation was not repeated.",
        };
      }
      return {
        kind: "degraded",
        message: error instanceof TypeError
          ? "Relay could not reach the share service. The operation was not repeated."
          : "Relay could not revoke the share link. The operation was not repeated.",
      };
    }
  },
};
