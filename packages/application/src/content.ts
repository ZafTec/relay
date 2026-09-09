import { z } from "zod/v4";
import { PUBLIC_ID_PATTERNS } from "@relay/contracts";
import type {
  ArtifactCommandApplicationService,
  ArtifactReadApplicationService,
} from "./services.ts";
import {
  validateIdempotencyKey,
  validateWorkspaceActorContext,
  type WorkspaceActorContext,
} from "./context.ts";

export const MAX_INLINE_CONTENT_BYTES = 4 * 1024 * 1024;
type AccessOptionsShape = {
  access: z.ZodDefault<
    z.ZodEnum<{ temporary: "temporary"; permanent: "permanent" }>
  >;
  expiresInSeconds: z.ZodOptional<z.ZodNumber>;
};
const accessOptions: AccessOptionsShape = {
  access: z.enum(["temporary", "permanent"]).default("temporary"),
  expiresInSeconds: z.number().int().min(1).max(3600).optional(),
};
export interface UploadContentRequest {
  name: string;
  mimeType: string;
  encoding: "base64" | "text";
  content: string;
  access?: "temporary" | "permanent";
  expiresInSeconds?: number;
}
export interface ContentAccessRequest {
  artifactId: string;
  artifactVersionId?: string;
  access?: "temporary" | "permanent";
  expiresInSeconds?: number;
}
export const uploadContentSchema: z.ZodObject<
  AccessOptionsShape & {
    name: z.ZodString;
    mimeType: z.ZodString;
    encoding: z.ZodEnum<{ base64: "base64"; text: "text" }>;
    content: z.ZodString;
  },
  z.core.$strict
