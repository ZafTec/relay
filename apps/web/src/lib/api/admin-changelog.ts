import { ApiError, fetchJson } from "./client";

export const CHANGELOG_CATEGORIES = [
  "added",
  "improved",
  "fixed",
  "security",
  "breaking",
] as const;

export const CHANGELOG_RELEASE_STATUSES = [
  "draft",
  "published",
  "archived",
] as const;

export const CHANGELOG_PUBLISHABILITY_REASONS = [
  "invalid_version",
  "missing_git_tag",
  "missing_commit_sha",
  "missing_released_at",
  "missing_items",
] as const;

export const ADMIN_CHANGELOG_MUTATION_OPERATIONS = [
  "create",
  "revise",
  "publish",
  "unpublish",
] as const;

export type ChangelogCategory = typeof CHANGELOG_CATEGORIES[number];
export type ChangelogReleaseStatus = typeof CHANGELOG_RELEASE_STATUSES[number];
export type ChangelogPublishabilityReason =
  typeof CHANGELOG_PUBLISHABILITY_REASONS[number];
export type AdminChangelogCategory = ChangelogCategory;
export type AdminChangelogReleaseStatus = ChangelogReleaseStatus;
export type AdminChangelogPublishabilityReason = ChangelogPublishabilityReason;
export type AdminChangelogMutationOperation =
  typeof ADMIN_CHANGELOG_MUTATION_OPERATIONS[number];

export interface AdminChangelogItemInput {
  readonly category: ChangelogCategory;
  readonly area: string | null;
  readonly title: string;
  readonly description: string;
  readonly sortOrder: number;
}

export interface AdminChangelogDraftInput {
  readonly version: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly gitTag: string | null;
  readonly commitSha: string | null;
  readonly releasedAt: string | null;
  readonly items: readonly AdminChangelogItemInput[];
}

export interface ReviseAdminChangelogRequest extends AdminChangelogDraftInput {
  readonly expectedRevision: number;
}

export interface PublishAdminChangelogRequest {
  readonly expectedRevision: number;
}

export interface UnpublishAdminChangelogRequest {
  readonly expectedPublishedRevision: number;
}

export interface ListAdminChangelogRequest {
  readonly limit?: number;
  readonly beforeReleaseId?: string | null;
}

export interface AdminChangelogSummary {
  readonly releaseId: string;
  readonly version: string;
  readonly slug: string;
  readonly status: ChangelogReleaseStatus;
  readonly latestRevision: number;
  readonly publishedRevision: number | null;
  readonly hasUnpublishedChanges: boolean;
  readonly updatedAt: string;
}

export interface AdminChangelogReleaseSnapshot extends AdminChangelogDraftInput {
  readonly contentSha256: string;
}

export type AdminChangelogSnapshot = AdminChangelogReleaseSnapshot;

export interface AdminChangelogReleaseDetail {
  readonly releaseId: string;
  readonly status: ChangelogReleaseStatus;
  readonly latestRevision: number;
  readonly publishedRevision: number | null;
  readonly hasUnpublishedChanges: boolean;
  readonly firstPublishedAt: string | null;
  readonly lastPublishedAt: string | null;
  readonly latest: AdminChangelogReleaseSnapshot;
  readonly published: AdminChangelogReleaseSnapshot | null;
}

export type AdminChangelogRelease = AdminChangelogReleaseDetail;

export interface AdminChangelogListResponse {
  readonly releases: readonly AdminChangelogSummary[];
}

export type AdminChangelogAccessFailure =
  | { readonly kind: "auth-expired" }
  | { readonly kind: "reauthentication-required" }
  | { readonly kind: "denied" }
  | { readonly kind: "not-found" };

export interface AdminChangelogDegradedResult {
  readonly kind: "degraded";
  readonly message: string;
}

export interface AdminChangelogUnknownOutcomeResult {
  readonly kind: "unknown-outcome";
  readonly message: string;
}

export interface AdminChangelogIdentityConflictResult {
  readonly kind: "identity-conflict";
  readonly actualRevision: number;
}

export interface AdminChangelogRevisionConflictResult {
  readonly kind: "revision-conflict";
  readonly actualRevision: number;
}

export interface AdminChangelogVersionConflictResult {
  readonly kind: "version-conflict";
}

export interface AdminChangelogSlugConflictResult {
  readonly kind: "slug-conflict";
}

export interface AdminChangelogVersionAndSlugConflictResult {
  readonly kind: "version-and-slug-conflict";
}

export interface AdminChangelogNotPublishableResult {
  readonly kind: "not-publishable";
  readonly reasons: readonly ChangelogPublishabilityReason[];
}

export interface AdminChangelogIdempotencyConflictResult {
  readonly kind: "idempotency-conflict";
}

export type AdminChangelogConflictResult =
  | AdminChangelogIdentityConflictResult
  | AdminChangelogRevisionConflictResult
  | AdminChangelogVersionConflictResult
  | AdminChangelogSlugConflictResult
  | AdminChangelogVersionAndSlugConflictResult;

