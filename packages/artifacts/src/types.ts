import type {
  DownloadAuthorization,
  UploadAuthorization,
} from "@relay/storage/types";

export type VerificationStatus =
  | "pending"
  | "head_verified"
  | "cryptographically_verified"
  | "failed";

export interface ArtifactVersionRecord {
  readonly id: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly contentMd5: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly source: "upload" | "generated" | "restore";
  readonly sourceRunId: string | null;
  readonly parentVersionId: string | null;
  readonly verificationStatus: VerificationStatus;
  readonly purgeStatus: "not_requested" | "deleting" | "deleted";
  readonly purgeStartedAt: Date | null;
  readonly purgedAt: Date | null;
  readonly createdAt: Date;
}

export interface ArtifactRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly mediaKind: string;
  readonly currentVersionId: string | null;
  readonly sourceRunId: string | null;
  readonly deletedAt: Date | null;
  readonly purgedAt: Date | null;
  readonly createdAt: Date;
  readonly versions: readonly ArtifactVersionRecord[];
}

export interface PendingUploadAuthorization {
  readonly uploadId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly sequence: number;
  readonly upload: UploadAuthorization;
}

export type BeginUploadResult =
  | { readonly kind: "created"; readonly value: PendingUploadAuthorization }
  | { readonly kind: "not_found" }
  | { readonly kind: "quota_exceeded" };

export type CompleteUploadResult =
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

export interface OutputItemRecord {
  readonly ordinal: number;
  readonly name: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly artifactVersionId: string | null;
  readonly errorCode: string | null;
}

export interface OutputSetRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly requestedCount: number;
  readonly producedCount: number;
  readonly completeness: "pending" | "complete" | "partial" | "failed";
  readonly warnings: readonly unknown[];
  readonly items: readonly OutputItemRecord[];
}

export type ArtifactDownloadResult =
  | {
    readonly kind: "authorized";
    readonly artifactId: string;
    readonly artifactVersionId: string;
    readonly download: DownloadAuthorization;
  }
  | { readonly kind: "not_found" };

export interface ShareLinkSecret {
  readonly shareLinkId: string;
  /** Returned only at creation; only its hash is durable. */
  readonly token: string;
}

export type CreateShareLinkResult =
  | { readonly kind: "created"; readonly value: ShareLinkSecret }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" };

export type RevokeShareLinkResult =
  | { readonly kind: "revoked" }
  | { readonly kind: "already_revoked" }
  | { readonly kind: "not_found" };

export type RecordOutputFailureResult =
  | { readonly kind: "recorded" }
  | { readonly kind: "already_recorded" }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" };

export type CleanupExecutionResult =
  | { readonly kind: "deleted" }
  | { readonly kind: "retry_scheduled" }
  | { readonly kind: "lease_lost" };

export type PurgeExecutionResult =
  | { readonly kind: "purged" }
  | { readonly kind: "retry_scheduled" }
  | { readonly kind: "lease_lost" };

/**
 * `maxResolutions` counts successful Relay URL issuances, not byte downloads.
 * A returned S3 URL remains reusable until its own expiry; revocation blocks
 * future resolutions but cannot invalidate an already-issued bearer URL.
 */
export type ResolveShareLinkResult =
  | {
    readonly kind: "authorized";
    readonly shareLinkId: string;
    readonly artifactId: string;
    readonly artifactVersionId: string;
    readonly download: DownloadAuthorization;
  }
  | { readonly kind: "authentication_required" }
  | { readonly kind: "unavailable" };
