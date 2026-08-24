import {
  arrayValue,
  booleanValue,
  type ContractSchema,
  defineContractSchema,
  enumValue,
  integerValue,
  isoTimestamp,
  type JsonObject,
  jsonObject,
  nullable,
  optional,
  optionalNullable,
  required,
  strictObject,
  stringRecord,
  stringValue,
  validationError,
} from "./schema.ts";
import {
  createCursorPageSchema,
  type CursorPage,
  type CursorPaginationRequest,
  cursorPaginationRequestSchema,
} from "./pagination.ts";
import {
  artifactIdParser,
  artifactUploadIdParser,
  artifactVersionIdParser,
  runIdParser,
  safeCodeParser,
  shareLinkIdParser,
} from "./identifiers.ts";

export const ARTIFACT_VERSION_SOURCES = [
  "upload",
  "generated",
  "restore",
] as const;
export const ARTIFACT_VERIFICATION_STATUSES = [
  "pending",
  "head_verified",
  "cryptographically_verified",
  "failed",
] as const;
export const ARTIFACT_UPLOAD_STATUSES = [
  "pending",
  "completed",
  "failed",
  "expired",
] as const;
export const SHARE_LINK_STATUSES = [
  "active",
  "expired",
  "exhausted",
  "revoked",
] as const;

export type ArtifactVersionSource = (typeof ARTIFACT_VERSION_SOURCES)[number];
export type ArtifactVerificationStatus =
  (typeof ARTIFACT_VERIFICATION_STATUSES)[number];
export type ArtifactUploadStatus = (typeof ARTIFACT_UPLOAD_STATUSES)[number];
export type ShareLinkStatus = (typeof SHARE_LINK_STATUSES)[number];

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

export interface ListArtifactsRequest extends CursorPaginationRequest {
  readonly mediaKind?: string;
  readonly sourceRunId?: string;
  readonly shared?: boolean;
  readonly search?: string;
}

export type ListArtifactsResult =
  | ({ readonly kind: "ok" } & CursorPage<ArtifactSummary>)
  | { readonly kind: "not_found" };

export type GetArtifactResult =
  | { readonly kind: "found"; readonly artifact: ArtifactDetail }
  | { readonly kind: "not_found" };

export type UploadTarget =
  | {
    readonly kind: "new_artifact";
    readonly name: string;
    readonly mediaKind: string;
    readonly retentionPolicyId?: string | null;
  }
  | {
    readonly kind: "new_version";
    readonly artifactId: string;
  };

/** Metadata only. File bytes are sent directly to the returned upload URL. */
export interface CreateArtifactUploadRequest {
  readonly target: UploadTarget;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly contentMd5: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
  readonly metadata?: JsonObject;
  readonly sourceRunId?: string | null;
}