export type AdminChangelogMutationFailure =
  | AdminChangelogAccessFailure
  | AdminChangelogConflictResult
  | AdminChangelogNotPublishableResult
  | AdminChangelogIdempotencyConflictResult
  | AdminChangelogDegradedResult
  | AdminChangelogUnknownOutcomeResult;

export type ListAdminChangelogAdapterResult =
  | { readonly kind: "ok"; readonly releases: readonly AdminChangelogSummary[] }
  | AdminChangelogAccessFailure
  | AdminChangelogDegradedResult;

export type GetAdminChangelogAdapterResult =
  | { readonly kind: "found"; readonly release: AdminChangelogReleaseDetail }
  | AdminChangelogAccessFailure
  | AdminChangelogDegradedResult;

export interface CreatedAdminChangelogResult {
  readonly kind: "created";
  readonly replayed: boolean;
  readonly releaseId: string;
  readonly revision: number;
}

export interface RevisedAdminChangelogResult {
  readonly kind: "revised" | "unchanged";
  readonly replayed: boolean;
  readonly releaseId: string;
  readonly revision: number;
}

export type PublishedAdminChangelogResult =
  | {
      readonly kind: "published" | "unchanged";
      readonly replayed: boolean;
      readonly releaseId: string;
      readonly revision: number;
      readonly supersededRevision: null;
    }
  | {
      readonly kind: "superseded";
      readonly replayed: boolean;
      readonly releaseId: string;
      readonly revision: number;
      readonly supersededRevision: number;
    };

export type UnpublishedAdminChangelogResult =
  | {
      readonly kind: "unpublished";
      readonly replayed: boolean;
      readonly releaseId: string;
      readonly revision: number;
    }
  | {
      readonly kind: "unchanged";
      readonly replayed: boolean;
      readonly releaseId: string;
      readonly revision: number | null;
    };

export type CreateAdminChangelogAdapterResult =
  | CreatedAdminChangelogResult
  | AdminChangelogMutationFailure;
export type ReviseAdminChangelogAdapterResult =
  | RevisedAdminChangelogResult
  | AdminChangelogMutationFailure;
export type PublishAdminChangelogAdapterResult =
  | PublishedAdminChangelogResult
  | AdminChangelogMutationFailure;
export type UnpublishAdminChangelogAdapterResult =
  | UnpublishedAdminChangelogResult
  | AdminChangelogMutationFailure;

