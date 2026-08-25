import {
  CHANGELOG_CATEGORIES,
  type AdminChangelogDraftInput,
  type AdminChangelogReleaseSnapshot,
  type AdminChangelogReleaseStatus,
  type ChangelogCategory,
  type ChangelogPublishabilityReason,
} from "../../lib/api/admin-changelog";

const ISO_UTC_MILLISECOND_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const POSTGRES_BIGINT_MAX = "9223372036854775807";

let editorItemSequence = 0;

export interface AdminChangelogEditorItem {
  readonly clientId: string;
  readonly category: ChangelogCategory;
  readonly area: string;
  readonly title: string;
  readonly description: string;
}

export interface AdminChangelogEditorModel {
  readonly version: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly gitTag: string;
  readonly commitSha: string;
  readonly releasedAt: string;
  readonly items: readonly AdminChangelogEditorItem[];
}

export interface AdminChangelogItemErrors {
  readonly category?: string;
  readonly area?: string;
  readonly title?: string;
  readonly description?: string;
}

export interface AdminChangelogValidationErrors {
  readonly version?: string;
  readonly slug?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly gitTag?: string;
  readonly commitSha?: string;
  readonly releasedAt?: string;
  readonly items?: string;
  readonly itemErrors: readonly AdminChangelogItemErrors[];
}

export interface AdminChangelogPublishCheck {
  readonly id: ChangelogPublishabilityReason;
  readonly label: string;
  readonly passed: boolean;
}

export function createEditorItem(
  item: Partial<Omit<AdminChangelogEditorItem, "clientId">> = {},
): AdminChangelogEditorItem {
  editorItemSequence += 1;
  return {
    clientId: `admin-changelog-item-${editorItemSequence}`,
    category: item.category ?? "added",
    area: item.area ?? "",
    title: item.title ?? "",
    description: item.description ?? "",
  };
}

export function createEmptyEditorModel(): AdminChangelogEditorModel {
  return {
    version: "",
    slug: "",
    title: "",
    summary: "",
    gitTag: "",
    commitSha: "",
    releasedAt: "",
    items: [],
  };
}

export function snapshotToEditorModel(
  snapshot: AdminChangelogReleaseSnapshot,
): AdminChangelogEditorModel {
  return {
    version: snapshot.version,
    slug: snapshot.slug,
    title: snapshot.title,
    summary: snapshot.summary ?? "",
    gitTag: snapshot.gitTag ?? "",
    commitSha: snapshot.commitSha ?? "",
    releasedAt: snapshot.releasedAt ?? "",
    items: [...snapshot.items]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((item) => createEditorItem({
        category: item.category,
        area: item.area ?? "",
        title: item.title,
        description: item.description,
      })),
  };
}

export function editorModelSignature(model: AdminChangelogEditorModel): string {
  return JSON.stringify({
    version: model.version,
    slug: model.slug,
    title: model.title,
    summary: model.summary,
    gitTag: model.gitTag,
    commitSha: model.commitSha,
    releasedAt: model.releasedAt,
    items: model.items.map(({ category, area, title, description }) => ({
      category,
      area,
      title,
      description,
    })),
  });
}

function optionalString(value: string): string | null {
  return value === "" ? null : value;
}

export function editorModelToDraft(
  model: AdminChangelogEditorModel,
): AdminChangelogDraftInput {
  return {
    version: model.version,
    slug: model.slug,
    title: model.title,
    summary: optionalString(model.summary),
    gitTag: optionalString(model.gitTag),
    commitSha: optionalString(model.commitSha),
    releasedAt: optionalString(model.releasedAt),
    items: model.items.map((item, sortOrder) => ({
      category: item.category,
      area: optionalString(item.area),
      title: item.title,
      description: item.description,
      sortOrder,
    })),
  };
}

function nonBlankError(value: string, maximum: number, label: string): string | undefined {
  if (value.trim() === "") return `${label} is required.`;
  if (value.length > maximum) return `${label} must be ${maximum} characters or fewer.`;
  return undefined;
}

function optionalMaximumError(value: string, maximum: number, label: string): string | undefined {
  return value.length > maximum
    ? `${label} must be ${maximum} characters or fewer.`
    : undefined;
}