export interface UploadAuthorizationResource {
  readonly method: "PUT";
  readonly url: string;
  readonly expiresAt: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface ArtifactUploadResource {
  readonly id: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly sequence: number;
  readonly status: ArtifactUploadStatus;
  readonly authorization: UploadAuthorizationResource | null;
}

export type CreateArtifactUploadResult =
  | { readonly kind: "created"; readonly upload: ArtifactUploadResource }
  | { readonly kind: "not_found" }
  | { readonly kind: "quota_exceeded" };

export type CompleteArtifactUploadResult =
  | {
    readonly kind: "completed";
    readonly artifactId: string;
    readonly artifactVersionId: string;
    readonly becameCurrent: boolean;
  }
  | { readonly kind: "pending" }
  | { readonly kind: "expired" }
  | { readonly kind: "verification_failed"; readonly reason: string }
  | { readonly kind: "not_found" };

export interface CreateShareLinkRequest {
  readonly artifactId: string;
  readonly followCurrent: boolean;
  readonly artifactVersionId?: string | null;
  readonly expiresAt?: string | null;
  readonly maxResolutions?: number | null;
  readonly requireAuth?: boolean;
  readonly contentDisposition: "attachment" | "inline";
}

export type CreateShareLinkResult =
  | {
    readonly kind: "created";
    readonly shareLinkId: string;
    /** Returned once; only its hash is durable. */
    readonly token: string;
    readonly publicPath: string;
  }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" };

export type RevokeShareLinkResult =
  | { readonly kind: "revoked" }
  | { readonly kind: "already_revoked" }
  | { readonly kind: "not_found" };

export interface DownloadAuthorizationResource {
  readonly method: "GET";
  readonly url: string;
  readonly expiresAt: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface CreateArtifactDownloadRequest {
  readonly artifactId: string;
  readonly artifactVersionId?: string;
  readonly contentDisposition?: "attachment" | "inline";
  readonly expiresInSeconds?: number;
}

export type CreateArtifactDownloadResult =
  | {
    readonly kind: "authorized";
    readonly artifactId: string;
    readonly artifactVersionId: string;
    readonly download: DownloadAuthorizationResource;
  }
  | { readonly kind: "not_found" };

export type ResolveShareLinkResult =
  | {
    readonly kind: "authorized";
    readonly shareLinkId: string;
    readonly artifactId: string;
    readonly artifactVersionId: string;
    readonly download: DownloadAuthorizationResource;
  }
  | { readonly kind: "authentication_required" }
  | { readonly kind: "unavailable" };

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTENT_MD5_PATTERN = /^[A-Za-z0-9+/]{22}==$/;
const MEDIA_KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const MIME_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function optionalPositiveInteger(
  object: Record<string, unknown>,
  key: string,
  path: string,
): number | null | undefined {
  return optionalNullable(
    object,
    key,
    path,
    (item, itemPath) => integerValue(item, itemPath, { minimum: 1 }),
  );
}

function safeUrl(value: unknown, path: string): string {
  const text = stringValue(value, path, { minLength: 1, maxLength: 4_096 });
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return validationError(path, "invalid_value", "must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return validationError(path, "invalid_value", "must use HTTP or HTTPS");
  }
  return text;
}

function artifactVersion(
  value: unknown,
  path: string,
): ArtifactVersionResource {
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
    id: artifactVersionIdParser(required(object, "id", path), `${path}.id`),
    sequence: integerValue(
      required(object, "sequence", path),
      `${path}.sequence`,
      { minimum: 1 },
    ),
    sha256: stringValue(required(object, "sha256", path), `${path}.sha256`, {
      pattern: SHA256_PATTERN,
    }),
    contentMd5: stringValue(
      required(object, "contentMd5", path),
      `${path}.contentMd5`,
      { pattern: CONTENT_MD5_PATTERN },
    ),
    sizeBytes: integerValue(
      required(object, "sizeBytes", path),
      `${path}.sizeBytes`,
      { minimum: 0 },
    ),
    mimeType: stringValue(
      required(object, "mimeType", path),
      `${path}.mimeType`,
      { minLength: 1, maxLength: 255, pattern: MIME_TYPE_PATTERN },
    ),
    width: nullable(
      required(object, "width", path),
      `${path}.width`,
      (item, itemPath) => integerValue(item, itemPath, { minimum: 1 }),
    ),
    height: nullable(
      required(object, "height", path),
      `${path}.height`,
      (item, itemPath) => integerValue(item, itemPath, { minimum: 1 }),
    ),
    durationMs: nullable(
      required(object, "durationMs", path),
      `${path}.durationMs`,
      (item, itemPath) => integerValue(item, itemPath, { minimum: 1 }),
    ),
    source: enumValue(
      required(object, "source", path),
      `${path}.source`,
      ARTIFACT_VERSION_SOURCES,
    ),
    sourceRunId: nullable(
      required(object, "sourceRunId", path),
      `${path}.sourceRunId`,
      runIdParser,
    ),
    parentVersionId: nullable(
      required(object, "parentVersionId", path),
      `${path}.parentVersionId`,
      artifactVersionIdParser,
    ),
    metadata: jsonObject(
      required(object, "metadata", path),
      `${path}.metadata`,
      {
        rejectUrls: true,
        maxBytes: 64 * 1024,
      },
    ),
    verificationStatus: enumValue(
      required(object, "verificationStatus", path),
      `${path}.verificationStatus`,
      ARTIFACT_VERIFICATION_STATUSES,
    ),
    createdAt: isoTimestamp(
      required(object, "createdAt", path),
      `${path}.createdAt`,
    ),
  };
}

export const artifactVersionSchema: ContractSchema<ArtifactVersionResource> =
  defineContractSchema(
    "ArtifactVersionResource",
    {
      type: "object",
      additionalProperties: false,
      required: [
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
      ],
      properties: {
        id: { type: "string", pattern: "^aver_[0-9a-f]{32}$" },
        sequence: { type: "integer", minimum: 1 },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        contentMd5: { type: "string", pattern: "^[A-Za-z0-9+/]{22}==$" },
        sizeBytes: { type: "integer", minimum: 0 },
        mimeType: { type: "string", minLength: 1, maxLength: 255 },
        width: { type: ["integer", "null"], minimum: 1 },
        height: { type: ["integer", "null"], minimum: 1 },
        durationMs: { type: ["integer", "null"], minimum: 1 },
        source: { type: "string", enum: ARTIFACT_VERSION_SOURCES },
        sourceRunId: { type: ["string", "null"] },
        parentVersionId: { type: ["string", "null"] },
        metadata: { type: "object" },
        verificationStatus: {
          type: "string",
          enum: ARTIFACT_VERIFICATION_STATUSES,
        },
        createdAt: { type: "string", format: "date-time" },
      },
    },
    artifactVersion,
  );

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
    id: artifactIdParser(required(object, "id", path), `${path}.id`),
    name: stringValue(required(object, "name", path), `${path}.name`, {
      minLength: 1,
      maxLength: 255,
    }),
    mediaKind: stringValue(
      required(object, "mediaKind", path),
      `${path}.mediaKind`,
      { pattern: MEDIA_KIND_PATTERN },
    ),
    sourceRunId: nullable(
      required(object, "sourceRunId", path),
      `${path}.sourceRunId`,
      runIdParser,
    ),
    currentVersion: nullable(
      required(object, "currentVersion", path),
      `${path}.currentVersion`,
      (item) => artifactVersionSchema.parse(item),
    ),
    shared: booleanValue(required(object, "shared", path), `${path}.shared`),
    createdAt: isoTimestamp(
      required(object, "createdAt", path),
      `${path}.createdAt`,
    ),
  };
}