export interface AdminChangelogAdapter {
  list(
    request?: ListAdminChangelogRequest,
    signal?: AbortSignal,
  ): Promise<ListAdminChangelogAdapterResult>;
  get(
    releaseId: string,
    signal?: AbortSignal,
  ): Promise<GetAdminChangelogAdapterResult>;
  create(
    input: AdminChangelogDraftInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CreateAdminChangelogAdapterResult>;
  revise(
    releaseId: string,
    request: ReviseAdminChangelogRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ReviseAdminChangelogAdapterResult>;
  publish(
    releaseId: string,
    request: PublishAdminChangelogRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<PublishAdminChangelogAdapterResult>;
  unpublish(
    releaseId: string,
    request: UnpublishAdminChangelogRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<UnpublishAdminChangelogAdapterResult>;
}

export class InvalidAdminChangelogResponseError extends TypeError {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "InvalidAdminChangelogResponseError";
  }
}

export class InvalidAdminChangelogRequestError extends TypeError {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "InvalidAdminChangelogRequestError";
  }
}

const ADMIN_CHANGELOG_PATH = "/api/v1/admin/changelog";
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX = "9223372036854775807";
const MAX_CHANGELOG_ITEMS = 200;
const MAX_ADMIN_CHANGELOG_PAGE_SIZE = 100;
const ISO_UTC_MILLISECOND_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

type InvalidFactory = (path: string, message: string) => never;

function invalidResponse(path: string, message: string): never {
  throw new InvalidAdminChangelogResponseError(path, message);
}

function invalidRequest(path: string, message: string): never {
  throw new InvalidAdminChangelogRequestError(path, message);
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
  options: { readonly minimum: number; readonly maximum: number },
  invalid: InvalidFactory,
): number {
  if (!Number.isSafeInteger(value)) return invalid(path, "must be a safe integer");
  const parsed = value as number;
  if (parsed < options.minimum || parsed > options.maximum) {
    invalid(
      path,
      `must be between ${options.minimum} and ${options.maximum}`,
    );
  }
  return parsed;
}

function booleanValue(
  value: unknown,
  path: string,
  invalid: InvalidFactory,
): boolean {
  if (typeof value !== "boolean") return invalid(path, "must be a boolean");
  return value;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  path: string,
  values: Values,
  invalid: InvalidFactory,
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

function arrayValue<T>(
  value: unknown,
  path: string,
  parser: (candidate: unknown, candidatePath: string) => T,
  options: { readonly minimum?: number; readonly maximum: number },
  invalid: InvalidFactory,
): readonly T[] {
  if (!Array.isArray(value)) return invalid(path, "must be an array");
  if (options.minimum !== undefined && value.length < options.minimum) {
    invalid(path, "contains too few items");
  }
  if (value.length > options.maximum) invalid(path, "contains too many items");
  return value.map((item, index) => parser(item, `${path}[${index}]`));
}

function releaseIdValue(
  value: unknown,
  path: string,
  invalid: InvalidFactory,
): string {
  const parsed = stringValue(value, path, { minLength: 1, maxLength: 19 }, invalid);
  if (
    !/^[1-9][0-9]*$/.test(parsed)
    || parsed.length > POSTGRES_BIGINT_MAX.length
    || (
      parsed.length === POSTGRES_BIGINT_MAX.length
      && parsed > POSTGRES_BIGINT_MAX
    )
  ) {
    return invalid(path, "must be a positive PostgreSQL bigint string");
  }
  return parsed;
}

function revisionValue(
  value: unknown,
  path: string,
  invalid: InvalidFactory,
): number {
  return integerValue(
    value,
    path,
    { minimum: 1, maximum: POSTGRES_INTEGER_MAX },
    invalid,
  );
}

function exactTimestamp(
  value: unknown,
  path: string,
  invalid: InvalidFactory,
): string {
  const parsed = stringValue(
    value,
    path,
    {
      minLength: 24,
      maxLength: 24,
      pattern: ISO_UTC_MILLISECOND_PATTERN,
    },
    invalid,
  );
  const timestamp = new Date(parsed);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== parsed) {
    return invalid(path, "must be an exact UTC timestamp with milliseconds");
  }
  return parsed;
}

function nullableString(
  value: unknown,
  path: string,
  maximum: number,
  invalid: InvalidFactory,
): string | null {
  return nullable(value, path, (candidate, candidatePath) =>
    stringValue(candidate, candidatePath, { maxLength: maximum }, invalid));
}

function changelogItem(
  value: unknown,
  path: string,
  invalid: InvalidFactory,
): AdminChangelogItemInput {
  const object = strictObject(
    value,
    path,
    ["category", "area", "title", "description", "sortOrder"],
    invalid,
  );
  return {
    category: enumValue(
      required(object, "category", path, invalid),
      `${path}.category`,
      CHANGELOG_CATEGORIES,
      invalid,
    ),
    area: nullableString(
      required(object, "area", path, invalid),
      `${path}.area`,
      100,
      invalid,
    ),
    title: stringValue(
      required(object, "title", path, invalid),
      `${path}.title`,
      { minLength: 1, maxLength: 240, nonBlank: true },
      invalid,
    ),
    description: stringValue(
      required(object, "description", path, invalid),
      `${path}.description`,
      { minLength: 1, maxLength: 8_000, nonBlank: true },
      invalid,
    ),
    sortOrder: integerValue(
      required(object, "sortOrder", path, invalid),
      `${path}.sortOrder`,
      { minimum: 0, maximum: POSTGRES_INTEGER_MAX },
      invalid,
    ),
  };
}

function changelogItems(
  value: unknown,
  path: string,
  invalid: InvalidFactory,
): readonly AdminChangelogItemInput[] {
  const items = arrayValue(
    value,
    path,
    (item, itemPath) => changelogItem(item, itemPath, invalid),
    { maximum: MAX_CHANGELOG_ITEMS },
    invalid,
  );
  if (new Set(items.map((item) => item.sortOrder)).size !== items.length) {
    invalid(path, "sortOrder values must be unique");
  }
  return items;
}

const DRAFT_KEYS = [
  "version",
  "slug",
  "title",
  "summary",
  "gitTag",
  "commitSha",
  "releasedAt",
  "items",
] as const;

function draftFields(
  object: Record<string, unknown>,
  path: string,
  invalid: InvalidFactory,
): AdminChangelogDraftInput {
  const commitSha = nullableString(
    required(object, "commitSha", path, invalid),
    `${path}.commitSha`,
    64,
    invalid,
  );
  if (commitSha !== null && !COMMIT_SHA_PATTERN.test(commitSha)) {
    invalid(`${path}.commitSha`, "must be a full lowercase Git SHA");
  }

  return {
    version: stringValue(
      required(object, "version", path, invalid),
      `${path}.version`,
      { minLength: 1, maxLength: 64, nonBlank: true },
      invalid,
    ),
    slug: stringValue(
      required(object, "slug", path, invalid),
      `${path}.slug`,
      { minLength: 1, maxLength: 128, pattern: SLUG_PATTERN },
      invalid,
    ),
    title: stringValue(
      required(object, "title", path, invalid),
      `${path}.title`,
      { minLength: 1, maxLength: 200, nonBlank: true },
      invalid,
    ),
    summary: nullableString(
      required(object, "summary", path, invalid),
      `${path}.summary`,
      2_000,
      invalid,
    ),
    gitTag: nullableString(
      required(object, "gitTag", path, invalid),
      `${path}.gitTag`,
      256,
      invalid,
    ),
    commitSha,
    releasedAt: nullable(
      required(object, "releasedAt", path, invalid),
      `${path}.releasedAt`,
      (candidate, candidatePath) => exactTimestamp(candidate, candidatePath, invalid),
    ),
    items: changelogItems(
      required(object, "items", path, invalid),
      `${path}.items`,
      invalid,
    ),
  };
}

function parseDraft(
  value: unknown,
  path: string,
  invalid: InvalidFactory,
): AdminChangelogDraftInput {
  const object = strictObject(value, path, DRAFT_KEYS, invalid);
  return draftFields(object, path, invalid);
}

function changelogSnapshot(
  value: unknown,
  path: string,
): AdminChangelogReleaseSnapshot {
  const object = strictObject(
    value,
    path,
    [...DRAFT_KEYS, "contentSha256"],
    invalidResponse,
  );
  return {
    ...draftFields(object, path, invalidResponse),
    contentSha256: stringValue(
      required(object, "contentSha256", path, invalidResponse),
      `${path}.contentSha256`,
      { minLength: 64, maxLength: 64, pattern: SHA256_PATTERN },
      invalidResponse,
    ),
  };
}

function changelogSummary(
  value: unknown,
  path: string,
): AdminChangelogSummary {
  const object = strictObject(
    value,
    path,
    [
      "releaseId",
      "version",
      "slug",
      "status",
      "latestRevision",
      "publishedRevision",
      "hasUnpublishedChanges",
      "updatedAt",
    ],
    invalidResponse,
  );
  const status = enumValue(
    required(object, "status", path, invalidResponse),
    `${path}.status`,
    CHANGELOG_RELEASE_STATUSES,
    invalidResponse,
  );
  const latestRevision = revisionValue(
    required(object, "latestRevision", path, invalidResponse),
    `${path}.latestRevision`,
    invalidResponse,
  );
  const publishedRevision = nullable(
    required(object, "publishedRevision", path, invalidResponse),
    `${path}.publishedRevision`,
    (candidate, candidatePath) =>
      revisionValue(candidate, candidatePath, invalidResponse),
  );
  const hasUnpublishedChanges = booleanValue(
    required(object, "hasUnpublishedChanges", path, invalidResponse),
    `${path}.hasUnpublishedChanges`,
    invalidResponse,
  );
  assertPublicationState(
    path,
    status,
    latestRevision,
    publishedRevision,
    hasUnpublishedChanges,
  );

  return {
    releaseId: releaseIdValue(
      required(object, "releaseId", path, invalidResponse),
      `${path}.releaseId`,
      invalidResponse,
    ),
    version: stringValue(
      required(object, "version", path, invalidResponse),
      `${path}.version`,
      { minLength: 1, maxLength: 64, nonBlank: true },
      invalidResponse,
    ),
    slug: stringValue(
      required(object, "slug", path, invalidResponse),
      `${path}.slug`,
      { minLength: 1, maxLength: 128, pattern: SLUG_PATTERN },
      invalidResponse,
    ),
    status,
    latestRevision,
    publishedRevision,
    hasUnpublishedChanges,
    updatedAt: exactTimestamp(
      required(object, "updatedAt", path, invalidResponse),
      `${path}.updatedAt`,
      invalidResponse,
    ),
  };
}

function assertPublicationState(
  path: string,
  status: ChangelogReleaseStatus,
  latestRevision: number,
  publishedRevision: number | null,
  hasUnpublishedChanges: boolean,
): void {
  if (publishedRevision !== null && publishedRevision > latestRevision) {
    invalidResponse(
      `${path}.publishedRevision`,
      "must not exceed latestRevision",
    );
  }
  if (hasUnpublishedChanges !== (publishedRevision !== latestRevision)) {
    invalidResponse(
      `${path}.hasUnpublishedChanges`,
      "does not match the release revisions",
    );
  }
  if (
    (status === "draft" && publishedRevision !== null)
    || (status !== "draft" && publishedRevision === null)
  ) {
    invalidResponse(
      `${path}.publishedRevision`,
      "does not match the release status",
    );
  }
}

export function parseAdminChangelogListResponse(
  value: unknown,
): AdminChangelogListResponse {
  const path = "$response";
  const object = strictObject(value, path, ["releases"], invalidResponse);
  return {
    releases: arrayValue(
      required(object, "releases", path, invalidResponse),
      `${path}.releases`,
      changelogSummary,
      { maximum: MAX_ADMIN_CHANGELOG_PAGE_SIZE },
      invalidResponse,
    ),
  };
}

export const parseListAdminChangelogResponse =
  parseAdminChangelogListResponse;

export function parseAdminChangelogReleaseResponse(
  value: unknown,
): AdminChangelogReleaseDetail {
  const path = "$response";
  const object = strictObject(
    value,
    path,
    [
      "releaseId",
      "status",
      "latestRevision",
      "publishedRevision",
      "hasUnpublishedChanges",
      "firstPublishedAt",
      "lastPublishedAt",
      "latest",
      "published",
    ],
    invalidResponse,
  );
  const status = enumValue(
    required(object, "status", path, invalidResponse),
    `${path}.status`,
    CHANGELOG_RELEASE_STATUSES,
    invalidResponse,
  );
  const latestRevision = revisionValue(
    required(object, "latestRevision", path, invalidResponse),
    `${path}.latestRevision`,
    invalidResponse,
  );
  const publishedRevision = nullable(
    required(object, "publishedRevision", path, invalidResponse),
    `${path}.publishedRevision`,
    (candidate, candidatePath) =>
      revisionValue(candidate, candidatePath, invalidResponse),
  );
  const hasUnpublishedChanges = booleanValue(
    required(object, "hasUnpublishedChanges", path, invalidResponse),
    `${path}.hasUnpublishedChanges`,
    invalidResponse,
  );
  assertPublicationState(
    path,
    status,
    latestRevision,
    publishedRevision,
    hasUnpublishedChanges,
  );

  const firstPublishedAt = nullable(
    required(object, "firstPublishedAt", path, invalidResponse),
    `${path}.firstPublishedAt`,
    (candidate, candidatePath) =>
      exactTimestamp(candidate, candidatePath, invalidResponse),
  );
  const lastPublishedAt = nullable(
    required(object, "lastPublishedAt", path, invalidResponse),
    `${path}.lastPublishedAt`,
    (candidate, candidatePath) =>
      exactTimestamp(candidate, candidatePath, invalidResponse),
  );
  const published = nullable(
    required(object, "published", path, invalidResponse),
    `${path}.published`,
    changelogSnapshot,
  );

  if ((publishedRevision === null) !== (published === null)) {
    invalidResponse(
      `${path}.published`,
      "does not match publishedRevision",
    );
  }
  if (
    (firstPublishedAt === null) !== (lastPublishedAt === null)
    || (publishedRevision === null) !== (firstPublishedAt === null)
  ) {
    invalidResponse(
      `${path}.firstPublishedAt`,
      "publication timestamps do not match the release state",
    );
  }
  if (
    firstPublishedAt !== null
    && lastPublishedAt !== null
    && firstPublishedAt > lastPublishedAt
  ) {
    invalidResponse(
      `${path}.lastPublishedAt`,
      "must not precede firstPublishedAt",
    );
  }

  return {
    releaseId: releaseIdValue(
      required(object, "releaseId", path, invalidResponse),
      `${path}.releaseId`,
      invalidResponse,
    ),
    status,
    latestRevision,
    publishedRevision,
    hasUnpublishedChanges,
    firstPublishedAt,
    lastPublishedAt,
    latest: changelogSnapshot(
      required(object, "latest", path, invalidResponse),
      `${path}.latest`,
    ),
    published,
  };
}

export const parseGetAdminChangelogResponse =
  parseAdminChangelogReleaseResponse;

function mutationBase(
  value: unknown,
  path: string,
  allowedKinds: readonly string[],
  allowedKeys: readonly string[],
): { readonly object: Record<string, unknown>; readonly kind: string } {
  const object = strictObject(value, path, allowedKeys, invalidResponse);
  const kind = stringValue(
    required(object, "kind", path, invalidResponse),
    `${path}.kind`,
    { minLength: 1, maxLength: 32 },
    invalidResponse,
  );
  if (!allowedKinds.includes(kind)) {
    invalidResponse(`${path}.kind`, `must be one of: ${allowedKinds.join(", ")}`);
  }
  return { object, kind };
}

function mutationIdentity(
  object: Record<string, unknown>,
  path: string,
): {
  readonly replayed: boolean;
  readonly releaseId: string;
  readonly revision: number;
} {
  return {
    replayed: booleanValue(
      required(object, "replayed", path, invalidResponse),
      `${path}.replayed`,
      invalidResponse,
    ),
    releaseId: releaseIdValue(
      required(object, "releaseId", path, invalidResponse),
      `${path}.releaseId`,
      invalidResponse,
    ),
    revision: revisionValue(
      required(object, "revision", path, invalidResponse),
      `${path}.revision`,
      invalidResponse,
    ),
  };
}

function assertReturnedReleaseId(
  actual: string,
  expected: string | undefined,
  path: string,
): void {
  if (expected !== undefined && actual !== expected) {
    invalidResponse(path, "does not match the requested release");
  }
}

export function parseCreateAdminChangelogResponse(
  value: unknown,
): CreatedAdminChangelogResult {
  const path = "$response";
  const { object } = mutationBase(
    value,
    path,
    ["created"],
    ["kind", "replayed", "releaseId", "revision"],
  );
  return { kind: "created", ...mutationIdentity(object, path) };
}

export function parseReviseAdminChangelogResponse(
  value: unknown,
  expectedReleaseId?: string,
): RevisedAdminChangelogResult {
  const path = "$response";
  const { object, kind } = mutationBase(
    value,
    path,
    ["revised", "unchanged"],
    ["kind", "replayed", "releaseId", "revision"],
  );
  const identity = mutationIdentity(object, path);
  assertReturnedReleaseId(
    identity.releaseId,
    expectedReleaseId,
    `${path}.releaseId`,
  );
  return {
    kind: kind as RevisedAdminChangelogResult["kind"],
    ...identity,
  };
}

export function parsePublishAdminChangelogResponse(
  value: unknown,
  expectedReleaseId?: string,
): PublishedAdminChangelogResult {
  const path = "$response";
  const { object, kind } = mutationBase(
    value,
    path,
    ["published", "superseded", "unchanged"],
    ["kind", "replayed", "releaseId", "revision", "supersededRevision"],
  );
  const identity = mutationIdentity(object, path);
  assertReturnedReleaseId(
    identity.releaseId,
    expectedReleaseId,
    `${path}.releaseId`,
  );
  const supersededRevision = nullable(
    required(object, "supersededRevision", path, invalidResponse),
    `${path}.supersededRevision`,
    (candidate, candidatePath) =>
      revisionValue(candidate, candidatePath, invalidResponse),
  );
  if (
    (kind === "superseded"
      && (supersededRevision === null || supersededRevision >= identity.revision))
    || (kind !== "superseded" && supersededRevision !== null)
  ) {
    invalidResponse(
      `${path}.supersededRevision`,
      "does not match the publication result kind and revision",
    );
  }

  return kind === "superseded"
    ? {
        kind,
        ...identity,
        supersededRevision: supersededRevision as number,
      }
    : {
        kind: kind as "published" | "unchanged",
        ...identity,
        supersededRevision: null,
      };
}

export function parseUnpublishAdminChangelogResponse(
  value: unknown,
  expectedReleaseId?: string,
): UnpublishedAdminChangelogResult {
  const path = "$response";
  const { object, kind } = mutationBase(
    value,
    path,
    ["unpublished", "unchanged"],
    ["kind", "replayed", "releaseId", "revision"],
  );
  const replayed = booleanValue(
    required(object, "replayed", path, invalidResponse),
    `${path}.replayed`,
    invalidResponse,
  );
  const releaseId = releaseIdValue(
    required(object, "releaseId", path, invalidResponse),
    `${path}.releaseId`,
    invalidResponse,
  );
  assertReturnedReleaseId(releaseId, expectedReleaseId, `${path}.releaseId`);
  const rawRevision = required(object, "revision", path, invalidResponse);
  const revision = kind === "unchanged"
    ? nullable(rawRevision, `${path}.revision`, (candidate, candidatePath) =>
      revisionValue(candidate, candidatePath, invalidResponse))
    : revisionValue(rawRevision, `${path}.revision`, invalidResponse);

  return kind === "unchanged"
    ? { kind, replayed, releaseId, revision }
    : {
        kind: "unpublished",
        replayed,
        releaseId,
        revision: revision as number,
      };
}

function parseListRequest(
  request: ListAdminChangelogRequest,
): ListAdminChangelogRequest {
  const path = "$request";
  const object = strictObject(
    request,
    path,
    ["limit", "beforeReleaseId"],
    invalidRequest,
  );
  const limit = object.limit === undefined
    ? undefined
    : integerValue(
      object.limit,
      `${path}.limit`,
      { minimum: 1, maximum: MAX_ADMIN_CHANGELOG_PAGE_SIZE },
      invalidRequest,
    );
  const beforeReleaseId = object.beforeReleaseId === undefined
    ? undefined
    : nullable(
      object.beforeReleaseId,
      `${path}.beforeReleaseId`,
      (candidate, candidatePath) =>
        releaseIdValue(candidate, candidatePath, invalidRequest),
    );
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(beforeReleaseId === undefined ? {} : { beforeReleaseId }),
  };
}

export function adminChangelogListPath(
  request: ListAdminChangelogRequest = {},
): string {
  const parsed = parseListRequest(request);
  const query = new URLSearchParams();
  if (parsed.limit !== undefined) query.set("limit", String(parsed.limit));
  if (parsed.beforeReleaseId !== undefined && parsed.beforeReleaseId !== null) {
    query.set("beforeReleaseId", parsed.beforeReleaseId);
  }
  const serialized = query.toString();
  return serialized === ""
    ? ADMIN_CHANGELOG_PATH
    : `${ADMIN_CHANGELOG_PATH}?${serialized}`;
}

export function adminChangelogReleasePath(releaseId: string): string {
  const parsed = releaseIdValue(
    releaseId,
    "$request.releaseId",
    invalidRequest,
  );
  return `${ADMIN_CHANGELOG_PATH}/${encodeURIComponent(parsed)}`;
}

function parseReviseRequest(
  value: ReviseAdminChangelogRequest,
): ReviseAdminChangelogRequest {
  const path = "$request";
  const object = strictObject(
    value,
    path,
    ["expectedRevision", ...DRAFT_KEYS],
    invalidRequest,
  );
  return {
    expectedRevision: revisionValue(
      required(object, "expectedRevision", path, invalidRequest),
      `${path}.expectedRevision`,
      invalidRequest,
    ),
    ...draftFields(object, path, invalidRequest),
  };
}

function parsePublishRequest(
  value: PublishAdminChangelogRequest,
): PublishAdminChangelogRequest {
  const path = "$request";
  const object = strictObject(value, path, ["expectedRevision"], invalidRequest);
  return {
    expectedRevision: revisionValue(
      required(object, "expectedRevision", path, invalidRequest),
      `${path}.expectedRevision`,
      invalidRequest,
    ),
  };
}

function parseUnpublishRequest(
  value: UnpublishAdminChangelogRequest,
): UnpublishAdminChangelogRequest {
  const path = "$request";
  const object = strictObject(
    value,
    path,
    ["expectedPublishedRevision"],
    invalidRequest,
  );
  return {
    expectedPublishedRevision: revisionValue(
      required(object, "expectedPublishedRevision", path, invalidRequest),
      `${path}.expectedPublishedRevision`,
      invalidRequest,
    ),
  };
}

function idempotencyKeyValue(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    return invalidRequest(
      "$request.idempotencyKey",
      "must be 16-128 governance-safe characters",
    );
  }
  return value;
}

