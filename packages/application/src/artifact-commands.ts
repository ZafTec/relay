import {
  type CompleteArtifactUploadResult,
  completeArtifactUploadResultSchema,
  type CreateArtifactDownloadRequest,
  createArtifactDownloadRequestSchema,
  type CreateArtifactDownloadResult,
  createArtifactDownloadResultSchema,
  type CreateArtifactUploadRequest,
  createArtifactUploadRequestSchema,
  type CreateArtifactUploadResult,
  createArtifactUploadResultSchema,
  type CreateShareLinkRequest,
  createShareLinkRequestSchema,
  type CreateShareLinkResult,
  createShareLinkResultSchema,
  PUBLIC_ID_PATTERNS,
  publicSharePath,
  type ResolveShareLinkResult,
  resolveShareLinkResultSchema,
  type RevokeShareLinkResult,
  revokeShareLinkResultSchema,
} from "@relay/contracts";
import type { WorkspaceActorContext } from "./context.ts";
import {
  validateIdempotencyKey,
  validateWorkspaceActorContext,
} from "./context.ts";
import type { ArtifactCommandApplicationService } from "./services.ts";

interface DomainAuthorization {
  readonly method: "GET" | "PUT";
  readonly url: string;
  readonly expiresAt: Date;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface ArtifactCommandPort {
  createArtifactDownloadUrl(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly artifactId: string;
    readonly artifactVersionId?: string;
    readonly contentDisposition?: "attachment" | "inline";
    readonly expiresInSeconds?: number;
  }): Promise<
    | {
      readonly kind: "authorized";
      readonly artifactId: string;
      readonly artifactVersionId: string;
      readonly download: DomainAuthorization & { readonly method: "GET" };
    }
    | { readonly kind: "not_found" }
  >;
  beginDirectUpload(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly target:
      | {
        readonly kind: "new_artifact";
        readonly name: string;
        readonly mediaKind: string;
        readonly retentionPolicyId?: string | null;
      }
      | { readonly kind: "new_version"; readonly artifactId: string };
    readonly sizeBytes: number;
    readonly mimeType: string;
    readonly sha256: string;
    readonly contentMd5: string;
    readonly width?: number | null;
    readonly height?: number | null;
    readonly durationMs?: number | null;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly sourceRunId?: string | null;
    readonly idempotencyKey: string;
  }): Promise<
    | {
      readonly kind: "created";
      readonly value: {
        readonly uploadId: string;
        readonly artifactId: string;
        readonly artifactVersionId: string;
        readonly sequence: number;
        readonly upload: DomainAuthorization & { readonly method: "PUT" };
      };
      readonly replayed: boolean;
    }
    | {
      readonly kind: "completed";
      readonly uploadId: string;
      readonly artifactId: string;
      readonly artifactVersionId: string;
      readonly sequence: number;
      readonly becameCurrent: boolean;
      readonly replayed: true;
    }
    | {
      readonly kind: "expired";
      readonly uploadId: string;
      readonly artifactId: string;
      readonly artifactVersionId: string;
      readonly sequence: number;
      readonly replayed: true;
    }
    | {
      readonly kind: "verification_failed";
      readonly uploadId: string;
      readonly artifactId: string;
      readonly artifactVersionId: string;
      readonly sequence: number;
      readonly reason: string;
      readonly replayed: true;
    }
    | { readonly kind: "not_found"; readonly replayed: false }
    | { readonly kind: "quota_exceeded"; readonly replayed: false }
    | { readonly kind: "idempotency_conflict" }
  >;
  completeUpload(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly uploadId: string;
    readonly idempotencyKey: string;
  }): Promise<
    | {
      readonly kind: "completed";
      readonly artifactId: string;
      readonly artifactVersionId: string;
      readonly becameCurrent: boolean;
      readonly replayed: boolean;
    }
    | { readonly kind: "pending"; readonly replayed: false }
    | { readonly kind: "expired"; readonly replayed: boolean }
    | {
      readonly kind: "verification_failed";
      readonly reason: string;
      readonly replayed: boolean;
    }
    | { readonly kind: "not_found"; readonly replayed: false }
    | { readonly kind: "idempotency_conflict" }
  >;
  createShareLink(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly artifactId: string;
    readonly followCurrent: boolean;
    readonly artifactVersionId?: string | null;
    readonly expiresAt?: Date | null;
    readonly maxResolutions?: number | null;
    readonly requireAuth?: boolean;
    readonly contentDisposition: "attachment" | "inline";
    readonly idempotencyKey: string;
  }): Promise<
    | {
      readonly kind: "created";
      readonly value: {
        readonly shareLinkId: string;
        readonly token: string;
      };
      readonly replayed: boolean;
    }
    | { readonly kind: "not_found"; readonly replayed: false }
    | { readonly kind: "conflict"; readonly replayed: false }
    | { readonly kind: "idempotency_conflict" }
  >;
  revokeShareLink(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly artifactId: string;
    readonly shareLinkId: string;
    readonly idempotencyKey: string;
  }): Promise<
    | { readonly kind: "revoked"; readonly replayed: boolean }
    | { readonly kind: "not_found"; readonly replayed: false }
    | { readonly kind: "idempotency_conflict" }
  >;
  resolveShareLink(input: {
    readonly token: string;
    readonly actorUserId?: string;
  }): Promise<
    | {
      readonly kind: "authorized";
      readonly shareLinkId: string;
      readonly artifactId: string;
      readonly artifactVersionId: string;
      readonly download: DomainAuthorization & { readonly method: "GET" };
    }
    | { readonly kind: "authentication_required" }
    | { readonly kind: "unavailable" }
  >;
}

