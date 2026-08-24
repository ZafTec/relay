import {
  arrayValue,
  booleanValue,
  type ContractSchema,
  defineContractSchema,
  enumValue,
  integerValue,
  nullable,
  optionalNullable,
  required,
  strictObject,
  stringValue,
  validationError,
} from "./schema.ts";

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

export const CHANGELOG_CONFLICT_REASONS = [
  "version",
  "slug",
  "version_and_slug",
] as const;

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX = "9223372036854775807";
const MAX_CHANGELOG_ITEMS = 200;
const MAX_ADMIN_CHANGELOG_PAGE_SIZE = 100;
const ISO_UTC_MILLISECOND_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface AdminChangelogItemInput {
  readonly category: (typeof CHANGELOG_CATEGORIES)[number];
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

export interface ListAdminChangelogRequest {
  readonly limit: number;
  readonly beforeReleaseId: string | null;
}

export interface AdminChangelogSummary {
  readonly releaseId: string;
  readonly version: string;
  readonly slug: string;
  readonly status: (typeof CHANGELOG_RELEASE_STATUSES)[number];
  readonly latestRevision: number;
  readonly publishedRevision: number | null;
  readonly hasUnpublishedChanges: boolean;
  readonly updatedAt: string;
}

interface AdminChangelogSnapshot extends AdminChangelogDraftInput {
  readonly contentSha256: string;
}

export interface AdminChangelogRevision extends AdminChangelogSnapshot {
  readonly revision: number;
  readonly changedBy: string | null;
  readonly changedAt: string;
}

export interface AdminChangelogRelease {
  readonly releaseId: string;
  readonly status: (typeof CHANGELOG_RELEASE_STATUSES)[number];
  readonly latestRevision: number;
  readonly publishedRevision: number | null;
  readonly hasUnpublishedChanges: boolean;
  readonly firstPublishedAt: string | null;
  readonly lastPublishedAt: string | null;
  readonly latest: AdminChangelogSnapshot;
  readonly published: AdminChangelogSnapshot | null;
}

export interface AdminChangelogListResponse {
  readonly releases: readonly AdminChangelogSummary[];
}

type AdminAuthorizationFailure =
  | { readonly kind: "denied"; readonly replayed: false }
  | {
    readonly kind: "reauthentication_required";
    readonly replayed: false;
  };

export type CreateAdminChangelogResult =
  | AdminAuthorizationFailure
  | {
    readonly kind: "created";
    readonly replayed: boolean;
    readonly releaseId: string;
    readonly revision: number;
  }
  | {
    readonly kind: "conflict";
    readonly replayed: boolean;
    readonly reason: (typeof CHANGELOG_CONFLICT_REASONS)[number];
  };

export interface ReviseAdminChangelogRequest extends AdminChangelogDraftInput {
  readonly expectedRevision: number;
}

export type ReviseAdminChangelogResult =
  | AdminAuthorizationFailure
  | {
    readonly kind: "revised" | "unchanged";
    readonly replayed: boolean;
    readonly releaseId: string;
    readonly revision: number;
  }
  | {
    readonly kind: "not_found";
    readonly replayed: boolean;
  }
  | {
    readonly kind: "revision_conflict";
    readonly replayed: boolean;
    readonly releaseId: string;
    readonly actualRevision: number;
  }
  | {
    readonly kind: "identity_locked";
    readonly replayed: boolean;
    readonly releaseId: string;
    readonly revision: number;
  }
  | {
    readonly kind: "conflict";
    readonly replayed: boolean;
    readonly releaseId: string;
    readonly reason: (typeof CHANGELOG_CONFLICT_REASONS)[number];
  };

export interface PublishAdminChangelogRequest {
  readonly expectedRevision: number;
}

export type PublishAdminChangelogResult =
  | AdminAuthorizationFailure
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
  }
  | {
    readonly kind: "not_found";
    readonly replayed: boolean;
  }
  | {
    readonly kind: "revision_conflict";
    readonly replayed: boolean;
    readonly releaseId: string;
    readonly actualRevision: number;
  }
  | {
    readonly kind: "not_publishable";
    readonly replayed: boolean;
    readonly releaseId: string;
    readonly revision: number;
    readonly reasons:
      readonly (typeof CHANGELOG_PUBLISHABILITY_REASONS)[number][];
  };

export interface UnpublishAdminChangelogRequest {
  readonly expectedPublishedRevision: number;
}

export type UnpublishAdminChangelogResult =
  | AdminAuthorizationFailure
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
  }
  | {
    readonly kind: "not_found";
    readonly replayed: boolean;
  }
  | {
    readonly kind: "revision_conflict";
    readonly replayed: boolean;
    readonly releaseId: string;
    readonly actualRevision: number;
  };

const adminChangelogItemInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "title", "description", "sortOrder"],
  properties: {
    category: { type: "string", enum: CHANGELOG_CATEGORIES },
    area: {
      type: ["string", "null"],
      maxLength: 100,
      default: null,
    },
    title: { type: "string", minLength: 1, maxLength: 240 },
    description: { type: "string", minLength: 1, maxLength: 8_000 },
    sortOrder: {
      type: "integer",
      minimum: 0,
      maximum: POSTGRES_INTEGER_MAX,
    },
  },
} as const;