export const artifactSummarySchema: ContractSchema<ArtifactSummary> =
  defineContractSchema(
    "ArtifactSummary",
    {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "name",
        "mediaKind",
        "sourceRunId",
        "currentVersion",
        "shared",
        "createdAt",
      ],
      properties: {
        id: { type: "string", pattern: "^art_[0-9a-f]{32}$" },
        name: { type: "string", minLength: 1, maxLength: 255 },
        mediaKind: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,63}$" },
        sourceRunId: { type: ["string", "null"] },
        currentVersion: {
          anyOf: [artifactVersionSchema.jsonSchema, { type: "null" }],
        },
        shared: { type: "boolean" },
        createdAt: { type: "string", format: "date-time" },
      },
    },
    artifactSummary,
  );

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
  const followCurrent = booleanValue(
    required(object, "followCurrent", path),
    `${path}.followCurrent`,
  );
  const artifactVersionId = nullable(
    required(object, "artifactVersionId", path),
    `${path}.artifactVersionId`,
    artifactVersionIdParser,
  );
  if (followCurrent === (artifactVersionId !== null)) {
    validationError(
      `${path}.artifactVersionId`,
      "invalid_value",
      "must be null only for follow-current links",
    );
  }
  return {
    id: shareLinkIdParser(required(object, "id", path), `${path}.id`),
    artifactId: artifactIdParser(
      required(object, "artifactId", path),
      `${path}.artifactId`,
    ),
    artifactVersionId,
    followCurrent,
    expiresAt: nullable(
      required(object, "expiresAt", path),
      `${path}.expiresAt`,
      isoTimestamp,
    ),
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
    requireAuth: booleanValue(
      required(object, "requireAuth", path),
      `${path}.requireAuth`,
    ),
    contentDisposition: enumValue(
      required(object, "contentDisposition", path),
      `${path}.contentDisposition`,
      ["attachment", "inline"] as const,
    ),
    status: enumValue(
      required(object, "status", path),
      `${path}.status`,
      SHARE_LINK_STATUSES,
    ),
    createdAt: isoTimestamp(
      required(object, "createdAt", path),
      `${path}.createdAt`,
    ),
  };
}

export const shareLinkSchema: ContractSchema<ShareLinkResource> =
  defineContractSchema(
    "ShareLinkResource",
    {
      type: "object",
      additionalProperties: false,
      required: [
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
      ],
      properties: {
        id: { type: "string", pattern: "^share_[0-9a-f]{32}$" },
        artifactId: { type: "string", pattern: "^art_[0-9a-f]{32}$" },
        artifactVersionId: { type: ["string", "null"] },
        followCurrent: { type: "boolean" },
        expiresAt: { type: ["string", "null"], format: "date-time" },
        maxResolutions: { type: ["integer", "null"], minimum: 1 },
        resolutionCount: { type: "integer", minimum: 0 },
        requireAuth: { type: "boolean" },
        contentDisposition: { enum: ["attachment", "inline"] },
        status: { type: "string", enum: SHARE_LINK_STATUSES },
        createdAt: { type: "string", format: "date-time" },
      },
    },
    shareLink,
  );

export const artifactDetailSchema: ContractSchema<ArtifactDetail> =
  defineContractSchema(
    "ArtifactDetail",
    {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "name",
        "mediaKind",
        "sourceRunId",
        "currentVersion",
        "shared",
        "createdAt",
        "versions",
        "shares",
      ],
      properties: {
        ...(artifactSummarySchema.jsonSchema.properties as Record<
          string,
          unknown
        >),
        versions: {
          type: "array",
          maxItems: 1_000,
          items: artifactVersionSchema.jsonSchema,
        },
        shares: {
          type: "array",
          maxItems: 1_000,
          items: shareLinkSchema.jsonSchema,
        },
      },
    },
    (value, path): ArtifactDetail => {
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
      const summary = artifactSummary(
        {
          id: object.id,
          name: object.name,
          mediaKind: object.mediaKind,
          sourceRunId: object.sourceRunId,
          currentVersion: object.currentVersion,
          shared: object.shared,
          createdAt: object.createdAt,
        },
        path,
      );
      return {
        ...summary,
        versions: arrayValue(
          required(object, "versions", path),
          `${path}.versions`,
          (item) => artifactVersionSchema.parse(item),
          { maxItems: 1_000 },
        ),
        shares: arrayValue(
          required(object, "shares", path),
          `${path}.shares`,
          (item) => shareLinkSchema.parse(item),
          { maxItems: 1_000 },
        ),
      };
    },
  );

