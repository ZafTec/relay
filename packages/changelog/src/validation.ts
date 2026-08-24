import {
  CHANGELOG_CATEGORIES,
  type ChangelogDraftInput,
  type ChangelogItemInput,
  type GovernanceMutationContext,
  LEGAL_ACCEPTANCE_SCOPES,
  type LegalDocumentInput,
} from "./types.ts";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DOCUMENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const SAFE_HTTPS_AUTHORITY_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/u;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function hasUnsafeUrlInput(value: string): boolean {
  return value.includes("\\") || [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x20 || codePoint === 0x7f;
  });
}

export interface NormalizedChangelogDraft {
  readonly version: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly gitTag: string | null;
  readonly commitSha: string | null;
  readonly releasedAt: string | null;
  readonly items: readonly {
    readonly category: string;
    readonly area: string | null;
    readonly title: string;
    readonly description: string;
    readonly sortOrder: number;
  }[];
}

export interface NormalizedLegalDocument {
  readonly documentType: string;
  readonly version: string;
  readonly effectiveAt: string;
  readonly canonicalUrl: string;
  readonly contentSha256: string;
  readonly requiresAcceptance: boolean;
  readonly acceptanceScope: "user" | "workspace";
}

function requiredText(
  value: string,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must not be empty`);
  }
  if (value.length > maxLength) {
    throw new TypeError(`${field} must be at most ${maxLength} characters`);
  }
  return value;
}

function optionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (value.length > maxLength) {
    throw new TypeError(`${field} must be at most ${maxLength} characters`);
  }
  return value;
}

function timestamp(
  value: string | Date | null | undefined,
  field: string,
  optional: boolean,
): string | null {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new TypeError(`${field} is required`);
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function normalizeItem(
  item: ChangelogItemInput,
  index: number,
): NormalizedChangelogDraft["items"][number] {
  if (!(CHANGELOG_CATEGORIES as readonly string[]).includes(item.category)) {
    throw new TypeError(`items[${index}].category is invalid`);
  }
  if (!Number.isSafeInteger(item.sortOrder) || item.sortOrder < 0) {
    throw new TypeError(
      `items[${index}].sortOrder must be a non-negative safe integer`,
    );
  }
  return {
    category: item.category,
    area: optionalText(item.area, `items[${index}].area`, 100),
    title: requiredText(item.title, `items[${index}].title`, 240),
    description: requiredText(
      item.description,
      `items[${index}].description`,
      8_000,
    ),
    sortOrder: item.sortOrder,
  };
}

export function normalizeChangelogDraft(
  input: ChangelogDraftInput,
): NormalizedChangelogDraft {
  const version = requiredText(input.version, "version", 64);
  const slug = requiredText(input.slug, "slug", 128);
  if (!SLUG_PATTERN.test(slug)) {
    throw new TypeError(
      "slug must contain lowercase letters, digits, and interior hyphens only",
    );
  }
  const commitSha = optionalText(input.commitSha, "commitSha", 64);
  if (commitSha !== null && !COMMIT_SHA_PATTERN.test(commitSha)) {
    throw new TypeError("commitSha must be a full lowercase Git SHA");
  }
  if (!Array.isArray(input.items) || input.items.length > 200) {
    throw new TypeError("items must contain at most 200 entries");
  }
  const items = input.items.map(normalizeItem);
  if (new Set(items.map((item) => item.sortOrder)).size !== items.length) {
    throw new TypeError("item sortOrder values must be unique");
  }
  return {
    version,
    slug,
    title: requiredText(input.title, "title", 200),
    summary: optionalText(input.summary, "summary", 2_000),
    gitTag: optionalText(input.gitTag, "gitTag", 256),
    commitSha,
    releasedAt: timestamp(input.releasedAt, "releasedAt", true),
    items,
  };
}

export function isValidSemver(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

export function assertPublishableDraft(
  draft: NormalizedChangelogDraft,
): void {
  const reasons: string[] = [];
  if (!isValidSemver(draft.version)) reasons.push("invalid_version");
  if (draft.gitTag === null || draft.gitTag.trim() === "") {
    reasons.push("missing_git_tag");
  }
  if (draft.commitSha === null) reasons.push("missing_commit_sha");
  if (draft.releasedAt === null) reasons.push("missing_released_at");
  if (draft.items.length === 0) reasons.push("missing_items");
  if (reasons.length > 0) {
    throw new TypeError(`Draft is not publishable: ${reasons.join(", ")}`);
  }
}

export function normalizeLegalDocument(
  input: LegalDocumentInput,
): NormalizedLegalDocument {
  const documentType = requiredText(input.documentType, "documentType", 64);
  if (!DOCUMENT_TYPE_PATTERN.test(documentType)) {
    throw new TypeError(
      "documentType must start with a lowercase letter and contain lowercase letters, digits, dot, underscore, or hyphen",
    );
  }
  const version = requiredText(input.version, "version", 128);
  const canonicalUrlInput = requiredText(
    input.canonicalUrl,
    "canonicalUrl",
    2_048,
  );
  let canonicalUrl: URL;
  try {
    canonicalUrl = new URL(canonicalUrlInput);
  } catch {
    throw new TypeError("canonicalUrl must be a safe absolute HTTPS URL");
  }
  const serializedCanonicalUrl = canonicalUrl.toString();
  if (
    canonicalUrl.protocol !== "https:" || canonicalUrl.username !== "" ||
    canonicalUrl.password !== "" || canonicalUrl.hash !== "" ||
    !SAFE_HTTPS_AUTHORITY_PATTERN.test(canonicalUrl.host) ||
    hasUnsafeUrlInput(canonicalUrlInput) ||
    serializedCanonicalUrl.length > 2_048
  ) {
    throw new TypeError(
      "canonicalUrl must be a safe absolute HTTPS URL without userinfo or a fragment",
    );
  }
  if (!SHA256_PATTERN.test(input.contentSha256)) {
    throw new TypeError("contentSha256 must be a lowercase SHA-256 digest");
  }
  const acceptanceScope = input.acceptanceScope ?? "user";
  if (
    !(LEGAL_ACCEPTANCE_SCOPES as readonly string[]).includes(acceptanceScope)
  ) {
    throw new TypeError("acceptanceScope must be user or workspace");
  }
  return {
    documentType,
    version,
    effectiveAt: timestamp(input.effectiveAt, "effectiveAt", false)!,
    canonicalUrl: serializedCanonicalUrl,
    contentSha256: input.contentSha256,
    requiresAcceptance: input.requiresAcceptance,
    acceptanceScope,
  };
}

export function assertSessionId(value: string): void {
  requiredText(value, "sessionId", 256);
}

export function normalizeMutationContext(
  context: GovernanceMutationContext,
): Required<GovernanceMutationContext> {
  assertSessionId(context.sessionId);
  for (
    const [field, value] of [
      ["requestId", context.requestId],
      ["traceId", context.traceId],
    ] as const
  ) {
    if (
      value !== undefined && value !== null &&
      !CORRELATION_ID_PATTERN.test(value)
    ) {
      throw new TypeError(
        `${field} must contain only letters, digits, dot, underscore, colon, or hyphen`,
      );
    }
  }
  return {
    sessionId: context.sessionId,
    idempotencyKey: context.idempotencyKey,
    requestId: context.requestId ?? null,
    traceId: context.traceId ?? null,
  };
}

export function positiveIntegerString(value: string, field: string): string {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`${field} must be a positive integer string`);
  }
  return value;
}

export function positiveRevision(value: number, field = "revision"): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

export function pageLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("limit must be an integer from 1 through 100");
  }
  return limit;
}

export function optionalBoundedText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  return optionalText(value, field, maxLength);
}

export function assertDocumentType(value: string): void {
  if (!DOCUMENT_TYPE_PATTERN.test(value)) {
    throw new TypeError("documentType is invalid");
  }
}

export function assertSha256(value: string, field = "contentSha256"): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
}