const adminChangelogStoredItemJsonSchema = {
  ...adminChangelogItemInputJsonSchema,
  required: ["category", "area", "title", "description", "sortOrder"],
} as const;

const adminChangelogDraftProperties = {
  version: { type: "string", minLength: 1, maxLength: 64 },
  slug: {
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: "^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$",
  },
  title: { type: "string", minLength: 1, maxLength: 200 },
  summary: { type: ["string", "null"], maxLength: 2_000, default: null },
  gitTag: { type: ["string", "null"], maxLength: 256, default: null },
  commitSha: {
    type: ["string", "null"],
    pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
    default: null,
  },
  releasedAt: {
    type: ["string", "null"],
    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
    default: null,
  },
  items: {
    type: "array",
    maxItems: MAX_CHANGELOG_ITEMS,
    items: adminChangelogItemInputJsonSchema,
  },
} as const;

const adminChangelogStoredDraftProperties = {
  ...adminChangelogDraftProperties,
  items: {
    type: "array",
    maxItems: MAX_CHANGELOG_ITEMS,
    items: adminChangelogStoredItemJsonSchema,
  },
} as const;

const adminChangelogSnapshotJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "slug",
    "title",
    "summary",
    "gitTag",
    "commitSha",
    "releasedAt",
    "items",
    "contentSha256",
  ],
  properties: {
    ...adminChangelogStoredDraftProperties,
    contentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
} as const;

function requiredText(
  value: unknown,
  path: string,
  maxLength: number,
): string {
  const parsed = stringValue(value, path, { minLength: 1, maxLength });
  if (parsed.trim() === "") {
    validationError(path, "invalid_value", "must not be blank");
  }
  return parsed;
}

function exactIsoUtcTimestamp(value: unknown, path: string): string {
  const parsed = stringValue(value, path, {
    minLength: 24,
    maxLength: 24,
    pattern: ISO_UTC_MILLISECOND_PATTERN,
  });
  const timestamp = new Date(parsed);
  if (
    !Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== parsed
  ) {
    return validationError(
      path,
      "invalid_value",
      "must be an exact ISO UTC timestamp with milliseconds",
    );
  }
  return parsed;
}

export function isAdminChangelogReleaseId(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value) &&
    (value.length < POSTGRES_BIGINT_MAX.length ||
      (value.length === POSTGRES_BIGINT_MAX.length &&
        value <= POSTGRES_BIGINT_MAX));
}

function releaseId(value: unknown, path: string): string {
  const parsed = stringValue(value, path, { minLength: 1, maxLength: 19 });
  if (!isAdminChangelogReleaseId(parsed)) {
    return validationError(
      path,
      "out_of_range",
      "must be a positive PostgreSQL bigint string",
    );
  }
  return parsed;
}

function revision(value: unknown, path: string): number {
  return integerValue(value, path, {
    minimum: 1,
    maximum: POSTGRES_INTEGER_MAX,
  });
}

function nullableText(
  object: Record<string, unknown>,
  key: string,
  path: string,
  maxLength: number,
  requiredField: boolean,
): string | null {
  const parser = (value: unknown, itemPath: string) =>
    stringValue(value, itemPath, { maxLength });
  if (requiredField) {
    return nullable(required(object, key, path), `${path}.${key}`, parser);
  }
  return optionalNullable(object, key, path, parser) ?? null;
}

function changelogItem(
  value: unknown,
  path: string,
  requireArea: boolean,
): AdminChangelogItemInput {
  const object = strictObject(value, path, [
    "category",
    "area",
    "title",
    "description",
    "sortOrder",
  ]);
  return {
    category: enumValue(
      required(object, "category", path),
      `${path}.category`,
      CHANGELOG_CATEGORIES,
    ),
    area: nullableText(object, "area", path, 100, requireArea),
    title: requiredText(required(object, "title", path), `${path}.title`, 240),
    description: requiredText(
      required(object, "description", path),
      `${path}.description`,
      8_000,
    ),
    sortOrder: integerValue(
      required(object, "sortOrder", path),
      `${path}.sortOrder`,
      { minimum: 0, maximum: POSTGRES_INTEGER_MAX },
    ),
  };
}

function changelogItems(
  value: unknown,
  path: string,
  requireArea: boolean,
): readonly AdminChangelogItemInput[] {
  const items = arrayValue(
    value,
    path,
    (item, itemPath) => changelogItem(item, itemPath, requireArea),
    { maxItems: MAX_CHANGELOG_ITEMS },
  );
  if (new Set(items.map((item) => item.sortOrder)).size !== items.length) {
    validationError(path, "invalid_value", "sortOrder values must be unique");
  }
  return items;
}