export function createAdminChangelogIdempotencyKey(
  operation: AdminChangelogMutationOperation,
): string {
  if (!(ADMIN_CHANGELOG_MUTATION_OPERATIONS as readonly string[]).includes(operation)) {
    throw new TypeError("operation is not a supported admin changelog mutation");
  }
  const key = `admin-changelog:${operation}:${crypto.randomUUID()}`;
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new TypeError("generated idempotency key has an invalid format");
  }
  return key;
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

function accessFailure(error: ApiError): AdminChangelogAccessFailure | null {
  if (error.status === 401 && error.code === "authentication_required") {
    return { kind: "auth-expired" };
  }
  if (error.status === 401 && error.code === "reauthentication_required") {
    return { kind: "reauthentication-required" };
  }
  if (error.status === 403 && error.code === "authorization_denied") {
    return { kind: "denied" };
  }
  if (error.status === 404) return { kind: "not-found" };
  return null;
}

function conflictFailure(
  error: ApiError,
  operation: AdminChangelogMutationOperation,
): AdminChangelogConflictResult | null {
  if (
    error.status !== 409
    || error.code !== "invalid_request"
    || error.details === null
  ) {
    return null;
  }

  try {
    const path = "$error.details";
    const broad = strictObject(
      error.details,
      path,
      ["reason", "actualRevision"],
      invalidResponse,
    );
    const reason = enumValue(
      required(broad, "reason", path, invalidResponse),
      `${path}.reason`,
      [
        "identity_locked",
        "revision_conflict",
        "version",
        "slug",
        "version_and_slug",
      ] as const,
      invalidResponse,
    );

    if (reason === "identity_locked") {
      if (operation !== "revise") return null;
      const object = strictObject(
        error.details,
        path,
        ["reason", "actualRevision"],
        invalidResponse,
      );
      return {
        kind: "identity-conflict",
        actualRevision: revisionValue(
          required(object, "actualRevision", path, invalidResponse),
          `${path}.actualRevision`,
          invalidResponse,
        ),
      };
    }
    if (reason === "revision_conflict") {
      if (operation === "create") return null;
      const object = strictObject(
        error.details,
        path,
        ["reason", "actualRevision"],
        invalidResponse,
      );
      return {
        kind: "revision-conflict",
        actualRevision: revisionValue(
          required(object, "actualRevision", path, invalidResponse),
          `${path}.actualRevision`,
          invalidResponse,
        ),
      };
    }
    if (operation !== "create" && operation !== "revise") return null;
    strictObject(error.details, path, ["reason"], invalidResponse);
    if (reason === "version") return { kind: "version-conflict" };
    if (reason === "slug") return { kind: "slug-conflict" };
    return { kind: "version-and-slug-conflict" };
  } catch {
    return null;
  }
}

