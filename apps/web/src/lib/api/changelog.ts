import { ApiError, fetchJson } from "./client";

export const CHANGELOG_CATEGORIES = [
  "added",
  "improved",
  "fixed",
  "security",
  "breaking",
] as const;

export type ChangelogCategory = typeof CHANGELOG_CATEGORIES[number];

export interface ChangelogItem {
  readonly category: ChangelogCategory;
  readonly area: string | null;
  readonly title: string;
  readonly description: string;
  readonly sortOrder: number;
}

export interface ChangelogRelease {
  readonly version: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly gitTag: string | null;
  readonly commitSha: string | null;
  readonly releasedAt: string | null;
  readonly items: readonly ChangelogItem[];
  readonly contentSha256: string;
  readonly revision: number;
  readonly publishedAt: string;
}

export type ChangelogLoadResult =
  | { readonly kind: "empty" }
  | { readonly kind: "populated"; readonly releases: readonly ChangelogRelease[] }
  | { readonly kind: "degraded"; readonly message: string };

export type ChangelogEntryLoadResult =
  | { readonly kind: "found"; readonly release: ChangelogRelease }
  | { readonly kind: "not-found" }
  | { readonly kind: "degraded"; readonly message: string };

export interface ChangelogAdapter {
  load(signal?: AbortSignal): Promise<ChangelogLoadResult>;
  loadEntry(slug: string, signal?: AbortSignal): Promise<ChangelogEntryLoadResult>;
}