export const listArtifactsRequestSchema: ContractSchema<ListArtifactsRequest> =
  defineContractSchema(
    "ListArtifactsRequest",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...(cursorPaginationRequestSchema.jsonSchema.properties as Record<
          string,
          unknown
        >),
        mediaKind: { type: "string", maxLength: 64 },
        sourceRunId: { type: "string", pattern: "^run_[0-9a-f]{32}$" },
        shared: { type: "boolean" },
        search: { type: "string", minLength: 1, maxLength: 100 },
      },
    },
    (value, path): ListArtifactsRequest => {
      const object = strictObject(value, path, [
        "cursor",
        "limit",
        "mediaKind",
        "sourceRunId",
        "shared",
        "search",
      ]);
      const page = cursorPaginationRequestSchema.parse({
        ...(Object.hasOwn(object, "cursor") ? { cursor: object.cursor } : {}),
        ...(Object.hasOwn(object, "limit") ? { limit: object.limit } : {}),
      });
      const mediaKind = optional(
        object,
        "mediaKind",
        path,
        (item, itemPath) =>
          stringValue(item, itemPath, { pattern: MEDIA_KIND_PATTERN }),
      );
      const sourceRunId = optional(object, "sourceRunId", path, runIdParser);
      const shared = optional(object, "shared", path, booleanValue);
      const search = optional(
        object,
        "search",
        path,
        (item, itemPath) =>
          stringValue(item, itemPath, {
            minLength: 1,
            maxLength: 100,
            trim: true,
          }),
      );
      return {
        ...page,
        ...(mediaKind === undefined ? {} : { mediaKind }),
        ...(sourceRunId === undefined ? {} : { sourceRunId }),
        ...(shared === undefined ? {} : { shared }),
        ...(search === undefined ? {} : { search }),
      };
    },
  );

function uploadTarget(value: unknown, path: string): UploadTarget {
  const broad = strictObject(value, path, [
    "kind",
    "name",
    "mediaKind",
    "retentionPolicyId",
    "artifactId",
  ]);
  const kind = enumValue(
    required(broad, "kind", path),
    `${path}.kind`,
    ["new_artifact", "new_version"] as const,
  );
  if (kind === "new_version") {
    const object = strictObject(value, path, ["kind", "artifactId"]);
    return {
      kind,
      artifactId: artifactIdParser(
        required(object, "artifactId", path),
        `${path}.artifactId`,
      ),
    };
  }
  const object = strictObject(value, path, [
    "kind",
    "name",
    "mediaKind",
    "retentionPolicyId",
  ]);
  const retentionPolicyId = optionalNullable(
    object,
    "retentionPolicyId",
    path,
    (item, itemPath) =>
      stringValue(item, itemPath, { minLength: 1, maxLength: 255 }),
  );
  return {
    kind,
    name: stringValue(required(object, "name", path), `${path}.name`, {
      minLength: 1,
      maxLength: 255,
      trim: true,
    }),
    mediaKind: stringValue(
      required(object, "mediaKind", path),
      `${path}.mediaKind`,
      { pattern: MEDIA_KIND_PATTERN },
    ),
    ...(retentionPolicyId === undefined ? {} : { retentionPolicyId }),
  };
}

export const createArtifactUploadRequestSchema: ContractSchema<
  CreateArtifactUploadRequest