function notPublishableFailure(
  error: ApiError,
  operation: AdminChangelogMutationOperation,
): AdminChangelogNotPublishableResult | null {
  if (
    operation !== "publish"
    || error.status !== 422
    || error.code !== "invalid_request"
    || error.details === null
  ) {
    return null;
  }

  try {
    const path = "$error.details";
    const object = strictObject(
      error.details,
      path,
      ["reason", "reasons"],
      invalidResponse,
    );
    if (required(object, "reason", path, invalidResponse) !== "not_publishable") {
      return null;
    }
    const reasons = arrayValue(
      required(object, "reasons", path, invalidResponse),
      `${path}.reasons`,
      (reason, reasonPath) =>
        enumValue(
          reason,
          reasonPath,
          CHANGELOG_PUBLISHABILITY_REASONS,
          invalidResponse,
        ),
      { minimum: 1, maximum: CHANGELOG_PUBLISHABILITY_REASONS.length },
      invalidResponse,
    );
    if (new Set(reasons).size !== reasons.length) return null;
    return { kind: "not-publishable", reasons };
  } catch {
    return null;
  }
}

function degraded(message: string): AdminChangelogDegradedResult {
  return { kind: "degraded", message };
}

function readFailure(error: unknown): AdminChangelogAccessFailure | AdminChangelogDegradedResult {
  if (error instanceof ApiError) {
    const access = accessFailure(error);
    if (access !== null) return access;
    return degraded(
      "Relay could not load the admin changelog. No changelog data was changed.",
    );
  }
  if (error instanceof InvalidAdminChangelogResponseError || error instanceof SyntaxError) {
    return degraded(
      "Relay returned an unreadable admin changelog response. No changelog data was shown.",
    );
  }
  if (error instanceof InvalidAdminChangelogRequestError) {
    return degraded(
      "Relay could not prepare the admin changelog request. Review the fields and try again.",
    );
  }
  return degraded(
    error instanceof TypeError
      ? "Relay could not reach the admin changelog service. Check the connection and try again."
      : "Relay could not load the admin changelog. No changelog data was changed.",
  );
}