function validatePublicId(
  value: string,
  pattern: RegExp,
  field: string,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${field} has an invalid format`);
  }
  return value;
}

function actorId(value: string): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 255 ||
    value.trim() !== value ||
    /[\r\n\0]/.test(value)
  ) {
    throw new TypeError("actorUserId has an invalid format");
  }
  return value;
}

export class ArtifactCommandAdapter
  implements ArtifactCommandApplicationService {
  readonly #port: ArtifactCommandPort;

  constructor(port: ArtifactCommandPort) {
    if (port === undefined || port === null) {
      throw new TypeError("an ArtifactCommandPort is required");
    }
    this.#port = port;
  }

  async createDownload(
    rawContext: WorkspaceActorContext,
    rawRequest: CreateArtifactDownloadRequest,
  ): Promise<CreateArtifactDownloadResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const request = createArtifactDownloadRequestSchema.parse(rawRequest);
    const result = await this.#port.createArtifactDownloadUrl({
      ...context,
      ...request,
    });
    if (result.kind === "not_found") {
      return createArtifactDownloadResultSchema.parse(result);
    }
    return createArtifactDownloadResultSchema.parse({
      ...result,
      download: {
        ...result.download,
        expiresAt: result.download.expiresAt.toISOString(),
      },
    });
  }

  async createUpload(
    rawContext: WorkspaceActorContext,
    rawRequest: CreateArtifactUploadRequest,
    rawIdempotencyKey: string,
  ): Promise<CreateArtifactUploadResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const request = createArtifactUploadRequestSchema.parse(rawRequest);
    const result = await this.#port.beginDirectUpload({
      ...context,
      ...request,
      idempotencyKey,
    });
    if (result.kind === "created") {
      return createArtifactUploadResultSchema.parse({
        kind: "created",
        upload: {
          id: result.value.uploadId,
          artifactId: result.value.artifactId,
          artifactVersionId: result.value.artifactVersionId,
          sequence: result.value.sequence,
          status: "pending",
          authorization: {
            ...result.value.upload,
            expiresAt: result.value.upload.expiresAt.toISOString(),
          },
        },
        replayed: result.replayed,
      });
    }
    if (
      result.kind === "completed" || result.kind === "expired" ||
      result.kind === "verification_failed"
    ) {
      return createArtifactUploadResultSchema.parse({
        kind: "created",
        upload: {
          id: result.uploadId,
          artifactId: result.artifactId,
          artifactVersionId: result.artifactVersionId,
          sequence: result.sequence,
          status: result.kind === "completed"
            ? "completed"
            : result.kind === "expired"
            ? "expired"
            : "failed",
          authorization: null,
        },
        replayed: true,
      });
    }
    return createArtifactUploadResultSchema.parse({ kind: result.kind });
  }

  async completeUpload(
    rawContext: WorkspaceActorContext,
    rawUploadId: string,
    rawIdempotencyKey: string,
  ): Promise<CompleteArtifactUploadResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const uploadId = validatePublicId(
      rawUploadId,
      PUBLIC_ID_PATTERNS.artifactUpload,
      "uploadId",
    );
    const result = await this.#port.completeUpload({
      ...context,
      uploadId,
      idempotencyKey,
    });
    return completeArtifactUploadResultSchema.parse(
      result.kind === "not_found" ? { kind: result.kind } : result,
    );
  }

  async createShareLink(
    rawContext: WorkspaceActorContext,
    rawRequest: CreateShareLinkRequest,
    rawIdempotencyKey: string,
  ): Promise<CreateShareLinkResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const request = createShareLinkRequestSchema.parse(rawRequest);
    const result = await this.#port.createShareLink({
      ...context,
      ...request,
      expiresAt: request.expiresAt === undefined || request.expiresAt === null
        ? request.expiresAt
        : new Date(request.expiresAt),
      idempotencyKey,
    });
    if (result.kind !== "created") {
      return createShareLinkResultSchema.parse({ kind: result.kind });
    }
    return createShareLinkResultSchema.parse({
      kind: "created",
      shareLinkId: result.value.shareLinkId,
      token: result.value.token,
      publicPath: publicSharePath(result.value.token),
      replayed: result.replayed,
    });
  }

  async revokeShareLink(
    rawContext: WorkspaceActorContext,
    rawArtifactId: string,
    rawShareLinkId: string,
    rawIdempotencyKey: string,
  ): Promise<RevokeShareLinkResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    const artifactId = validatePublicId(
      rawArtifactId,
      PUBLIC_ID_PATTERNS.artifact,
      "artifactId",
    );
    const shareLinkId = validatePublicId(
      rawShareLinkId,
      PUBLIC_ID_PATTERNS.shareLink,
      "shareLinkId",
    );
    const result = await this.#port.revokeShareLink({
      ...context,
      artifactId,
      shareLinkId,
      idempotencyKey,
    });
    return revokeShareLinkResultSchema.parse(
      result.kind === "not_found" ? { kind: result.kind } : result,
    );
  }

  async resolveShareLink(
    token: string,
    actorUserId?: string,
  ): Promise<ResolveShareLinkResult> {
    const result = await this.#port.resolveShareLink({
      token,
      ...(actorUserId === undefined
        ? {}
        : { actorUserId: actorId(actorUserId) }),
    });
    if (result.kind !== "authorized") {
      return resolveShareLinkResultSchema.parse(result);
    }
    return resolveShareLinkResultSchema.parse({
      ...result,
      download: {
        ...result.download,
        expiresAt: result.download.expiresAt.toISOString(),
      },
    });
  }
}

export function createArtifactCommandAdapter(
  port: ArtifactCommandPort,
): ArtifactCommandApplicationService {
  return new ArtifactCommandAdapter(port);
}