> = defineContractSchema(
  "CreateArtifactUploadRequest",
  {
    type: "object",
    additionalProperties: false,
    required: ["target", "sizeBytes", "mimeType", "sha256", "contentMd5"],
    properties: {
      target: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "name", "mediaKind"],
            properties: {
              kind: { const: "new_artifact" },
              name: { type: "string", minLength: 1, maxLength: 255 },
              mediaKind: {
                type: "string",
                pattern: "^[a-z][a-z0-9._-]{0,63}$",
              },
              retentionPolicyId: { type: ["string", "null"], maxLength: 255 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "artifactId"],
            properties: {
              kind: { const: "new_version" },
              artifactId: {
                type: "string",
                pattern: "^art_[0-9a-f]{32}$",
              },
            },
          },
        ],
      },
      sizeBytes: { type: "integer", minimum: 0 },
      mimeType: { type: "string", maxLength: 255 },
      sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      contentMd5: { type: "string", pattern: "^[A-Za-z0-9+/]{22}==$" },
      width: { type: ["integer", "null"], minimum: 1 },
      height: { type: ["integer", "null"], minimum: 1 },
      durationMs: { type: ["integer", "null"], minimum: 1 },
      metadata: { type: "object" },
      sourceRunId: { type: ["string", "null"] },
    },
  },
  (value, path): CreateArtifactUploadRequest => {
    const object = strictObject(value, path, [
      "target",
      "sizeBytes",
      "mimeType",
      "sha256",
      "contentMd5",
      "width",
      "height",
      "durationMs",
      "metadata",
      "sourceRunId",
    ]);
    const width = optionalPositiveInteger(object, "width", path);
    const height = optionalPositiveInteger(object, "height", path);
    const durationMs = optionalPositiveInteger(object, "durationMs", path);
    const metadata = optional(
      object,
      "metadata",
      path,
      (item, itemPath) =>
        jsonObject(item, itemPath, { rejectUrls: true, maxBytes: 64 * 1024 }),
    );
    const sourceRunId = optionalNullable(
      object,
      "sourceRunId",
      path,
      runIdParser,
    );
    return {
      target: uploadTarget(required(object, "target", path), `${path}.target`),
      sizeBytes: integerValue(
        required(object, "sizeBytes", path),
        `${path}.sizeBytes`,
        { minimum: 0 },
      ),
      mimeType: stringValue(
        required(object, "mimeType", path),
        `${path}.mimeType`,
        { minLength: 1, maxLength: 255, pattern: MIME_TYPE_PATTERN },
      ),
      sha256: stringValue(
        required(object, "sha256", path),
        `${path}.sha256`,
        { pattern: SHA256_PATTERN },
      ),
      contentMd5: stringValue(
        required(object, "contentMd5", path),
        `${path}.contentMd5`,
        { pattern: CONTENT_MD5_PATTERN },
      ),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(sourceRunId === undefined ? {} : { sourceRunId }),
    };
  },
);

function uploadAuthorization(
  value: unknown,
  path: string,
  method: "GET" | "PUT",
): UploadAuthorizationResource | DownloadAuthorizationResource {
  const object = strictObject(value, path, [
    "method",
    "url",
    "expiresAt",
    "requiredHeaders",
  ]);
  const actualMethod = enumValue(
    required(object, "method", path),
    `${path}.method`,
    [method] as const,
  );
  return {
    method: actualMethod,
    url: safeUrl(required(object, "url", path), `${path}.url`),
    expiresAt: isoTimestamp(
      required(object, "expiresAt", path),
      `${path}.expiresAt`,
    ),
    requiredHeaders: stringRecord(
      required(object, "requiredHeaders", path),
      `${path}.requiredHeaders`,
    ),
  };
}

export const uploadAuthorizationSchema: ContractSchema<
  UploadAuthorizationResource
> = defineContractSchema(
  "UploadAuthorizationResource",
  {
    type: "object",
    additionalProperties: false,
    required: ["method", "url", "expiresAt", "requiredHeaders"],
    properties: {
      method: { const: "PUT" },
      url: { type: "string", format: "uri", maxLength: 4_096 },
      expiresAt: { type: "string", format: "date-time" },
      requiredHeaders: {
        type: "object",
        additionalProperties: { type: "string", maxLength: 4_096 },
      },
    },
  },
  (value, path) =>
    uploadAuthorization(value, path, "PUT") as UploadAuthorizationResource,
);

export const downloadAuthorizationSchema: ContractSchema<
  DownloadAuthorizationResource
> = defineContractSchema(
  "DownloadAuthorizationResource",
  {
    type: "object",
    additionalProperties: false,
    required: ["method", "url", "expiresAt", "requiredHeaders"],
    properties: {
      method: { const: "GET" },
      url: { type: "string", format: "uri", maxLength: 4_096 },
      expiresAt: { type: "string", format: "date-time" },
      requiredHeaders: {
        type: "object",
        additionalProperties: { type: "string", maxLength: 4_096 },
      },
    },
  },
  (value, path) =>
    uploadAuthorization(value, path, "GET") as DownloadAuthorizationResource,
);

export const createArtifactDownloadRequestSchema: ContractSchema<
  CreateArtifactDownloadRequest
> = defineContractSchema(
  "CreateArtifactDownloadRequest",
  {
    type: "object",
    additionalProperties: false,
    required: ["artifactId"],
    properties: {
      artifactId: { type: "string", pattern: "^art_[0-9a-f]{32}$" },
      artifactVersionId: {
        type: "string",
        pattern: "^aver_[0-9a-f]{32}$",
      },
      contentDisposition: { enum: ["attachment", "inline"] },
      expiresInSeconds: { type: "integer", minimum: 1, maximum: 3_600 },
    },
  },
  (value, path): CreateArtifactDownloadRequest => {
    const object = strictObject(value, path, [
      "artifactId",
      "artifactVersionId",
      "contentDisposition",
      "expiresInSeconds",
    ]);
    const artifactVersionId = optional(
      object,
      "artifactVersionId",
      path,
      artifactVersionIdParser,
    );
    const contentDisposition = optional(
      object,
      "contentDisposition",
      path,
      (item, itemPath) =>
        enumValue(item, itemPath, ["attachment", "inline"] as const),
    );
    const expiresInSeconds = optional(
      object,
      "expiresInSeconds",
      path,
      (item, itemPath) =>
        integerValue(item, itemPath, { minimum: 1, maximum: 3_600 }),
    );
    return {
      artifactId: artifactIdParser(
        required(object, "artifactId", path),
        `${path}.artifactId`,
      ),
      ...(artifactVersionId === undefined ? {} : { artifactVersionId }),
      ...(contentDisposition === undefined ? {} : { contentDisposition }),
      ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
    };
  },
);