function draftFields(
  object: Record<string, unknown>,
  path: string,
  requireNullableFields: boolean,
): AdminChangelogDraftInput {
  const commitSha = nullableText(
    object,
    "commitSha",
    path,
    64,
    requireNullableFields,
  );
  if (commitSha !== null && !COMMIT_SHA_PATTERN.test(commitSha)) {
    validationError(
      `${path}.commitSha`,
      "invalid_value",
      "must be a full lowercase Git SHA",
    );
  }

  const releasedAt = requireNullableFields
    ? nullable(
      required(object, "releasedAt", path),
      `${path}.releasedAt`,
      exactIsoUtcTimestamp,
    )
    : optionalNullable(
      object,
      "releasedAt",
      path,
      exactIsoUtcTimestamp,
    ) ?? null;

  return {
    version: requiredText(
      required(object, "version", path),
      `${path}.version`,
      64,
    ),
    slug: stringValue(required(object, "slug", path), `${path}.slug`, {
      minLength: 1,
      maxLength: 128,
      pattern: SLUG_PATTERN,
    }),
    title: requiredText(
      required(object, "title", path),
      `${path}.title`,
      200,
    ),
    summary: nullableText(
      object,
      "summary",
      path,
      2_000,
      requireNullableFields,
    ),
    gitTag: nullableText(
      object,
      "gitTag",
      path,
      256,
      requireNullableFields,
    ),
    commitSha,
    releasedAt,
    items: changelogItems(
      required(object, "items", path),
      `${path}.items`,
      requireNullableFields,
    ),
  };
}

function changelogSnapshot(
  value: unknown,
  path: string,
): AdminChangelogSnapshot {
  const object = strictObject(value, path, [
    "version",
    "slug",
    "title",
    "summary",
    "gitTag",
    "commitSha",
    "releasedAt",
    "items",
    "contentSha256",
  ]);
  return {
    ...draftFields(object, path, true),
    contentSha256: stringValue(
      required(object, "contentSha256", path),
      `${path}.contentSha256`,
      { minLength: 64, maxLength: 64, pattern: SHA256_PATTERN },
    ),
  };
}

export const adminChangelogDraftInputSchema: ContractSchema<
  AdminChangelogDraftInput
> = defineContractSchema(
  "AdminChangelogDraftInput",
  {
    type: "object",
    additionalProperties: false,
    required: ["version", "slug", "title", "items"],
    properties: adminChangelogDraftProperties,
  },
  (value, path): AdminChangelogDraftInput => {
    const object = strictObject(value, path, [
      "version",
      "slug",
      "title",
      "summary",
      "gitTag",
      "commitSha",
      "releasedAt",
      "items",
    ]);
    return draftFields(object, path, false);
  },
);

export const listAdminChangelogRequestSchema: ContractSchema<
  ListAdminChangelogRequest
> = defineContractSchema(
  "ListAdminChangelogRequest",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_ADMIN_CHANGELOG_PAGE_SIZE,
        default: 20,
      },
      beforeReleaseId: {
        type: ["string", "null"],
        pattern: "^[1-9][0-9]{0,18}$",
        default: null,
      },
    },
  },
  (value, path): ListAdminChangelogRequest => {
    const object = strictObject(value, path, ["limit", "beforeReleaseId"]);
    return {
      limit: Object.hasOwn(object, "limit") && object.limit !== undefined
        ? integerValue(object.limit, `${path}.limit`, {
          minimum: 1,
          maximum: MAX_ADMIN_CHANGELOG_PAGE_SIZE,
        })
        : 20,
      beforeReleaseId: optionalNullable(
        object,
        "beforeReleaseId",
        path,
        releaseId,
      ) ?? null,
    };
  },
);

function adminChangelogSummary(
  value: unknown,
  path: string,
): AdminChangelogSummary {
  const object = strictObject(value, path, [
    "releaseId",
    "version",
    "slug",
    "status",
    "latestRevision",
    "publishedRevision",
    "hasUnpublishedChanges",
    "updatedAt",
  ]);
  const status = enumValue(
    required(object, "status", path),
    `${path}.status`,
    CHANGELOG_RELEASE_STATUSES,
  );
  const latestRevision = revision(
    required(object, "latestRevision", path),
    `${path}.latestRevision`,
  );
  const publishedRevision = nullable(
    required(object, "publishedRevision", path),
    `${path}.publishedRevision`,
    revision,
  );
  const hasUnpublishedChanges = booleanValue(
    required(object, "hasUnpublishedChanges", path),
    `${path}.hasUnpublishedChanges`,
  );
  if (publishedRevision !== null && publishedRevision > latestRevision) {
    validationError(
      `${path}.publishedRevision`,
      "invalid_value",
      "must not exceed latestRevision",
    );
  }
  if (hasUnpublishedChanges !== (publishedRevision !== latestRevision)) {
    validationError(
      `${path}.hasUnpublishedChanges`,
      "invalid_value",
      "does not match the release revisions",
    );
  }
  if (
    (status === "draft" && publishedRevision !== null) ||
    (status !== "draft" && publishedRevision === null)
  ) {
    validationError(
      `${path}.publishedRevision`,
      "invalid_value",
      "does not match the release status",
    );
  }
  return {
    releaseId: releaseId(
      required(object, "releaseId", path),
      `${path}.releaseId`,
    ),
    version: requiredText(
      required(object, "version", path),
      `${path}.version`,
      64,
    ),
    slug: stringValue(required(object, "slug", path), `${path}.slug`, {
      minLength: 1,
      maxLength: 128,
      pattern: SLUG_PATTERN,
    }),
    status,
    latestRevision,
    publishedRevision,
    hasUnpublishedChanges,
    updatedAt: exactIsoUtcTimestamp(
      required(object, "updatedAt", path),
      `${path}.updatedAt`,
    ),
  };
}

