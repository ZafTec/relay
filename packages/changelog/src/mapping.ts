import type {
  AdminChangelogRelease,
  AdminChangelogRevision,
  AdminChangelogSummary,
  ChangelogCategory,
  ChangelogItemInput,
  ChangelogRevision,
  LegalAcceptanceScope,
  LegalDocument,
  PublishedChangelogRelease,
} from "./types.ts";
import { CHANGELOG_CATEGORIES, LEGAL_ACCEPTANCE_SCOPES } from "./types.ts";

export function isoTimestamp(value: unknown, field: string): string {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new Error(`Database returned invalid ${field}`);
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Database returned invalid ${field}`);
  }
  return parsed.toISOString();
}

export function nullableIsoTimestamp(
  value: unknown,
  field: string,
): string | null {
  return value === null ? null : isoTimestamp(value, field);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Database returned invalid ${field}`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : stringValue(value, field);
}

function integerValue(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`Database returned invalid ${field}`);
  }
  return result;
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integerValue(value, field);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Database returned invalid ${field}`);
  }
  return value;
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Database returned invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

export function mapChangelogItems(
  value: unknown,
): readonly ChangelogItemInput[] {
  if (!Array.isArray(value)) throw new Error("Database returned invalid items");
  return value.map((item, index) => {
    const row = recordValue(item, `items[${index}]`);
    const category = stringValue(row.category, `items[${index}].category`);
    if (!(CHANGELOG_CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(`Database returned invalid items[${index}].category`);
    }
    return {
      category: category as ChangelogCategory,
      area: nullableString(row.area, `items[${index}].area`),
      title: stringValue(row.title, `items[${index}].title`),
      description: stringValue(
        row.description,
        `items[${index}].description`,
      ),
      sortOrder: integerValue(row.sortOrder, `items[${index}].sortOrder`),
    };
  });
}

export function mapChangelogRevision(value: unknown): ChangelogRevision {
  const row = recordValue(value, "changelog revision");
  return {
    version: stringValue(row.version, "version"),
    slug: stringValue(row.slug, "slug"),
    title: stringValue(row.title, "title"),
    summary: nullableString(row.summary, "summary"),
    gitTag: nullableString(row.gitTag, "gitTag"),
    commitSha: nullableString(row.commitSha, "commitSha"),
    releasedAt: nullableIsoTimestamp(row.releasedAt, "releasedAt"),
    items: mapChangelogItems(row.items),
    contentSha256: stringValue(row.contentSha256, "contentSha256"),
  };
}

export interface PublicChangelogRow extends Record<string, unknown> {
  release_id: string;
  revision: number;
  snapshot: unknown;
  published_at: Date | string;
}

export function mapPublishedChangelogRow(
  row: PublicChangelogRow,
): PublishedChangelogRelease {
  return {
    ...mapChangelogRevision(row.snapshot),
    revision: integerValue(row.revision, "revision"),
    publishedAt: isoTimestamp(row.published_at, "publishedAt"),
  };
}

export interface AdminSummaryRow extends Record<string, unknown> {
  release_id: string;
  version: string;
  slug: string;
  status: string;
  latest_revision: number;
  published_revision: number | null;
  has_unpublished_changes: boolean;
  updated_at: Date | string;
}

export function mapAdminSummary(row: AdminSummaryRow): AdminChangelogSummary {
  if (!["draft", "published", "archived"].includes(row.status)) {
    throw new Error("Database returned invalid changelog status");
  }
  return {
    releaseId: stringValue(row.release_id, "releaseId"),
    version: stringValue(row.version, "version"),
    slug: stringValue(row.slug, "slug"),
    status: row.status as AdminChangelogSummary["status"],
    latestRevision: integerValue(row.latest_revision, "latestRevision"),
    publishedRevision: nullableInteger(
      row.published_revision,
      "publishedRevision",
    ),
    hasUnpublishedChanges: booleanValue(
      row.has_unpublished_changes,
      "hasUnpublishedChanges",
    ),
    updatedAt: isoTimestamp(row.updated_at, "updatedAt"),
  };
}

export function mapAdminRelease(value: unknown): AdminChangelogRelease {
  const row = recordValue(value, "admin changelog release");
  const status = stringValue(row.status, "status");
  if (!["draft", "published", "archived"].includes(status)) {
    throw new Error("Database returned invalid changelog status");
  }
  return {
    releaseId: stringValue(row.releaseId, "releaseId"),
    status: status as AdminChangelogRelease["status"],
    latestRevision: integerValue(row.latestRevision, "latestRevision"),
    publishedRevision: nullableInteger(
      row.publishedRevision,
      "publishedRevision",
    ),
    hasUnpublishedChanges: booleanValue(
      row.hasUnpublishedChanges,
      "hasUnpublishedChanges",
    ),
    firstPublishedAt: nullableIsoTimestamp(
      row.firstPublishedAt,
      "firstPublishedAt",
    ),
    lastPublishedAt: nullableIsoTimestamp(
      row.lastPublishedAt,
      "lastPublishedAt",
    ),
    latest: mapChangelogRevision(row.latest),
    published: row.published === null
      ? null
      : mapChangelogRevision(row.published),
  };
}

export interface AdminRevisionRow extends Record<string, unknown> {
  revision: number;
  snapshot: unknown;
  changed_by: string | null;
  changed_at: Date | string;
}

export function mapAdminRevision(
  row: AdminRevisionRow,
): AdminChangelogRevision {
  return {
    ...mapChangelogRevision(row.snapshot),
    revision: integerValue(row.revision, "revision"),
    changedBy: nullableString(row.changed_by, "changedBy"),
    changedAt: isoTimestamp(row.changed_at, "changedAt"),
  };
}

export interface LegalDocumentRow extends Record<string, unknown> {
  document_id: string;
  document_type: string;
  version: string;
  revision: number;
  effective_at: Date | string;
  canonical_url: string;
  content_sha256: string;
  requires_acceptance: boolean;
  acceptance_scope: string;
  record_sha256: string;
  published_at: Date | string | null;
}

export function mapLegalDocument(row: LegalDocumentRow): LegalDocument {
  if (
    !(LEGAL_ACCEPTANCE_SCOPES as readonly string[]).includes(
      row.acceptance_scope,
    )
  ) {
    throw new Error("Database returned invalid legal acceptance scope");
  }
  return {
    documentId: stringValue(row.document_id, "documentId"),
    documentType: stringValue(row.document_type, "documentType"),
    version: stringValue(row.version, "version"),
    revision: integerValue(row.revision, "revision"),
    effectiveAt: isoTimestamp(row.effective_at, "effectiveAt"),
    canonicalUrl: stringValue(row.canonical_url, "canonicalUrl"),
    contentSha256: stringValue(row.content_sha256, "contentSha256"),
    requiresAcceptance: booleanValue(
      row.requires_acceptance,
      "requiresAcceptance",
    ),
    acceptanceScope: row.acceptance_scope as LegalAcceptanceScope,
    recordSha256: stringValue(row.record_sha256, "recordSha256"),
    publishedAt: nullableIsoTimestamp(row.published_at, "publishedAt"),
  };
}

export function mutationResult<T extends { readonly kind: string }>(
  value: unknown,
): T {
  const row = recordValue(value, "mutation result");
  if (typeof row.kind !== "string" || typeof row.replayed !== "boolean") {
    throw new Error("Database returned an invalid mutation result");
  }
  return row as T;
}