export const createArtifactDownloadResultSchema: ContractSchema<
  CreateArtifactDownloadResult
> = defineContractSchema(
  "CreateArtifactDownloadResult",
  {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "artifactId", "artifactVersionId", "download"],
        properties: {
          kind: { const: "authorized" },
          artifactId: { type: "string", pattern: "^art_[0-9a-f]{32}$" },
          artifactVersionId: {
            type: "string",
            pattern: "^aver_[0-9a-f]{32}$",
          },
          download: downloadAuthorizationSchema.jsonSchema,
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { const: "not_found" } },
      },
    ],
  },
  (value, path): CreateArtifactDownloadResult => {
    const object = strictObject(value, path, [
      "kind",
      "artifactId",
      "artifactVersionId",
      "download",
    ]);
    const kind = enumValue(
      required(object, "kind", path),
      `${path}.kind`,
      ["authorized", "not_found"] as const,
    );
    if (kind === "not_found") {
      strictObject(value, path, ["kind"]);
      return { kind };
    }
    return {
      kind,
      artifactId: artifactIdParser(
        required(object, "artifactId", path),
        `${path}.artifactId`,
      ),
      artifactVersionId: artifactVersionIdParser(
        required(object, "artifactVersionId", path),
        `${path}.artifactVersionId`,
      ),
      download: downloadAuthorizationSchema.parse(
        required(object, "download", path),
      ),
    };
  },
);

export const artifactUploadSchema: ContractSchema<ArtifactUploadResource> =
  defineContractSchema(
    "ArtifactUploadResource",
    {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "artifactId",
        "artifactVersionId",
        "sequence",
        "status",
        "authorization",
      ],
      properties: {
        id: { type: "string", pattern: "^upl_[0-9a-f]{32}$" },
        artifactId: { type: "string", pattern: "^art_[0-9a-f]{32}$" },
        artifactVersionId: { type: "string", pattern: "^aver_[0-9a-f]{32}$" },
        sequence: { type: "integer", minimum: 1 },
        status: { type: "string", enum: ARTIFACT_UPLOAD_STATUSES },
        authorization: {
          anyOf: [uploadAuthorizationSchema.jsonSchema, { type: "null" }],
        },
      },
    },
    (value, path): ArtifactUploadResource => {
      const object = strictObject(value, path, [
        "id",
        "artifactId",
        "artifactVersionId",
        "sequence",
        "status",
        "authorization",
      ]);
      const status = enumValue(
        required(object, "status", path),
        `${path}.status`,
        ARTIFACT_UPLOAD_STATUSES,
      );
      const authorization = nullable(
        required(object, "authorization", path),
        `${path}.authorization`,
        (item) => uploadAuthorizationSchema.parse(item),
      );
      if ((status === "pending") !== (authorization !== null)) {
        validationError(
          `${path}.authorization`,
          "invalid_value",
          "must be present only while an upload is pending",
        );
      }
      return {
        id: artifactUploadIdParser(required(object, "id", path), `${path}.id`),
        artifactId: artifactIdParser(
          required(object, "artifactId", path),
          `${path}.artifactId`,
        ),
        artifactVersionId: artifactVersionIdParser(
          required(object, "artifactVersionId", path),
          `${path}.artifactVersionId`,
        ),
        sequence: integerValue(
          required(object, "sequence", path),
          `${path}.sequence`,
          { minimum: 1 },
        ),
        status,
        authorization,
      };
    },
  );

export const createShareLinkRequestSchema: ContractSchema<
  CreateShareLinkRequest