export const adminChangelogSummarySchema: ContractSchema<
  AdminChangelogSummary
> = defineContractSchema(
  "AdminChangelogSummary",
  {
    type: "object",
    additionalProperties: false,
    required: [
      "releaseId",
      "version",
      "slug",
      "status",
      "latestRevision",
      "publishedRevision",
      "hasUnpublishedChanges",
      "updatedAt",
    ],
    properties: {
      releaseId: {
        type: "string",
        minLength: 1,
        maxLength: 19,
        pattern: "^[1-9][0-9]*$",
      },
      version: adminChangelogDraftProperties.version,
      slug: adminChangelogDraftProperties.slug,
      status: { type: "string", enum: CHANGELOG_RELEASE_STATUSES },
      latestRevision: {
        type: "integer",
        minimum: 1,
        maximum: POSTGRES_INTEGER_MAX,
      },
      publishedRevision: {
        type: ["integer", "null"],
        minimum: 1,
        maximum: POSTGRES_INTEGER_MAX,
      },
      hasUnpublishedChanges: { type: "boolean" },
      updatedAt: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
      },
    },
  },
  adminChangelogSummary,
);

export const adminChangelogRevisionSchema: ContractSchema<
  AdminChangelogRevision
> = defineContractSchema(
  "AdminChangelogRevision",
  {
    type: "object",
    additionalProperties: false,
    required: [
      ...(adminChangelogSnapshotJsonSchema.required as readonly string[]),
      "revision",
      "changedBy",
      "changedAt",
    ],
    properties: {
      ...adminChangelogSnapshotJsonSchema.properties,
      revision: {
        type: "integer",
        minimum: 1,
        maximum: POSTGRES_INTEGER_MAX,
      },
      changedBy: { type: ["string", "null"], minLength: 1, maxLength: 255 },
      changedAt: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
      },
    },
  },
  (value, path): AdminChangelogRevision => {
    const object = strictObject(value, path, [
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
      "changedBy",
      "changedAt",
    ]);
    return {
      ...draftFields(object, path, true),
      contentSha256: stringValue(
        required(object, "contentSha256", path),
        `${path}.contentSha256`,
        { minLength: 64, maxLength: 64, pattern: SHA256_PATTERN },
      ),
      revision: revision(
        required(object, "revision", path),
        `${path}.revision`,
      ),
      changedBy: nullable(
        required(object, "changedBy", path),
        `${path}.changedBy`,
        (item, itemPath) =>
          stringValue(item, itemPath, { minLength: 1, maxLength: 255 }),
      ),
      changedAt: exactIsoUtcTimestamp(
        required(object, "changedAt", path),
        `${path}.changedAt`,
      ),
    };
  },
);

export const adminChangelogReleaseSchema: ContractSchema<
  AdminChangelogRelease