> = z.object({
  name: z.string().trim().min(1).max(255).refine(
    (value) =>
      !Array.from(value).some((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) && !/\b[a-z][a-z0-9+.-]*:\/\//i.test(value),
    "Use a filename, not a URL",
  ),
  mimeType: z.string().max(255).regex(
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i,
  ),
  encoding: z.enum(["base64", "text"]),
  content: z.string().max(Math.ceil(MAX_INLINE_CONTENT_BYTES / 3) * 4),
  ...accessOptions,
}).strict().refine(
  (value) =>
    value.access !== "permanent" || value.expiresInSeconds === undefined,
  "Permanent links do not expire",
) satisfies z.ZodType<
  UploadContentRequest & { access: "temporary" | "permanent" },
  UploadContentRequest
>;
export const contentAccessSchema: z.ZodObject<
  AccessOptionsShape & {
    artifactId: z.ZodString;
    artifactVersionId: z.ZodOptional<z.ZodString>;
  },
  z.core.$strict
> = z.object({
  artifactId: z.string().regex(PUBLIC_ID_PATTERNS.artifact),
  artifactVersionId: z.string().regex(PUBLIC_ID_PATTERNS.artifactVersion)
    .optional(),
  ...accessOptions,
}).strict().refine(
  (value) =>
    value.access !== "permanent" || value.expiresInSeconds === undefined,
  "Permanent links do not expire",
) satisfies z.ZodType<
  ContentAccessRequest & { access: "temporary" | "permanent" },
  ContentAccessRequest
>;
export type ContentFailure = {
  kind:
    | "not_found"
    | "quota_exceeded"
    | "storage_error"
    | "idempotency_conflict"
    | "expired"
    | "verification_failed"
    | "pending"
    | "conflict";
};
export interface ContentAccess {
  kind: "authorized";
  artifactId: string;
  artifactVersionId: string;
  url: string;
  access: "temporary" | "permanent";
  expiresAt: string | null;
  shareLinkId?: string;
}
export type ContentAccessResult = ContentAccess | ContentFailure;
export interface ContentApplicationService {
  upload(
    context: WorkspaceActorContext,
    request: UploadContentRequest,
    idempotencyKey: string,
  ): Promise<ContentAccessResult>;
  access(
    context: WorkspaceActorContext,
    request: ContentAccessRequest,
    idempotencyKey?: string,
  ): Promise<ContentAccessResult>;
}
export interface ContentUploadPort {
  uploadContent(
    input: WorkspaceActorContext & {
      name: string;
      mediaKind: string;
      mimeType: string;
      bytes: Uint8Array;
      metadata?: Readonly<Record<string, unknown>>;
      idempotencyKey: string;
    },
  ): Promise<
    ContentFailure | {
      kind: "completed";
      artifactId: string;
      artifactVersionId: string;
    }
  >;
}

export function decodeUploadedContent(
  request: Pick<UploadContentRequest, "encoding" | "content">,
): Uint8Array {
  let bytes: Uint8Array;
  if (request.encoding === "text") {
    bytes = new TextEncoder().encode(request.content);
  } else {
    if (
      request.content.length > Math.ceil(MAX_INLINE_CONTENT_BYTES / 3) * 4 ||
      request.content.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(request.content)
    ) {
      throw new TypeError(
        "Content must be canonical base64 without a data URL prefix",
      );
    }
    const binary = atob(request.content);
    if (btoa(binary) !== request.content) {
      throw new TypeError("Content must be canonical base64");
    }
    bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  }
  if (bytes.byteLength > MAX_INLINE_CONTENT_BYTES) {
    throw new RangeError("Content exceeds 4 MiB; use a direct upload");
  }
  return bytes;
}

async function contentKey(key: string): Promise<string> {
  validateIdempotencyKey(key);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return `content:${
    Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")).join("")
  }`;
}

export function createContentService(
  uploadPort: ContentUploadPort,
  artifacts: ArtifactCommandApplicationService & ArtifactReadApplicationService,
  appOrigin: string,
): ContentApplicationService {
  const origin = new URL(appOrigin).origin;
  async function access(
    context: WorkspaceActorContext,
    raw: ContentAccessRequest,
    idempotencyKey?: string,
  ): Promise<ContentAccessResult> {
    validateWorkspaceActorContext(context);
    const request = contentAccessSchema.parse(raw);
    if (request.access === "temporary") {
      const result = await artifacts.createDownload(context, {
        artifactId: request.artifactId,
        artifactVersionId: request.artifactVersionId,
        contentDisposition: "attachment",
        expiresInSeconds: request.expiresInSeconds ?? 300,
      });
      return result.kind !== "authorized" ? result : {
        kind: "authorized",
        artifactId: result.artifactId,
        artifactVersionId: result.artifactVersionId,
        access: "temporary",
        url: result.download.url,
        expiresAt: result.download.expiresAt,
      };
    }
    const key = await contentKey(idempotencyKey ?? "");
    const found = await artifacts.get(context, request.artifactId);
    if (found.kind !== "found") return found;
    const versionId = request.artifactVersionId ??
      found.artifact.currentVersion?.id;
    if (!versionId) return { kind: "not_found" };
    const share = await artifacts.createShareLink(context, {
      artifactId: request.artifactId,
      artifactVersionId: versionId,
      followCurrent: false,
      expiresAt: null,
      requireAuth: false,
      contentDisposition: "attachment",
    }, key);
    return share.kind !== "created" ? share : {
      kind: "authorized",
      artifactId: request.artifactId,
      artifactVersionId: versionId,
      access: "permanent",
      url: new URL(share.publicPath, origin).href,
      expiresAt: null,
      shareLinkId: share.shareLinkId,
    };
  }
  return {
    access,
    async upload(context, raw, idempotencyKey) {
      validateWorkspaceActorContext(context);
      const request = uploadContentSchema.parse(raw);
      const bytes = decodeUploadedContent(request);
      const mimeType = request.mimeType.toLowerCase();
      const mediaKind = mimeType.startsWith("image/")
        ? "image"
        : mimeType.startsWith("audio/")
        ? "audio"
        : mimeType.startsWith("video/")
        ? "video"
        : "document";
      const result = await uploadPort.uploadContent({
        ...context,
        name: request.name,
        mediaKind,
        mimeType,
        bytes,
        idempotencyKey: await contentKey(idempotencyKey),
        metadata: {
          requestedAccess: request.access,
          expiresInSeconds: request.expiresInSeconds ?? null,
        },
      });
      if (result.kind !== "completed") return result;
      const link = await access(context, {
        artifactId: result.artifactId,
        artifactVersionId: result.artifactVersionId,
        access: request.access,
        expiresInSeconds: request.expiresInSeconds,
      }, idempotencyKey);
      return link;
    },
  };
}