> = defineContractSchema(
  "CreateShareLinkRequest",
  {
    type: "object",
    additionalProperties: false,
    required: ["artifactId", "followCurrent", "contentDisposition"],
    properties: {
      artifactId: { type: "string", pattern: "^art_[0-9a-f]{32}$" },
      followCurrent: { type: "boolean" },
      artifactVersionId: { type: ["string", "null"] },
      expiresAt: { type: ["string", "null"], format: "date-time" },
      maxResolutions: { type: ["integer", "null"], minimum: 1 },
      requireAuth: { type: "boolean", default: false },
      contentDisposition: { enum: ["attachment", "inline"] },
    },
  },
  (value, path): CreateShareLinkRequest => {
    const object = strictObject(value, path, [
      "artifactId",
      "followCurrent",
      "artifactVersionId",
      "expiresAt",
      "maxResolutions",
      "requireAuth",
      "contentDisposition",
    ]);
    const followCurrent = booleanValue(
      required(object, "followCurrent", path),
      `${path}.followCurrent`,
    );
    const artifactVersionId = optionalNullable(
      object,
      "artifactVersionId",
      path,
      artifactVersionIdParser,
    );
    if (
      (followCurrent && artifactVersionId != null) ||
      (!followCurrent && artifactVersionId == null)
    ) {
      validationError(
        `${path}.artifactVersionId`,
        "invalid_value",
        "must be absent for follow-current links and present for pinned links",
      );
    }
    const expiresAt = optionalNullable(object, "expiresAt", path, isoTimestamp);
    const maxResolutions = optionalPositiveInteger(
      object,
      "maxResolutions",
      path,
    );
    const requireAuth = optional(object, "requireAuth", path, booleanValue);
    return {
      artifactId: artifactIdParser(
        required(object, "artifactId", path),
        `${path}.artifactId`,
      ),
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
  },
);

const artifactPageSchema: ContractSchema<CursorPage<ArtifactSummary>> =
  createCursorPageSchema(artifactSummarySchema);

export const listArtifactsResultSchema: ContractSchema<ListArtifactsResult> =
  defineContractSchema(
    "ListArtifactsResult",
    {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "items", "nextCursor"],
          properties: {
            kind: { const: "ok" },
            ...(artifactPageSchema.jsonSchema.properties as Record<
              string,
              unknown
            >),
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { const: "not_found" } },
        },
      ],
    },
    (value, path): ListArtifactsResult => {
      const object = strictObject(value, path, ["kind", "items", "nextCursor"]);
      const kind = enumValue(
        required(object, "kind", path),
        `${path}.kind`,
        ["ok", "not_found"] as const,
      );
      if (kind === "not_found") {
        strictObject(value, path, ["kind"]);
        return { kind };
      }
      const page = artifactPageSchema.parse({
        items: required(object, "items", path),
        nextCursor: required(object, "nextCursor", path),
      });
      return { kind, ...page };
    },
  );

export const getArtifactResultSchema: ContractSchema<GetArtifactResult> =
  defineContractSchema(
    "GetArtifactResult",
    {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "artifact"],
          properties: {
            kind: { const: "found" },
            artifact: artifactDetailSchema.jsonSchema,
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { const: "not_found" } },
        },
      ],
    },
    (value, path): GetArtifactResult => {
      const object = strictObject(value, path, ["kind", "artifact"]);
      const kind = enumValue(
        required(object, "kind", path),
        `${path}.kind`,
        ["found", "not_found"] as const,
      );
      if (kind === "not_found") {
        strictObject(value, path, ["kind"]);
        return { kind };
      }
      return {
        kind,
        artifact: artifactDetailSchema.parse(
          required(object, "artifact", path),
        ),
      };
    },
  );

export const createArtifactUploadResultSchema: ContractSchema<
  CreateArtifactUploadResult
> = defineContractSchema(
  "CreateArtifactUploadResult",
  {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "upload"],
        properties: {
          kind: { const: "created" },
          upload: artifactUploadSchema.jsonSchema,
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { enum: ["not_found", "quota_exceeded"] } },
      },
    ],
  },
  (value, path): CreateArtifactUploadResult => {
    const object = strictObject(value, path, ["kind", "upload"]);
    const kind = enumValue(
      required(object, "kind", path),
      `${path}.kind`,
      ["created", "not_found", "quota_exceeded"] as const,
    );
    if (kind !== "created") {
      strictObject(value, path, ["kind"]);
      return { kind };
    }
    return {
      kind,
      upload: artifactUploadSchema.parse(required(object, "upload", path)),
    };
  },
);

export const completeArtifactUploadResultSchema: ContractSchema<
  CompleteArtifactUploadResult
> = defineContractSchema(
  "CompleteArtifactUploadResult",
  {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "artifactId",
          "artifactVersionId",
          "becameCurrent",
        ],
        properties: {
          kind: { const: "completed" },
          artifactId: { type: "string", pattern: "^art_[0-9a-f]{32}$" },
          artifactVersionId: {
            type: "string",
            pattern: "^aver_[0-9a-f]{32}$",
          },
          becameCurrent: { type: "boolean" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "reason"],
        properties: {
          kind: { const: "verification_failed" },
          reason: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { enum: ["pending", "expired", "not_found"] },
        },
      },
    ],
  },
  (value, path): CompleteArtifactUploadResult => {
    const object = strictObject(value, path, [
      "kind",
      "artifactId",
      "artifactVersionId",
      "becameCurrent",
      "reason",
    ]);
    const kind = enumValue(
      required(object, "kind", path),
      `${path}.kind`,
      [
        "completed",
        "pending",
        "expired",
        "verification_failed",
        "not_found",
      ] as const,
    );
    if (kind === "completed") {
      strictObject(value, path, [
        "kind",
        "artifactId",
        "artifactVersionId",
        "becameCurrent",
      ]);
      return {
        kind,
        artifactId: artifactIdParser(
          required(object, "artifactId", path),
          `${path}.artifactId`,
        ),
        artifactVersionId: artifactVersionIdParser(
          required(object, "artifactVersionId", path),
          `${path}.artifactVersionId`,
        ),
        becameCurrent: booleanValue(
          required(object, "becameCurrent", path),
          `${path}.becameCurrent`,
        ),
      };
    }
    if (kind === "verification_failed") {
      strictObject(value, path, ["kind", "reason"]);
      return {
        kind,
        reason: safeCodeParser(
          required(object, "reason", path),
          `${path}.reason`,
        ),
      };
    }
    strictObject(value, path, ["kind"]);
    return { kind };
  },
);