function mutationHttpFailure(
  error: ApiError,
  operation: AdminChangelogMutationOperation,
): AdminChangelogMutationFailure {
  if (error.status >= 500) return unknownOutcome(operation);
  const access = accessFailure(error);
  if (access !== null) return access;
  if (error.status === 409 && error.code === "idempotency_conflict") {
    return { kind: "idempotency-conflict" };
  }
  const conflict = conflictFailure(error, operation);
  if (conflict !== null) return conflict;
  const notPublishable = notPublishableFailure(error, operation);
  if (notPublishable !== null) return notPublishable;
  return degraded(
    "Relay rejected the admin changelog mutation. No automatic retry was attempted.",
  );
}

function unknownOutcome(
  operation: AdminChangelogMutationOperation,
): AdminChangelogUnknownOutcomeResult {
  return {
    kind: "unknown-outcome",
    message: `Relay could not confirm the ${operation} result. Do not retry with a new idempotency key; reload the changelog state first.`,
  };
}

async function executeMutation<T>(
  operation: AdminChangelogMutationOperation,
  path: string,
  method: "PATCH" | "POST",
  body: unknown,
  idempotencyKey: string,
  parser: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<T | AdminChangelogMutationFailure> {
  try {
    const response = await fetchJson<unknown>(path, {
      method,
      cache: "no-store",
      signal,
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    return parser(response);
  } catch (error) {
    if (error instanceof ApiError) return mutationHttpFailure(error, operation);
    return unknownOutcome(operation);
  }
}

function invalidMutationRequest(): AdminChangelogDegradedResult {
  return degraded(
    "Relay could not prepare the admin changelog mutation. Review the fields and try again.",
  );
}

export const httpAdminChangelogAdapter: AdminChangelogAdapter = {
  async list(request = {}, signal) {
    try {
      const response = await fetchJson<unknown>(adminChangelogListPath(request), {
        cache: "no-store",
        signal,
      });
      const parsed = parseAdminChangelogListResponse(response);
      return { kind: "ok", releases: parsed.releases };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return readFailure(error);
    }
  },

  async get(releaseId, signal) {
    try {
      const response = await fetchJson<unknown>(
        adminChangelogReleasePath(releaseId),
        { cache: "no-store", signal },
      );
      return {
        kind: "found",
        release: parseAdminChangelogReleaseResponse(response),
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return readFailure(error);
    }
  },

  async create(input, idempotencyKey, signal) {
    let parsedInput: AdminChangelogDraftInput;
    let parsedKey: string;
    try {
      parsedInput = parseDraft(input, "$request", invalidRequest);
      parsedKey = idempotencyKeyValue(idempotencyKey);
    } catch {
      return invalidMutationRequest();
    }
    return executeMutation(
      "create",
      ADMIN_CHANGELOG_PATH,
      "POST",
      parsedInput,
      parsedKey,
      parseCreateAdminChangelogResponse,
      signal,
    );
  },

  async revise(releaseId, request, idempotencyKey, signal) {
    let path: string;
    let parsedRequest: ReviseAdminChangelogRequest;
    let parsedKey: string;
    try {
      path = adminChangelogReleasePath(releaseId);
      parsedRequest = parseReviseRequest(request);
      parsedKey = idempotencyKeyValue(idempotencyKey);
    } catch {
      return invalidMutationRequest();
    }
    return executeMutation(
      "revise",
      path,
      "PATCH",
      parsedRequest,
      parsedKey,
      (response) => parseReviseAdminChangelogResponse(response, releaseId),
      signal,
    );
  },

  async publish(releaseId, request, idempotencyKey, signal) {
    let path: string;
    let parsedRequest: PublishAdminChangelogRequest;
    let parsedKey: string;
    try {
      path = `${adminChangelogReleasePath(releaseId)}/publish`;
      parsedRequest = parsePublishRequest(request);
      parsedKey = idempotencyKeyValue(idempotencyKey);
    } catch {
      return invalidMutationRequest();
    }
    return executeMutation(
      "publish",
      path,
      "POST",
      parsedRequest,
      parsedKey,
      (response) => parsePublishAdminChangelogResponse(response, releaseId),
      signal,
    );
  },

  async unpublish(releaseId, request, idempotencyKey, signal) {
    let path: string;
    let parsedRequest: UnpublishAdminChangelogRequest;
    let parsedKey: string;
    try {
      path = `${adminChangelogReleasePath(releaseId)}/unpublish`;
      parsedRequest = parseUnpublishRequest(request);
      parsedKey = idempotencyKeyValue(idempotencyKey);
    } catch {
      return invalidMutationRequest();
    }
    return executeMutation(
      "unpublish",
      path,
      "POST",
      parsedRequest,
      parsedKey,
      (response) => parseUnpublishAdminChangelogResponse(response, releaseId),
      signal,
    );
  },
};