> = defineContractSchema(
  "AdminChangelogRelease",
  {
    type: "object",
    additionalProperties: false,
    required: [
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
    properties: {
      releaseId: {
        type: "string",
        minLength: 1,
        maxLength: 19,
        pattern: "^[1-9][0-9]*$",
      },
      status: { type: "string", enum: CHANGELOG_RELEASE_STATUSES },
      latestRevision: {
        type: "integer",
        minimum: 1,
        maximum: POSTGRES_INTEGER_MAX,
      },
      publishedRevision: {
        type: ["integer", "null"],
        minimum: 1,
        maximum: POSTGRES_INTEGER_MAX,
      },
      hasUnpublishedChanges: { type: "boolean" },
      firstPublishedAt: {
        type: ["string", "null"],
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
      },
      lastPublishedAt: {
        type: ["string", "null"],
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
      },
      latest: adminChangelogSnapshotJsonSchema,
      published: {
        anyOf: [adminChangelogSnapshotJsonSchema, { type: "null" }],
      },
    },
  },
  (value, path): AdminChangelogRelease => {
    const object = strictObject(value, path, [
      "releaseId",
      "status",
      "latestRevision",
      "publishedRevision",
      "hasUnpublishedChanges",
      "firstPublishedAt",
      "lastPublishedAt",
      "latest",
      "published",
    ]);
    const status = enumValue(
      required(object, "status", path),
      `${path}.status`,
      CHANGELOG_RELEASE_STATUSES,
    );
    const latestRevision = revision(
      required(object, "latestRevision", path),
      `${path}.latestRevision`,
    );
    const publishedRevision = nullable(
      required(object, "publishedRevision", path),
      `${path}.publishedRevision`,
      revision,
    );
    const hasUnpublishedChanges = booleanValue(
      required(object, "hasUnpublishedChanges", path),
      `${path}.hasUnpublishedChanges`,
    );
    const firstPublishedAt = nullable(
      required(object, "firstPublishedAt", path),
      `${path}.firstPublishedAt`,
      exactIsoUtcTimestamp,
    );
    const lastPublishedAt = nullable(
      required(object, "lastPublishedAt", path),
      `${path}.lastPublishedAt`,
      exactIsoUtcTimestamp,
    );
    const published = nullable(
      required(object, "published", path),
      `${path}.published`,
      changelogSnapshot,
    );

    if (publishedRevision !== null && publishedRevision > latestRevision) {
      validationError(
        `${path}.publishedRevision`,
        "invalid_value",
        "must not exceed latestRevision",
      );
    }
    if (hasUnpublishedChanges !== (publishedRevision !== latestRevision)) {
      validationError(
        `${path}.hasUnpublishedChanges`,
        "invalid_value",
        "does not match the release revisions",
      );
    }
    if ((publishedRevision === null) !== (published === null)) {
      validationError(
        `${path}.published`,
        "invalid_value",
        "does not match publishedRevision",
      );
    }
    if (
      (status === "draft" && publishedRevision !== null) ||
      (status !== "draft" && publishedRevision === null)
    ) {
      validationError(
        `${path}.publishedRevision`,
        "invalid_value",
        "does not match the release status",
      );
    }
    if (
      (firstPublishedAt === null) !== (lastPublishedAt === null) ||
      (publishedRevision === null) !== (firstPublishedAt === null)
    ) {
      validationError(
        `${path}.firstPublishedAt`,
        "invalid_value",
        "publication timestamps do not match the release state",
      );
    }
    if (
      firstPublishedAt !== null && lastPublishedAt !== null &&
      firstPublishedAt > lastPublishedAt
    ) {
      validationError(
        `${path}.lastPublishedAt`,
        "invalid_value",
        "must not precede firstPublishedAt",
      );
    }

    return {
      releaseId: releaseId(
        required(object, "releaseId", path),
        `${path}.releaseId`,
      ),
      status,
      latestRevision,
      publishedRevision,
      hasUnpublishedChanges,
      firstPublishedAt,
      lastPublishedAt,
      latest: changelogSnapshot(
        required(object, "latest", path),
        `${path}.latest`,
      ),
      published,
    };
  },
);

export const adminChangelogListResponseSchema: ContractSchema<
  AdminChangelogListResponse
> = defineContractSchema(
  "AdminChangelogListResponse",
  {
    type: "object",
    additionalProperties: false,
    required: ["releases"],
    properties: {
      releases: {
        type: "array",
        maxItems: MAX_ADMIN_CHANGELOG_PAGE_SIZE,
        items: adminChangelogSummarySchema.jsonSchema,
      },
    },
  },
  (value, path): AdminChangelogListResponse => {
    const object = strictObject(value, path, ["releases"]);
    return {
      releases: arrayValue(
        required(object, "releases", path),
        `${path}.releases`,
        (item) => adminChangelogSummarySchema.parse(item),
        { maxItems: MAX_ADMIN_CHANGELOG_PAGE_SIZE },
      ),
    };
  },
);

function replayed(object: Record<string, unknown>, path: string): boolean {
  return booleanValue(required(object, "replayed", path), `${path}.replayed`);
}

function authorizationFailure(
  value: unknown,
  path: string,
  kind: "denied" | "reauthentication_required",
): AdminAuthorizationFailure {
  const object = strictObject(value, path, ["kind", "replayed"]);
  const wasReplayed = replayed(object, path);
  if (wasReplayed) {
    validationError(
      `${path}.replayed`,
      "invalid_value",
      "must be false for authorization failures",
    );
  }
  return { kind, replayed: false };
}

const authorizationFailureJsonSchemas = [
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "replayed"],
    properties: {
      kind: { const: "denied" },
      replayed: { const: false },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "replayed"],
    properties: {
      kind: { const: "reauthentication_required" },
      replayed: { const: false },
    },
  },
] as const;

export const createAdminChangelogResultSchema: ContractSchema<
  CreateAdminChangelogResult