export const createShareLinkResultSchema: ContractSchema<
  CreateShareLinkResult
> = defineContractSchema(
  "CreateShareLinkResult",
  {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "shareLinkId", "token", "publicPath"],
        properties: {
          kind: { const: "created" },
          shareLinkId: {
            type: "string",
            pattern: "^share_[0-9a-f]{32}$",
          },
          token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
          publicPath: {
            type: "string",
            pattern: "^/s/[A-Za-z0-9_-]{43}$",
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { enum: ["not_found", "conflict"] } },
      },
    ],
  },
  (value, path): CreateShareLinkResult => {
    const object = strictObject(value, path, [
      "kind",
      "shareLinkId",
      "token",
      "publicPath",
    ]);
    const kind = enumValue(
      required(object, "kind", path),
      `${path}.kind`,
      ["created", "not_found", "conflict"] as const,
    );
    if (kind !== "created") {
      strictObject(value, path, ["kind"]);
      return { kind };
    }
    const token = stringValue(
      required(object, "token", path),
      `${path}.token`,
      { pattern: SHARE_TOKEN_PATTERN },
    );
    const publicPath = stringValue(
      required(object, "publicPath", path),
      `${path}.publicPath`,
      { pattern: /^\/s\/[A-Za-z0-9_-]{43}$/ },
    );
    if (publicPath !== `/s/${token}`) {
      validationError(
        `${path}.publicPath`,
        "invalid_value",
        "must identify the returned token",
      );
    }
    return {
      kind,
      shareLinkId: shareLinkIdParser(
        required(object, "shareLinkId", path),
        `${path}.shareLinkId`,
      ),
      token,
      publicPath,
    };
  },
);

export const revokeShareLinkResultSchema: ContractSchema<
  RevokeShareLinkResult
> = defineContractSchema(
  "RevokeShareLinkResult",
  {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: {
      kind: { enum: ["revoked", "already_revoked", "not_found"] },
    },
  },
  (value, path): RevokeShareLinkResult => {
    const object = strictObject(value, path, ["kind"]);
    return {
      kind: enumValue(
        required(object, "kind", path),
        `${path}.kind`,
        ["revoked", "already_revoked", "not_found"] as const,
      ),
    };
  },
);

export const resolveShareLinkResultSchema: ContractSchema<
  ResolveShareLinkResult
> = defineContractSchema(
  "ResolveShareLinkResult",
  {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "shareLinkId",
          "artifactId",
          "artifactVersionId",
          "download",
        ],
        properties: {
          kind: { const: "authorized" },
          shareLinkId: {
            type: "string",
            pattern: "^share_[0-9a-f]{32}$",
          },
          artifactId: { type: "string", pattern: "^art_[0-9a-f]{32}$" },
          artifactVersionId: {
            type: "string",
            pattern: "^aver_[0-9a-f]{32}$",
          },
          download: downloadAuthorizationSchema.jsonSchema,
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { enum: ["authentication_required", "unavailable"] },
        },
      },
    ],
  },
  (value, path): ResolveShareLinkResult => {
    const object = strictObject(value, path, [
      "kind",
      "shareLinkId",
      "artifactId",
      "artifactVersionId",
      "download",
    ]);
    const kind = enumValue(
      required(object, "kind", path),
      `${path}.kind`,
      ["authorized", "authentication_required", "unavailable"] as const,
    );
    if (kind !== "authorized") {
      strictObject(value, path, ["kind"]);
      return { kind };
    }
    return {
      kind,
      shareLinkId: shareLinkIdParser(
        required(object, "shareLinkId", path),
        `${path}.shareLinkId`,
      ),
      artifactId: artifactIdParser(
        required(object, "artifactId", path),
        `${path}.artifactId`,
      ),
      artifactVersionId: artifactVersionIdParser(
        required(object, "artifactVersionId", path),
        `${path}.artifactVersionId`,
      ),
      download: downloadAuthorizationSchema.parse(
        required(object, "download", path),
      ),
    };
  },
);
