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
}

export type ChangelogLoadResult =
  | { readonly kind: "empty" }
  | { readonly kind: "populated"; readonly releases: readonly ChangelogRelease[] }
  | { readonly kind: "degraded"; readonly message: string };

export interface ChangelogAdapter {
  load(signal?: AbortSignal): Promise<ChangelogLoadResult>;
}

class InvalidChangelogResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChangelogResponseError";
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidChangelogResponseError(`Invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidChangelogResponseError(`Invalid ${field}`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, field);
}

function nullableTimestamp(value: unknown, field: string): string | null {
  const timestamp = nullableString(value, field);
  if (timestamp !== null && !Number.isFinite(Date.parse(timestamp))) {
    throw new InvalidChangelogResponseError(`Invalid ${field}`);
  }
  return timestamp;
}

function changelogCategory(value: unknown, field: string): ChangelogCategory {
  if (
    typeof value !== "string" ||
    !(CHANGELOG_CATEGORIES as readonly string[]).includes(value)
  ) {
    throw new InvalidChangelogResponseError(`Invalid ${field}`);
  }
  return value as ChangelogCategory;
}

function changelogItem(value: unknown, index: number): ChangelogItem {
  const item = asRecord(value, `entries[].items[${index}]`);
  if (typeof item.sortOrder !== "number" || !Number.isSafeInteger(item.sortOrder)) {
    throw new InvalidChangelogResponseError(`Invalid entries[].items[${index}].sortOrder`);
  }

  return {
    category: changelogCategory(item.category, `entries[].items[${index}].category`),
    area: nullableString(item.area, `entries[].items[${index}].area`),
    title: requiredString(item.title, `entries[].items[${index}].title`),
    description: requiredString(item.description, `entries[].items[${index}].description`),
    sortOrder: item.sortOrder,
  };
}

function changelogRelease(value: unknown, index: number): ChangelogRelease {
  const release = asRecord(value, `entries[${index}]`);
  if (!Array.isArray(release.items) || release.items.length === 0) {
    throw new InvalidChangelogResponseError(`Invalid entries[${index}].items`);
  }

  return {
    version: requiredString(release.version, `entries[${index}].version`),
    slug: requiredString(release.slug, `entries[${index}].slug`),
    title: requiredString(release.title, `entries[${index}].title`),
    summary: nullableString(release.summary, `entries[${index}].summary`),
    gitTag: nullableString(release.gitTag, `entries[${index}].gitTag`),
    commitSha: nullableString(release.commitSha, `entries[${index}].commitSha`),
    releasedAt: nullableTimestamp(release.releasedAt, `entries[${index}].releasedAt`),
    items: release.items.map(changelogItem),
  };
}

function parseChangelogResponse(value: unknown): readonly ChangelogRelease[] {
  const page = asRecord(value, "changelog response");
  if (!Array.isArray(page.entries)) {
    throw new InvalidChangelogResponseError("Invalid changelog response entries");
  }
  return page.entries.map(changelogRelease);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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

      if (error instanceof InvalidChangelogResponseError) {
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
};