> = defineContractSchema(
  "CreateAdminChangelogResult",
  {
    oneOf: [
      ...authorizationFailureJsonSchemas,
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed", "releaseId", "revision"],
        properties: {
          kind: { const: "created" },
          replayed: { type: "boolean" },
          releaseId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          revision: {
            type: "integer",
            minimum: 1,
            maximum: POSTGRES_INTEGER_MAX,
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed", "reason"],
        properties: {
          kind: { const: "conflict" },
          replayed: { type: "boolean" },
          reason: { type: "string", enum: CHANGELOG_CONFLICT_REASONS },
        },
      },
    ],
  },
  (value, path): CreateAdminChangelogResult => {
    const broad = strictObject(value, path, [
      "kind",
      "replayed",
      "releaseId",
      "revision",
      "reason",
    ]);
    const kind = enumValue(
      required(broad, "kind", path),
      `${path}.kind`,
      ["created", "conflict", "denied", "reauthentication_required"] as const,
    );
    if (kind === "denied" || kind === "reauthentication_required") {
      return authorizationFailure(value, path, kind);
    }
    if (kind === "conflict") {
      const object = strictObject(value, path, ["kind", "replayed", "reason"]);
      return {
        kind,
        replayed: replayed(object, path),
        reason: enumValue(
          required(object, "reason", path),
          `${path}.reason`,
          CHANGELOG_CONFLICT_REASONS,
        ),
      };
    }
    const object = strictObject(value, path, [
      "kind",
      "replayed",
      "releaseId",
      "revision",
    ]);
    return {
      kind,
      replayed: replayed(object, path),
      releaseId: releaseId(
        required(object, "releaseId", path),
        `${path}.releaseId`,
      ),
      revision: revision(
        required(object, "revision", path),
        `${path}.revision`,
      ),
    };
  },
);

export const reviseAdminChangelogRequestSchema: ContractSchema<
  ReviseAdminChangelogRequest
> = defineContractSchema(
  "ReviseAdminChangelogRequest",
  {
    type: "object",
    additionalProperties: false,
    required: ["expectedRevision", "version", "slug", "title", "items"],
    properties: {
      expectedRevision: {
        type: "integer",
        minimum: 1,
        maximum: POSTGRES_INTEGER_MAX,
      },
      ...adminChangelogDraftProperties,
    },
  },
  (value, path): ReviseAdminChangelogRequest => {
    const object = strictObject(value, path, [
      "expectedRevision",
      "version",
      "slug",
      "title",
      "summary",
      "gitTag",
      "commitSha",
      "releasedAt",
      "items",
    ]);
    return {
      expectedRevision: revision(
        required(object, "expectedRevision", path),
        `${path}.expectedRevision`,
      ),
      ...draftFields(object, path, false),
    };
  },
);

export const reviseAdminChangelogResultSchema: ContractSchema<
  ReviseAdminChangelogResult
> = defineContractSchema(
  "ReviseAdminChangelogResult",
  {
    oneOf: [
      ...authorizationFailureJsonSchemas,
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed", "releaseId", "revision"],
        properties: {
          kind: { enum: ["revised", "unchanged", "identity_locked"] },
          replayed: { type: "boolean" },
          releaseId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          revision: {
            type: "integer",
            minimum: 1,
            maximum: POSTGRES_INTEGER_MAX,
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed"],
        properties: {
          kind: { const: "not_found" },
          replayed: { type: "boolean" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed", "releaseId", "actualRevision"],
        properties: {
          kind: { const: "revision_conflict" },
          replayed: { type: "boolean" },
          releaseId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          actualRevision: {
            type: "integer",
            minimum: 1,
            maximum: POSTGRES_INTEGER_MAX,
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed", "releaseId", "reason"],
        properties: {
          kind: { const: "conflict" },
          replayed: { type: "boolean" },
          releaseId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          reason: { type: "string", enum: CHANGELOG_CONFLICT_REASONS },
        },
      },
    ],
  },
  (value, path): ReviseAdminChangelogResult => {
    const broad = strictObject(value, path, [
      "kind",
      "replayed",
      "releaseId",
      "revision",
      "actualRevision",
      "reason",
    ]);
    const kind = enumValue(
      required(broad, "kind", path),
      `${path}.kind`,
      [
        "revised",
        "unchanged",
        "not_found",
        "revision_conflict",
        "identity_locked",
        "conflict",
        "denied",
        "reauthentication_required",
      ] as const,
    );
    if (kind === "denied" || kind === "reauthentication_required") {
      return authorizationFailure(value, path, kind);
    }
    if (kind === "not_found") {
      const object = strictObject(value, path, ["kind", "replayed"]);
      return { kind, replayed: replayed(object, path) };
    }
    if (kind === "revision_conflict") {
      const object = strictObject(value, path, [
        "kind",
        "replayed",
        "releaseId",
        "actualRevision",
      ]);
      return {
        kind,
        replayed: replayed(object, path),
        releaseId: releaseId(
          required(object, "releaseId", path),
          `${path}.releaseId`,
        ),
        actualRevision: revision(
          required(object, "actualRevision", path),
          `${path}.actualRevision`,
        ),
      };
    }
    if (kind === "conflict") {
      const object = strictObject(value, path, [
        "kind",
        "replayed",
        "releaseId",
        "reason",
      ]);
      return {
        kind,
        replayed: replayed(object, path),
        releaseId: releaseId(
          required(object, "releaseId", path),
          `${path}.releaseId`,
        ),
        reason: enumValue(
          required(object, "reason", path),
          `${path}.reason`,
          CHANGELOG_CONFLICT_REASONS,
        ),
      };
    }
    const object = strictObject(value, path, [
      "kind",
      "replayed",
      "releaseId",
      "revision",
    ]);
    return {
      kind,
      replayed: replayed(object, path),
      releaseId: releaseId(
        required(object, "releaseId", path),
        `${path}.releaseId`,
      ),
      revision: revision(
        required(object, "revision", path),
        `${path}.revision`,
      ),
    };
  },
);

export const publishAdminChangelogRequestSchema: ContractSchema<
  PublishAdminChangelogRequest
> = defineContractSchema(
  "PublishAdminChangelogRequest",
  {
    type: "object",
    additionalProperties: false,
    required: ["expectedRevision"],
    properties: {
      expectedRevision: {
        type: "integer",
        minimum: 1,
        maximum: POSTGRES_INTEGER_MAX,
      },
    },
  },
  (value, path): PublishAdminChangelogRequest => {
    const object = strictObject(value, path, ["expectedRevision"]);
    return {
      expectedRevision: revision(
        required(object, "expectedRevision", path),
        `${path}.expectedRevision`,
      ),
    };
  },
);

export const publishAdminChangelogResultSchema: ContractSchema<
  PublishAdminChangelogResult
> = defineContractSchema(
  "PublishAdminChangelogResult",
  {
    oneOf: [
      ...authorizationFailureJsonSchemas,
      {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "replayed",
          "releaseId",
          "revision",
          "supersededRevision",
        ],
        properties: {
          kind: { enum: ["published", "unchanged"] },
          replayed: { type: "boolean" },
          releaseId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          revision: {
            type: "integer",
            minimum: 1,
            maximum: POSTGRES_INTEGER_MAX,
          },
          supersededRevision: { type: "null" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "replayed",
          "releaseId",
          "revision",
          "supersededRevision",
        ],
        properties: {
          kind: { const: "superseded" },
          replayed: { type: "boolean" },
          releaseId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          revision: {
            type: "integer",
            minimum: 1,
            maximum: POSTGRES_INTEGER_MAX,
          },
          supersededRevision: {
            type: "integer",
            minimum: 1,
            maximum: POSTGRES_INTEGER_MAX,
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed"],
        properties: {
          kind: { const: "not_found" },
          replayed: { type: "boolean" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed", "releaseId", "actualRevision"],
        properties: {
          kind: { const: "revision_conflict" },
          replayed: { type: "boolean" },
          releaseId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          actualRevision: {
            type: "integer",
            minimum: 1,
            maximum: POSTGRES_INTEGER_MAX,
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed", "releaseId", "revision", "reasons"],
        properties: {
          kind: { const: "not_publishable" },
          replayed: { type: "boolean" },
          releaseId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          revision: {
            type: "integer",
            minimum: 1,
            maximum: POSTGRES_INTEGER_MAX,
          },
          reasons: {
            type: "array",
            minItems: 1,
            maxItems: CHANGELOG_PUBLISHABILITY_REASONS.length,
            uniqueItems: true,
            items: {
              type: "string",
              enum: CHANGELOG_PUBLISHABILITY_REASONS,
            },
          },
        },
      },
    ],
  },
  (value, path): PublishAdminChangelogResult => {
    const broad = strictObject(value, path, [
      "kind",
      "replayed",
      "releaseId",
      "revision",
      "supersededRevision",
      "actualRevision",
      "reasons",
    ]);
    const kind = enumValue(
      required(broad, "kind", path),
      `${path}.kind`,
      [
        "published",
        "superseded",
        "unchanged",
        "not_found",
        "revision_conflict",
        "not_publishable",
        "denied",
        "reauthentication_required",
      ] as const,
    );
    if (kind === "denied" || kind === "reauthentication_required") {
      return authorizationFailure(value, path, kind);
    }
    if (kind === "not_found") {
      const object = strictObject(value, path, ["kind", "replayed"]);
      return { kind, replayed: replayed(object, path) };
    }
    if (kind === "revision_conflict") {
      const object = strictObject(value, path, [
        "kind",
        "replayed",
        "releaseId",
        "actualRevision",
      ]);
      return {
        kind,
        replayed: replayed(object, path),
        releaseId: releaseId(
          required(object, "releaseId", path),
          `${path}.releaseId`,
        ),
        actualRevision: revision(
          required(object, "actualRevision", path),
          `${path}.actualRevision`,
        ),
      };
    }
    if (kind === "not_publishable") {
      const object = strictObject(value, path, [
        "kind",
        "replayed",
        "releaseId",
        "revision",
        "reasons",
      ]);
      const reasons = arrayValue(
        required(object, "reasons", path),
        `${path}.reasons`,
        (item, itemPath) =>
          enumValue(item, itemPath, CHANGELOG_PUBLISHABILITY_REASONS),
        { minItems: 1, maxItems: CHANGELOG_PUBLISHABILITY_REASONS.length },
      );
      if (new Set(reasons).size !== reasons.length) {
        validationError(
          `${path}.reasons`,
          "invalid_value",
          "must not contain duplicates",
        );
      }
      return {
        kind,
        replayed: replayed(object, path),
        releaseId: releaseId(
          required(object, "releaseId", path),
          `${path}.releaseId`,
        ),
        revision: revision(
          required(object, "revision", path),
          `${path}.revision`,
        ),
        reasons,
      };
    }

    const object = strictObject(value, path, [
      "kind",
      "replayed",
      "releaseId",
      "revision",
      "supersededRevision",
    ]);
    const parsedRevision = revision(
      required(object, "revision", path),
      `${path}.revision`,
    );
    const supersededRevision = nullable(
      required(object, "supersededRevision", path),
      `${path}.supersededRevision`,
      revision,
    );
    if (
      (kind === "superseded" &&
        (supersededRevision === null ||
          supersededRevision >= parsedRevision)) ||
      (kind !== "superseded" && supersededRevision !== null)
    ) {
      validationError(
        `${path}.supersededRevision`,
        "invalid_value",
        "does not match the publication result kind and revision",
      );
    }
    return kind === "superseded"
      ? {
        kind,
        replayed: replayed(object, path),
        releaseId: releaseId(
          required(object, "releaseId", path),
          `${path}.releaseId`,
        ),
        revision: parsedRevision,
        supersededRevision: supersededRevision!,
      }
      : {
        kind,
        replayed: replayed(object, path),
        releaseId: releaseId(
          required(object, "releaseId", path),
          `${path}.releaseId`,
        ),
        revision: parsedRevision,
        supersededRevision: null,
      };
  },
);

export const unpublishAdminChangelogRequestSchema: ContractSchema<
  UnpublishAdminChangelogRequest
> = defineContractSchema(
  "UnpublishAdminChangelogRequest",
  {
    type: "object",
    additionalProperties: false,
    required: ["expectedPublishedRevision"],
    properties: {
      expectedPublishedRevision: {
        type: "integer",
        minimum: 1,
        maximum: POSTGRES_INTEGER_MAX,
      },
    },
  },
  (value, path): UnpublishAdminChangelogRequest => {
    const object = strictObject(value, path, ["expectedPublishedRevision"]);
    return {
      expectedPublishedRevision: revision(
        required(object, "expectedPublishedRevision", path),
        `${path}.expectedPublishedRevision`,
      ),
    };
  },
);

export const unpublishAdminChangelogResultSchema: ContractSchema<
  UnpublishAdminChangelogResult
> = defineContractSchema(
  "UnpublishAdminChangelogResult",
  {
    oneOf: [
      ...authorizationFailureJsonSchemas,
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed", "releaseId", "revision"],
        properties: {
          kind: { const: "unpublished" },
          replayed: { type: "boolean" },
          releaseId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          revision: {
            type: "integer",
            minimum: 1,
            maximum: POSTGRES_INTEGER_MAX,
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed", "releaseId", "revision"],
        properties: {
          kind: { const: "unchanged" },
          replayed: { type: "boolean" },
          releaseId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          revision: {
            type: ["integer", "null"],
            minimum: 1,
            maximum: POSTGRES_INTEGER_MAX,
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed"],
        properties: {
          kind: { const: "not_found" },
          replayed: { type: "boolean" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "replayed", "releaseId", "actualRevision"],
        properties: {
          kind: { const: "revision_conflict" },
          replayed: { type: "boolean" },
          releaseId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          actualRevision: {
            type: "integer",
            minimum: 1,
            maximum: POSTGRES_INTEGER_MAX,
          },
        },
      },
    ],
  },
  (value, path): UnpublishAdminChangelogResult => {
    const broad = strictObject(value, path, [
      "kind",
      "replayed",
      "releaseId",
      "revision",
      "actualRevision",
    ]);
    const kind = enumValue(
      required(broad, "kind", path),
      `${path}.kind`,
      [
        "unpublished",
        "unchanged",
        "not_found",
        "revision_conflict",
        "denied",
        "reauthentication_required",
      ] as const,
    );
    if (kind === "denied" || kind === "reauthentication_required") {
      return authorizationFailure(value, path, kind);
    }
    if (kind === "not_found") {
      const object = strictObject(value, path, ["kind", "replayed"]);
      return { kind, replayed: replayed(object, path) };
    }
    if (kind === "revision_conflict") {
      const object = strictObject(value, path, [
        "kind",
        "replayed",
        "releaseId",
        "actualRevision",
      ]);
      return {
        kind,
        replayed: replayed(object, path),
        releaseId: releaseId(
          required(object, "releaseId", path),
          `${path}.releaseId`,
        ),
        actualRevision: revision(
          required(object, "actualRevision", path),
          `${path}.actualRevision`,
        ),
      };
    }
    const object = strictObject(value, path, [
      "kind",
      "replayed",
      "releaseId",
      "revision",
    ]);
    const parsedRevision = kind === "unchanged"
      ? nullable(
        required(object, "revision", path),
        `${path}.revision`,
        revision,
      )
      : revision(required(object, "revision", path), `${path}.revision`);
    return kind === "unchanged"
      ? {
        kind,
        replayed: replayed(object, path),
        releaseId: releaseId(
          required(object, "releaseId", path),
          `${path}.releaseId`,
        ),
        revision: parsedRevision,
      }
      : {
        kind,
        replayed: replayed(object, path),
        releaseId: releaseId(
          required(object, "releaseId", path),
          `${path}.releaseId`,
        ),
        revision: parsedRevision as number,
      };
  },
);