export class InvalidChangelogResponseError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChangelogResponseError";
  }
}

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_CHANGELOG_ITEMS = 200;
const MAX_CURSOR_LENGTH = 2_048;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_UTC_MILLISECOND_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isChangelogSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function publicChangelogEntryPath(slug: string): string {
  return `/api/v1/changelog/${encodeURIComponent(slug)}`;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidChangelogResponseError(`Invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  field: string,
  expectedFields: readonly string[],
): Record<string, unknown> {
  const record = asRecord(value, field);
  const actualFields = Object.keys(record);
  if (
    actualFields.length !== expectedFields.length
    || actualFields.some((key) => !expectedFields.includes(key))
  ) {
    throw new InvalidChangelogResponseError(`Invalid ${field} fields`);
  }
  return record;
}

function requiredString(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maximumLength
  ) {
    throw new InvalidChangelogResponseError(`Invalid ${field}`);
  }
  return value;
}

function nullableString(
  value: unknown,
  field: string,
  maximumLength: number,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new InvalidChangelogResponseError(`Invalid ${field}`);
  }
  return value;
}

function exactTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field, 64);
  const parsed = Date.parse(timestamp);
  if (
    !ISO_UTC_MILLISECOND_PATTERN.test(timestamp)
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== timestamp
  ) {
    throw new InvalidChangelogResponseError(`Invalid ${field}`);
  }
  return timestamp;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : exactTimestamp(value, field);
}

function changelogCategory(value: unknown, field: string): ChangelogCategory {
  if (
    typeof value !== "string"
    || !(CHANGELOG_CATEGORIES as readonly string[]).includes(value)
  ) {
    throw new InvalidChangelogResponseError(`Invalid ${field}`);
  }
  return value as ChangelogCategory;
}

function changelogItem(value: unknown, index: number): ChangelogItem {
  const field = `release.items[${index}]`;
  const item = exactRecord(value, field, [
    "category",
    "area",
    "title",
    "description",
    "sortOrder",
  ]);
  if (
    typeof item.sortOrder !== "number"
    || !Number.isSafeInteger(item.sortOrder)
    || item.sortOrder < 0
    || item.sortOrder > POSTGRES_INTEGER_MAX
  ) {
    throw new InvalidChangelogResponseError(`Invalid ${field}.sortOrder`);
  }

  return {
    category: changelogCategory(item.category, `${field}.category`),
    area: nullableString(item.area, `${field}.area`, 100),
    title: requiredString(item.title, `${field}.title`, 240),
    description: requiredString(item.description, `${field}.description`, 8_000),
    sortOrder: item.sortOrder,
  };
}

export function parseChangelogRelease(value: unknown): ChangelogRelease {
  const release = exactRecord(value, "release", [
    "version",
    "slug",
    "title",
    "summary",
    "gitTag",
    "commitSha",
    "releasedAt",
    "items",
    "contentSha256",
    "revision",
    "publishedAt",
  ]);
  if (
    !Array.isArray(release.items)
    || release.items.length === 0
    || release.items.length > MAX_CHANGELOG_ITEMS
  ) {
    throw new InvalidChangelogResponseError("Invalid release.items");
  }

  const slug = requiredString(release.slug, "release.slug", 128);
  if (!isChangelogSlug(slug)) {
    throw new InvalidChangelogResponseError("Invalid release.slug");
  }
  const commitSha = nullableString(release.commitSha, "release.commitSha", 64);
  if (commitSha !== null && !COMMIT_SHA_PATTERN.test(commitSha)) {
    throw new InvalidChangelogResponseError("Invalid release.commitSha");
  }
  const contentSha256 = requiredString(
    release.contentSha256,
    "release.contentSha256",
    64,
  );
  if (!SHA256_PATTERN.test(contentSha256)) {
    throw new InvalidChangelogResponseError("Invalid release.contentSha256");
  }
  if (
    typeof release.revision !== "number"
    || !Number.isSafeInteger(release.revision)
    || release.revision < 1
    || release.revision > POSTGRES_INTEGER_MAX
  ) {
    throw new InvalidChangelogResponseError("Invalid release.revision");
  }

  const items = release.items.map(changelogItem);
  if (new Set(items.map((item) => item.sortOrder)).size !== items.length) {
    throw new InvalidChangelogResponseError("Invalid release.items sort order");
  }

  return {
    version: requiredString(release.version, "release.version", 64),
    slug,
    title: requiredString(release.title, "release.title", 200),
    summary: nullableString(release.summary, "release.summary", 2_000),
    gitTag: nullableString(release.gitTag, "release.gitTag", 256),
    commitSha,
    releasedAt: nullableTimestamp(release.releasedAt, "release.releasedAt"),
    items,
    contentSha256,
    revision: release.revision,
    publishedAt: exactTimestamp(release.publishedAt, "release.publishedAt"),
  };
}

function parseChangelogResponse(value: unknown): readonly ChangelogRelease[] {
  const page = exactRecord(value, "changelog response", ["entries", "nextCursor"]);
  if (!Array.isArray(page.entries) || page.entries.length > 100) {
    throw new InvalidChangelogResponseError("Invalid changelog response entries");
  }
  if (
    page.nextCursor !== null
    && (
      typeof page.nextCursor !== "string"
      || page.nextCursor.length === 0
      || page.nextCursor.length > MAX_CURSOR_LENGTH
    )
  ) {
    throw new InvalidChangelogResponseError("Invalid changelog response nextCursor");
  }
  return page.entries.map(parseChangelogRelease);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function unreadableResponse(error: unknown): boolean {
  return error instanceof InvalidChangelogResponseError
    || error instanceof SyntaxError;
}

export const httpChangelogAdapter: ChangelogAdapter = {
  async load(signal) {
    try {
      const response = await fetchJson<unknown>("/api/v1/changelog", { signal });
      const releases = parseChangelogResponse(response);
      return releases.length === 0
        ? { kind: "empty" }
        : { kind: "populated", releases };
    } catch (error) {
      if (isAbortError(error)) throw error;

      if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
        return {
          kind: "degraded",
          message: "Published release notes are not available from this deployment yet.",
        };
      }

      if (unreadableResponse(error)) {
        return {
          kind: "degraded",
          message: "Relay returned an unreadable changelog response. No release information was shown.",
        };
      }

      return {
        kind: "degraded",
        message: error instanceof TypeError
          ? "Relay could not reach the changelog service. Check the connection and try again."
          : "Relay could not load published release notes. No release information was shown.",
      };
    }
  },

  async loadEntry(slug, signal) {
    if (!isChangelogSlug(slug)) return { kind: "not-found" };

    try {
      const response = await fetchJson<unknown>(publicChangelogEntryPath(slug), {
        signal,
      });
      const release = parseChangelogRelease(response);
      if (release.slug !== slug) {
        throw new InvalidChangelogResponseError("Release slug did not match the request");
      }
      return { kind: "found", release };
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ApiError && error.status === 404) {
        return { kind: "not-found" };
      }
      if (error instanceof ApiError && error.status === 501) {
        return {
          kind: "degraded",
          message: "Published release details are not available from this deployment yet.",
        };
      }
      if (unreadableResponse(error)) {
        return {
          kind: "degraded",
          message: "Relay returned an unreadable release response. No release information was shown.",
        };
      }
      return {
        kind: "degraded",
        message: error instanceof TypeError
          ? "Relay could not reach the changelog service. Check the connection and try again."
          : "Relay could not load this published release. No release information was shown.",
      };
    }
  },
};