export function isExactUtcTimestamp(value: string): boolean {
  if (!ISO_UTC_MILLISECOND_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function isValidSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

export function isFullLowercaseGitSha(value: string): boolean {
  return COMMIT_SHA_PATTERN.test(value);
}

export function validateEditorModel(
  model: AdminChangelogEditorModel,
): AdminChangelogValidationErrors {
  const version = nonBlankError(model.version, 64, "Version");
  const slug = model.slug.length === 0
    ? "Slug is required."
    : model.slug.length > 128
      ? "Slug must be 128 characters or fewer."
      : !SLUG_PATTERN.test(model.slug)
        ? "Use lowercase letters, numbers, and internal hyphens only."
        : undefined;
  const title = nonBlankError(model.title, 200, "Title");
  const summary = optionalMaximumError(model.summary, 2_000, "Summary");
  const gitTag = optionalMaximumError(model.gitTag, 256, "Git tag");
  const commitSha = model.commitSha !== "" && !isFullLowercaseGitSha(model.commitSha)
    ? "Enter a full 40 or 64 character lowercase Git SHA."
    : undefined;
  const releasedAt = model.releasedAt !== "" && !isExactUtcTimestamp(model.releasedAt)
    ? "Use an exact UTC timestamp such as 2026-08-25T10:00:00.000Z."
    : undefined;
  const items = model.items.length > 200
    ? "A release can contain at most 200 items."
    : undefined;
  const itemErrors = model.items.map((item) => ({
    ...(!(CHANGELOG_CATEGORIES as readonly string[]).includes(item.category)
      ? { category: "Choose a supported category." }
      : {}),
    ...(optionalMaximumError(item.area, 100, "Area")
      ? { area: optionalMaximumError(item.area, 100, "Area") }
      : {}),
    ...(nonBlankError(item.title, 240, "Item title")
      ? { title: nonBlankError(item.title, 240, "Item title") }
      : {}),
    ...(nonBlankError(item.description, 8_000, "Item description")
      ? { description: nonBlankError(item.description, 8_000, "Item description") }
      : {}),
  }));

  return {
    ...(version ? { version } : {}),
    ...(slug ? { slug } : {}),
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(gitTag ? { gitTag } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(releasedAt ? { releasedAt } : {}),
    ...(items ? { items } : {}),
    itemErrors,
  };
}

export function hasValidationErrors(errors: AdminChangelogValidationErrors): boolean {
  return Boolean(
    errors.version
    || errors.slug
    || errors.title
    || errors.summary
    || errors.gitTag
    || errors.commitSha
    || errors.releasedAt
    || errors.items
    || errors.itemErrors.some((item) => Object.keys(item).length > 0),
  );
}

export function publishChecks(
  snapshot: AdminChangelogDraftInput,
): readonly AdminChangelogPublishCheck[] {
  return [
    { id: "invalid_version", label: "Version is valid SemVer", passed: isValidSemVer(snapshot.version) },
    { id: "missing_git_tag", label: "Git tag is present", passed: (snapshot.gitTag?.trim().length ?? 0) > 0 },
    { id: "missing_commit_sha", label: "Commit SHA is full and lowercase", passed: snapshot.commitSha !== null && isFullLowercaseGitSha(snapshot.commitSha) },
    { id: "missing_released_at", label: "Release timestamp is present", passed: snapshot.releasedAt !== null && isExactUtcTimestamp(snapshot.releasedAt) },
    { id: "missing_items", label: "At least one release item is present", passed: snapshot.items.length > 0 },
  ];
}

export function publishabilityReasonLabel(reason: ChangelogPublishabilityReason): string {
  switch (reason) {
    case "invalid_version": return "Version must be valid SemVer.";
    case "missing_git_tag": return "Git tag is required.";
    case "missing_commit_sha": return "A full lowercase Git SHA is required.";
    case "missing_released_at": return "Release timestamp is required.";
    case "missing_items": return "At least one release item is required.";
  }
}

export function releaseStatusPresentation(status: AdminChangelogReleaseStatus): {
  readonly glyph: string;
  readonly label: string;
} {
  switch (status) {
    case "draft": return { glyph: "□", label: "Draft" };
    case "published": return { glyph: "■", label: "Published" };
    case "archived": return { glyph: "-", label: "Archived" };
  }
}

export function formatUtcTimestamp(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 19)} UTC`;
}

export function isAdminChangelogReleaseId(value: string | null | undefined): value is string {
  if (value === undefined || value === null || !/^[1-9][0-9]*$/.test(value)) return false;
  return value.length < POSTGRES_BIGINT_MAX.length
    || (value.length === POSTGRES_BIGINT_MAX.length && value <= POSTGRES_BIGINT_MAX);
}

export function isAbortError(error: unknown): boolean {
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
