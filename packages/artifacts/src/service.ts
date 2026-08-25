import { md5Base64, sha256Hex } from "@relay/storage/checksums";
import { createImmutableObjectKey } from "@relay/storage/keys";
import type { ObjectHead, ObjectStorage } from "@relay/storage/types";
import { hasWorkspaceMembership } from "./authorization.ts";
import {
  type ArtifactDatabasePool,
  type ArtifactTransaction,
  withArtifactTransaction,
} from "./database.ts";
import {
  generateArtifactId,
  generateShareSecret,
  hashShareSecret,
} from "./ids.ts";
import type { ArtifactQuota } from "./quota.ts";
import type {
  ArtifactDownloadResult,
  ArtifactRecord,
  ArtifactVersionRecord,
  BeginUploadResult,
  CleanupExecutionResult,
  CompleteUploadResult,
  CreateShareLinkResult,
  OutputItemRecord,
  OutputSetRecord,
  PurgeExecutionResult,
  RecordOutputFailureResult,
  ResolveShareLinkResult,
  RevokeShareLinkResult,
} from "./types.ts";
import {
  ArtifactInputError,
  serializeDurableArray,
  serializeDurableObject,
  validateByteCount,
  validateDisplayName,
  validateErrorCode,
  validateMediaKind,
  validateMimeType,
  validateNonNegativeInteger,
  validatePositiveInteger,
} from "./validation.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTENT_MD5_PATTERN = /^[A-Za-z0-9+/]{22}==$/;
const DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60;
const DEFAULT_CLEANUP_LEASE_SECONDS = 60;
const DEFAULT_PURGE_DELAY_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_DOWNLOAD_TTL_SECONDS = 5 * 60;
const MAX_BATCH_SIZE = 100;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_ERROR_CODE = "storage_delete_failed";

export interface ArtifactServiceOptions {
  readonly pool: ArtifactDatabasePool;
  readonly storage: ObjectStorage;
  readonly quota: ArtifactQuota;
  readonly uploadTtlSeconds?: number;
  readonly cleanupLeaseSeconds?: number;
  readonly purgeDelaySeconds?: number;
  readonly downloadTtlSeconds?: number;
  readonly now?: () => Date;
}

export interface DirectUploadVersionInput {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly target:
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
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly contentMd5: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly sourceRunId?: string | null;
}

export type GetArtifactResult =
  | { readonly kind: "found"; readonly artifact: ArtifactRecord }
  | { readonly kind: "not_found" };

export type SoftDeleteArtifactResult =
  | { readonly kind: "deleted"; readonly purgeAfter: Date }
  | { readonly kind: "already_deleted"; readonly purgeAfter: Date }
  | { readonly kind: "not_found" };

export type RestoreArtifactResult =
  | {
    readonly kind: "restored";
    readonly artifactId: string;
    readonly artifactVersionId: string;
  }
  | { readonly kind: "not_found" }
  | { readonly kind: "quota_exceeded" }
  | { readonly kind: "source_unavailable" }
  | { readonly kind: "conflict" }
  | { readonly kind: "storage_error" };

export type CreateOutputSetResult =
  | { readonly kind: "created"; readonly outputSetId: string }
  | { readonly kind: "already_exists"; readonly outputSetId: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" };

export interface GeneratedOutputInput {
  readonly workspaceId: string;
  readonly outputSetId: string;
  readonly ordinal: number;
  readonly bytes: Uint8Array;
  readonly artifactName: string;
  readonly mediaKind: string;
  readonly mimeType: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type IngestGeneratedOutputResult =
  | {
    readonly kind: "stored";
    readonly artifactId: string;
    readonly artifactVersionId: string;
  }
  | { readonly kind: "already_recorded"; readonly artifactVersionId: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "quota_exceeded" }
  | { readonly kind: "conflict" }
  | { readonly kind: "storage_error" };

export interface ExpiredUpload {
  readonly uploadId: string;
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly objectKey: string;
}

export interface UploadCleanupLease extends ExpiredUpload {
  readonly leaseToken: string;
  readonly storageVersionId: string | null;
}

export interface ArtifactPurgeLease {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly leaseToken: string;
  readonly objects: readonly {
    readonly artifactVersionId: string;
    readonly objectKey: string;
    readonly storageVersionId: string | null;
  }[];
}

interface UploadRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly output_item_id: string | null;
  readonly kind: "direct_upload" | "generated" | "restore";
  readonly object_key: string;
  readonly expected_previous_version_id: string | null;
  readonly expected_size_bytes: string;
  readonly expected_mime_type: string;
  readonly expected_sha256: string;
  readonly content_md5: string;
  readonly status: "pending" | "completed" | "failed" | "expired";
  readonly expires_at: Date;
  readonly failure_code: string | null;
  readonly quota_reservation_id: string;
  readonly quota_state:
    | "reserved"
    | "cleanup_held"
    | "committed"
    | "decremented"
    | "released";
  readonly created_artifact: boolean;
  readonly became_current: boolean | null;
  readonly cleanup_storage_version_id: string | null;
}

interface VersionSourceRow {
  readonly id: string;
  readonly object_key: string;
  readonly storage_version_id: string | null;
  readonly sha256: string;
  readonly content_md5: string;
  readonly size_bytes: string;
  readonly mime_type: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly duration_ms: string | null;
  readonly source_run_id: string | null;
  readonly metadata: unknown;
}

function validateSeconds(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function validateBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw new RangeError(
      `limit must be an integer from 1 to ${MAX_BATCH_SIZE}`,
    );
  }
  return value;
}

function validateOptionalFutureDate(
  value: Date | null | undefined,
  now: Date,
  field: string,
): Date | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now.getTime()) {
    throw new ArtifactInputError(field, "must be a valid future date");
  }
  return date;
}

function laterDate(first: Date, second: Date): Date {
  return first.getTime() >= second.getTime() ? first : second;
}

function validateChecksums(sha256: string, contentMd5: string): void {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new ArtifactInputError(
      "sha256",
      "must be a lowercase SHA-256 digest",
    );
  }
  if (!CONTENT_MD5_PATTERN.test(contentMd5)) {
    throw new ArtifactInputError(
      "contentMd5",
      "must be a base64-encoded MD5 digest",
    );
  }
}

function normalizeRetentionPolicy(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 || normalized.length > 255 ||
    /[\r\n\0]/.test(normalized) || normalized.includes("://")
  ) {
    throw new ArtifactInputError("retentionPolicyId", "has an invalid format");
  }
  return normalized;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function parseJsonArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function headMismatch(row: UploadRow, head: ObjectHead): string | null {
  if (head.key !== row.object_key) return "object_key_mismatch";
  if (head.sizeBytes !== Number(row.expected_size_bytes)) {
    return "size_mismatch";
  }
  if (head.contentType?.trim().toLowerCase() !== row.expected_mime_type) {
    return "mime_type_mismatch";
  }
  if (head.metadata["relay-upload-id"] !== row.id) {
    return "upload_id_mismatch";
  }
  if (head.metadata["relay-sha256"] !== row.expected_sha256) {
    return "sha256_metadata_mismatch";
  }
  if (
    head.checksumSha256 !== null &&
    head.checksumSha256 !== hexToBase64(row.expected_sha256)
  ) {
    return "sha256_checksum_mismatch";
  }
  return null;
}

function terminalUploadResult(row: UploadRow): CompleteUploadResult | null {
  if (row.status === "completed") {
    return {
      kind: "completed",
      artifactId: row.artifact_id,
      artifactVersionId: row.artifact_version_id,
      becameCurrent: row.became_current === true,
    };
  }
  if (row.status === "expired") return { kind: "expired" };
  if (row.status === "failed") {
    return {
      kind: "verification_failed",
      reason: row.failure_code ?? "verification_failed",
    };
  }
  return null;
}

function sourceHeadMismatch(row: VersionSourceRow, head: ObjectHead): boolean {
  if (head.key !== row.object_key) return true;
  if (head.sizeBytes !== Number(row.size_bytes)) return true;
  if (head.contentType?.trim().toLowerCase() !== row.mime_type) return true;
  if (head.metadata["relay-sha256"] !== row.sha256) return true;
  return head.checksumSha256 !== null &&
    head.checksumSha256 !== hexToBase64(row.sha256);
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

async function refreshOutputSet(
  client: ArtifactTransaction,
  workspaceId: string,
  outputSetId: string,
  now: Date,
): Promise<void> {
  const { rows } = await client.query<{
    requested_count: number;
    succeeded: string;
    failed: string;
    pending: string;
    run_id: string;
  }>(
    `select os.requested_count,
            count(*) filter (where oi.status = 'succeeded') as succeeded,
            count(*) filter (where oi.status = 'failed') as failed,
            count(*) filter (where oi.status = 'pending') as pending,
            os.run_id
       from relay.output_sets os
       join relay.output_items oi
         on oi.workspace_id = os.workspace_id and oi.output_set_id = os.id
      where os.workspace_id = $1 and os.id = $2
      group by os.id, os.requested_count, os.run_id`,
    [workspaceId, outputSetId],
  );
  if (rows.length === 0) return;

  const counts = rows[0];
  const succeeded = Number(counts.succeeded);
  const pending = Number(counts.pending);
  const completeness = pending > 0
    ? "pending"
    : succeeded === counts.requested_count
    ? "complete"
    : succeeded > 0
    ? "partial"
    : "failed";

  await client.query(
    `update relay.output_sets
        set produced_count = $3,
            completeness = $4::text,
            finalized_at = case
              when $4::text = 'pending' then null
              else $5::timestamptz
            end
      where workspace_id = $1 and id = $2`,
    [workspaceId, outputSetId, succeeded, completeness, now],
  );
  await client.query(
    `update relay.tool_runs
        set result_completeness = $3
      where workspace_id = $1 and id = $2`,
    [workspaceId, counts.run_id, completeness],
  );
}

export class ArtifactService {
  readonly #pool: ArtifactDatabasePool;
  readonly #storage: ObjectStorage;
  readonly #quota: ArtifactQuota;
  readonly #uploadTtlSeconds: number;
  readonly #cleanupLeaseSeconds: number;
  readonly #purgeDelaySeconds: number;
  readonly #downloadTtlSeconds: number;
  readonly #now: () => Date;

  constructor(options: ArtifactServiceOptions) {
    this.#pool = options.pool;
    this.#storage = options.storage;
    this.#quota = options.quota;
    this.#uploadTtlSeconds = validateSeconds(
      options.uploadTtlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS,
      "uploadTtlSeconds",
    );
    this.#cleanupLeaseSeconds = validateSeconds(
      options.cleanupLeaseSeconds ?? DEFAULT_CLEANUP_LEASE_SECONDS,
      "cleanupLeaseSeconds",
    );
    this.#purgeDelaySeconds = validateSeconds(
      options.purgeDelaySeconds ?? DEFAULT_PURGE_DELAY_SECONDS,
      "purgeDelaySeconds",
    );
    this.#downloadTtlSeconds = validateSeconds(
      options.downloadTtlSeconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS,
      "downloadTtlSeconds",
    );
    this.#now = options.now ?? (() => new Date());
  }

  async beginDirectUpload(
    input: DirectUploadVersionInput,
  ): Promise<BeginUploadResult> {
    const sizeBytes = validateByteCount(input.sizeBytes);
    const mimeType = validateMimeType(input.mimeType);
    validateChecksums(input.sha256, input.contentMd5);
    const width = validatePositiveInteger(input.width, "width");
    const height = validatePositiveInteger(input.height, "height");
    const durationMs = validatePositiveInteger(input.durationMs, "durationMs");
    const metadata = serializeDurableObject(input.metadata ?? {});
    const newArtifact = input.target.kind === "new_artifact"
      ? {
        name: validateDisplayName(input.target.name),
        mediaKind: validateMediaKind(input.target.mediaKind),
        retentionPolicyId: normalizeRetentionPolicy(
          input.target.retentionPolicyId,
        ),
      }
      : null;
    const artifactId = input.target.kind === "new_artifact"
      ? generateArtifactId("art")
      : input.target.artifactId;
    const artifactVersionId = generateArtifactId("aver");
    const uploadId = generateArtifactId("upl");
    const objectKey = createImmutableObjectKey({
      artifactId,
      artifactVersionId,
    });
    const now = this.#now();

    const result = await withArtifactTransaction(this.#pool, async (client) => {
      if (
        !await hasWorkspaceMembership(
          client,
          input.workspaceId,
          input.actorUserId,
        )
      ) {
        return { kind: "not_found" } as const;
      }

      let currentVersionId: string | null = null;
      let sequence = 1;
      const createdArtifact = input.target.kind === "new_artifact";
      if (!createdArtifact) {
        const { rows } = await client.query<{
          current_version_id: string | null;
        }>(
          `select current_version_id
             from relay.artifacts
            where workspace_id = $1 and id = $2
              and deleted_at is null and purged_at is null
            for update`,
          [input.workspaceId, artifactId],
        );
        if (rows.length === 0) return { kind: "not_found" } as const;
        currentVersionId = rows[0].current_version_id;
        const next = await client.query<{ sequence: number }>(
          `select coalesce(max(sequence), 0) + 1 as sequence
             from relay.artifact_versions
            where workspace_id = $1 and artifact_id = $2`,
          [input.workspaceId, artifactId],
        );
        sequence = next.rows[0].sequence;
      }

      const reservation = await this.#quota.reserve(client, {
        workspaceId: input.workspaceId,
        operationId: uploadId,
        bytes: sizeBytes,
      });
      if (reservation.kind === "denied") {
        return { kind: "quota_exceeded" } as const;
      }

      const authorization = await this.#storage.createUploadUrl({
        key: objectKey,
        uploadId,
        contentType: mimeType,
        contentMd5: input.contentMd5,
        sha256Hex: input.sha256,
        expiresInSeconds: this.#uploadTtlSeconds,
      });
      if (authorization.expiresAt.getTime() <= now.getTime()) {
        throw new Error(
          "storage returned an already-expired upload authorization",
        );
      }

      if (input.target.kind === "new_artifact") {
        await client.query(
          `insert into relay.artifacts
             (id, workspace_id, name, media_kind, source_run_id, created_by,
              retention_policy_id, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            artifactId,
            input.workspaceId,
            newArtifact!.name,
            newArtifact!.mediaKind,
            input.sourceRunId ?? null,
            input.actorUserId,
            newArtifact!.retentionPolicyId,
            now,
          ],
        );
      }

      await client.query(
        `insert into relay.artifact_versions
           (id, workspace_id, artifact_id, sequence, object_key, sha256,
            content_md5, size_bytes, mime_type, width, height, duration_ms,
            source, source_run_id, parent_version_id, metadata,
            verification_status, created_at)
         values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           'upload', $13, $14, $15::jsonb, 'pending', $16
         )`,
        [
          artifactVersionId,
          input.workspaceId,
          artifactId,
          sequence,
          objectKey,
          input.sha256,
          input.contentMd5,
          sizeBytes,
          mimeType,
          width,
          height,
          durationMs,
          input.sourceRunId ?? null,
          currentVersionId,
          metadata,
          now,
        ],
      );
      await client.query(
        `insert into relay.artifact_uploads
           (id, workspace_id, artifact_id, artifact_version_id, kind,
            object_key, expected_previous_version_id, expected_size_bytes,
            expected_mime_type, expected_sha256, content_md5, expires_at,
            quota_reservation_id, created_artifact, created_at)
         values (
           $1, $2, $3, $4, 'direct_upload', $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14
         )`,
        [
          uploadId,
          input.workspaceId,
          artifactId,
          artifactVersionId,
          objectKey,
          currentVersionId,
          sizeBytes,
          mimeType,
          input.sha256,
          input.contentMd5,
          authorization.expiresAt,
          reservation.reservationId,
          createdArtifact,
          now,
        ],
      );

      return {
        kind: "created",
        value: {
          uploadId,
          artifactId,
          artifactVersionId,
          sequence,
          upload: authorization,
        },
      } as const;
    });

    return result;
  }

  async completeUpload(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly uploadId: string;
  }): Promise<CompleteUploadResult> {
    const { rows } = await this.#pool.query<UploadRow>(
      `select u.id, u.workspace_id, u.artifact_id, u.artifact_version_id,
              u.output_item_id, u.kind, u.object_key,
              u.expected_previous_version_id, u.expected_size_bytes,
              u.expected_mime_type, u.expected_sha256, u.content_md5,
              u.status, u.expires_at, u.failure_code,
              u.quota_reservation_id, u.quota_state, u.created_artifact,
              u.became_current, u.cleanup_storage_version_id
         from relay.artifact_uploads u
        where u.workspace_id = $1 and u.id = $2
          and exists (
            select 1 from auth.member m
             where m."organizationId" = u.workspace_id
               and m."userId" = $3
          )`,
      [input.workspaceId, input.uploadId, input.actorUserId],
    );
    if (rows.length === 0) return { kind: "not_found" };
    const row = rows[0];
    const terminal = terminalUploadResult(row);
    if (terminal !== null) return terminal;
    if (asDate(row.expires_at).getTime() <= this.#now().getTime()) {
      return (await this.#failPendingUpload(
        row.workspace_id,
        row.id,
        "upload_expired",
        true,
      )).result;
    }

    const head = await this.#storage.headObject({ key: row.object_key });
    if (head === null) return { kind: "pending" };
    const mismatch = headMismatch(row, head);
    if (mismatch !== null) {
      return (await this.#failPendingUpload(
        row.workspace_id,
        row.id,
        mismatch,
        false,
        head,
      )).result;
    }
    return await this.#finalizePendingUpload(row.workspace_id, row.id, head);
  }

  async #loadUploadForUpdate(
    client: ArtifactTransaction,
    workspaceId: string,
    uploadId: string,
  ): Promise<UploadRow | null> {
    const identity = await client.query<{ output_item_id: string | null }>(
      `select output_item_id
         from relay.artifact_uploads
        where workspace_id = $1 and id = $2`,
      [workspaceId, uploadId],
    );
    if (identity.rows.length === 0) return null;
    if (identity.rows[0].output_item_id !== null) {
      await client.query(
        `select oi.id
           from relay.output_items oi
           join relay.output_sets os
             on os.workspace_id = oi.workspace_id
            and os.id = oi.output_set_id
          where oi.workspace_id = $1 and oi.id = $2
          for update of os, oi`,
        [workspaceId, identity.rows[0].output_item_id],
      );
    }
    const { rows } = await client.query<UploadRow>(
      `select id, workspace_id, artifact_id, artifact_version_id,
              output_item_id, kind, object_key, expected_previous_version_id,
              expected_size_bytes, expected_mime_type, expected_sha256,
              content_md5, status, expires_at, failure_code,
              quota_reservation_id, quota_state, created_artifact,
              became_current, cleanup_storage_version_id
         from relay.artifact_uploads
        where workspace_id = $1 and id = $2
        for update`,
      [workspaceId, uploadId],
    );
    return rows[0] ?? null;
  }

  async #transitionPendingToFailure(
    client: ArtifactTransaction,
    row: UploadRow,
    failureCode: string,
    expired: boolean,
    now: Date,
    observedHead: ObjectHead | null = null,
  ): Promise<void> {
    const code = validateErrorCode(failureCode);
    await client.query(
      `update relay.artifact_versions
          set verification_status = 'failed', failure_code = $3
        where workspace_id = $1 and id = $2
          and verification_status = 'pending'`,
      [row.workspace_id, row.artifact_version_id, code],
    );
    const cleanupAvailableAt = laterDate(now, asDate(row.expires_at));
    await client.query(
      `update relay.artifact_uploads
          set status = $3,
              failure_code = $4,
              quota_state = 'cleanup_held',
              cleanup_status = 'pending',
              cleanup_available_at = $5,
              cleanup_storage_version_id = $6
        where workspace_id = $1 and id = $2 and status = 'pending'`,
      [
        row.workspace_id,
        row.id,
        expired ? "expired" : "failed",
        code,
        cleanupAvailableAt,
        observedHead?.storageVersionId ?? null,
      ],
    );

    if (row.output_item_id !== null) {
      const output = await client.query<{ output_set_id: string }>(
        `update relay.output_items
            set status = 'failed', error_code = $3, completed_at = $4
          where workspace_id = $1 and id = $2 and status = 'pending'
          returning output_set_id`,
        [row.workspace_id, row.output_item_id, code, now],
      );
      if (output.rows[0] !== undefined) {
        await refreshOutputSet(
          client,
          row.workspace_id,
          output.rows[0].output_set_id,
          now,
        );
      }
    }

    if (row.created_artifact) {
      await client.query(
        `update relay.artifacts
            set deleted_at = $3,
                purge_after = $4,
                purge_status = 'pending'
          where workspace_id = $1 and id = $2
            and current_version_id is null and deleted_at is null`,
        [row.workspace_id, row.artifact_id, now, cleanupAvailableAt],
      );
    }
  }

  async #failPendingUpload(
    workspaceId: string,
    uploadId: string,
    failureCode: string,
    expired: boolean,
    observedHead: ObjectHead | null = null,
  ): Promise<{
    readonly result: CompleteUploadResult;
    readonly transitioned: boolean;
  }> {
    return await withArtifactTransaction(this.#pool, async (client) => {
      const row = await this.#loadUploadForUpdate(
        client,
        workspaceId,
        uploadId,
      );
      if (row === null) {
        return { result: { kind: "not_found" }, transitioned: false } as const;
      }
      const terminal = terminalUploadResult(row);
      if (terminal !== null) {
        return { result: terminal, transitioned: false } as const;
      }
      await this.#transitionPendingToFailure(
        client,
        row,
        failureCode,
        expired,
        this.#now(),
        observedHead,
      );
      return {
        result: expired
          ? { kind: "expired" }
          : { kind: "verification_failed", reason: failureCode },
        transitioned: true,
      } as const;
    });
  }

  async #finalizePendingUpload(
    workspaceId: string,
    uploadId: string,
    head: ObjectHead,
    cryptographicallyVerified = false,
  ): Promise<CompleteUploadResult> {
    return await withArtifactTransaction(this.#pool, async (client) => {
      const row = await this.#loadUploadForUpdate(
        client,
        workspaceId,
        uploadId,
      );
      if (row === null) return { kind: "not_found" } as const;
      if (row.status === "completed") {
        return {
          kind: "completed",
          artifactId: row.artifact_id,
          artifactVersionId: row.artifact_version_id,
          becameCurrent: row.became_current === true,
        } as const;
      }
      if (row.status === "expired") return { kind: "expired" } as const;
      if (row.status === "failed") {
        return {
          kind: "verification_failed",
          reason: row.failure_code ?? "verification_failed",
        } as const;
      }

      const now = this.#now();
      if (asDate(row.expires_at).getTime() <= now.getTime()) {
        await this.#transitionPendingToFailure(
          client,
          row,
          "upload_expired",
          true,
          now,
        );
        return { kind: "expired" } as const;
      }
      const mismatch = headMismatch(row, head);
      if (mismatch !== null) {
        await this.#transitionPendingToFailure(
          client,
          row,
          mismatch,
          false,
          now,
          head,
        );
        return { kind: "verification_failed", reason: mismatch } as const;
      }

      const artifact = await client.query<{
        current_version_id: string | null;
        deleted_at: Date | null;
        purge_status: string;
      }>(
        `select current_version_id, deleted_at, purge_status
           from relay.artifacts
          where workspace_id = $1 and id = $2
          for update`,
        [workspaceId, row.artifact_id],
      );
      if (artifact.rows.length === 0) {
        await this.#transitionPendingToFailure(
          client,
          row,
          "artifact_missing",
          false,
          now,
          head,
        );
        return {
          kind: "verification_failed",
          reason: "artifact_missing",
        } as const;
      }

      if (
        row.kind === "restore" &&
        (artifact.rows[0].deleted_at === null ||
          artifact.rows[0].purge_status !== "pending" ||
          artifact.rows[0].current_version_id !==
            row.expected_previous_version_id)
      ) {
        await this.#transitionPendingToFailure(
          client,
          row,
          "restore_conflict",
          false,
          now,
          head,
        );
        return {
          kind: "verification_failed",
          reason: "restore_conflict",
        } as const;
      }

      if (row.output_item_id !== null) {
        const item = await client.query<{
          status: string;
          output_set_id: string;
        }>(
          `select oi.status, oi.output_set_id
             from relay.output_items oi
             join relay.output_sets os
               on os.workspace_id = oi.workspace_id
              and os.id = oi.output_set_id
            where oi.workspace_id = $1 and oi.id = $2
            for update of os, oi`,
          [workspaceId, row.output_item_id],
        );
        if (item.rows.length === 0 || item.rows[0].status !== "pending") {
          await this.#transitionPendingToFailure(
            client,
            row,
            "output_item_conflict",
            false,
            now,
            head,
          );
          return {
            kind: "verification_failed",
            reason: "output_item_conflict",
          } as const;
        }
      }

      await this.#quota.commit(client, {
        workspaceId,
        reservationId: row.quota_reservation_id,
        bytes: Number(row.expected_size_bytes),
      });
      await client.query(
        `update relay.artifact_versions
            set storage_version_id = $3,
                etag = $4,
                verification_status = $5,
                verified_at = $6
          where workspace_id = $1 and id = $2
            and verification_status = 'pending'`,
        [
          workspaceId,
          row.artifact_version_id,
          head.storageVersionId,
          head.etag,
          cryptographicallyVerified
            ? "cryptographically_verified"
            : "head_verified",
          now,
        ],
      );

      let becameCurrent = false;
      if (row.kind === "restore") {
        const restored = await client.query(
          `update relay.artifacts
              set current_version_id = $3,
                  deleted_at = null,
                  purge_after = null,
                  purge_status = 'not_requested',
                  purge_lease_token = null,
                  purge_claimed_at = null,
                  purge_last_error = null
            where workspace_id = $1 and id = $2
              and deleted_at is not null
              and purge_status = 'pending'
              and current_version_id is not distinct from $4`,
          [
            workspaceId,
            row.artifact_id,
            row.artifact_version_id,
            row.expected_previous_version_id,
          ],
        );
        becameCurrent = (restored.rowCount ?? 0) === 1;
      } else {
        const advanced = await client.query(
          `update relay.artifacts
              set current_version_id = $3
            where workspace_id = $1 and id = $2
              and deleted_at is null and purged_at is null
              and current_version_id is not distinct from $4`,
          [
            workspaceId,
            row.artifact_id,
            row.artifact_version_id,
            row.expected_previous_version_id,
          ],
        );
        becameCurrent = (advanced.rowCount ?? 0) === 1;
      }

      if ((row.created_artifact || row.kind === "restore") && !becameCurrent) {
        throw new Error("staged artifact head changed unexpectedly");
      }

      if (row.output_item_id !== null) {
        const output = await client.query<{ output_set_id: string }>(
          `update relay.output_items
              set status = 'succeeded', artifact_version_id = $3,
                  completed_at = $4
            where workspace_id = $1 and id = $2 and status = 'pending'
            returning output_set_id`,
          [workspaceId, row.output_item_id, row.artifact_version_id, now],
        );
        if (output.rows[0] !== undefined) {
          await refreshOutputSet(
            client,
            workspaceId,
            output.rows[0].output_set_id,
            now,
          );
        }
      }

      await client.query(
        `update relay.artifact_uploads
            set status = 'completed', completed_at = $3,
                quota_state = 'committed', became_current = $4
          where workspace_id = $1 and id = $2 and status = 'pending'`,
        [workspaceId, uploadId, now, becameCurrent],
      );

      return {
        kind: "completed",
        artifactId: row.artifact_id,
        artifactVersionId: row.artifact_version_id,
        becameCurrent,
      } as const;
    });
  }

  async getArtifact(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly artifactId: string;
    readonly includeDeleted?: boolean;
  }): Promise<GetArtifactResult> {
    const { rows } = await this.#pool.query<{
      id: string;
      workspace_id: string;
      name: string;
      media_kind: string;
      current_version_id: string | null;
      source_run_id: string | null;
      deleted_at: Date | null;
      purged_at: Date | null;
      created_at: Date;
    }>(
      `select a.id, a.workspace_id, a.name, a.media_kind,
              a.current_version_id, a.source_run_id, a.deleted_at,
              a.purged_at, a.created_at
         from relay.artifacts a
        where a.workspace_id = $1 and a.id = $2
          and a.purged_at is null
          and ($4::boolean or a.deleted_at is null)
          and exists (
            select 1 from auth.member m
             where m."organizationId" = a.workspace_id
               and m."userId" = $3
          )`,
      [
        input.workspaceId,
        input.artifactId,
        input.actorUserId,
        input.includeDeleted ?? false,
      ],
    );
    if (rows.length === 0) return { kind: "not_found" };

    const versions = await this.#pool.query<{
      id: string;
      sequence: number;
      sha256: string;
      content_md5: string;
      size_bytes: string;
      mime_type: string;
      width: number | null;
      height: number | null;
      duration_ms: string | null;
      source: "upload" | "generated" | "restore";
      source_run_id: string | null;
      parent_version_id: string | null;
      verification_status: ArtifactVersionRecord["verificationStatus"];
      purge_status: ArtifactVersionRecord["purgeStatus"];
      purge_started_at: Date | null;
      purged_at: Date | null;
      created_at: Date;
    }>(
      `select id, sequence, sha256, content_md5, size_bytes, mime_type,
              width, height, duration_ms, source, source_run_id,
              parent_version_id, verification_status, purge_status,
              purge_started_at, purged_at, created_at
         from relay.artifact_versions
        where workspace_id = $1 and artifact_id = $2
        order by sequence asc`,
      [input.workspaceId, input.artifactId],
    );
    const artifact = rows[0];
    return {
      kind: "found",
      artifact: {
        id: artifact.id,
        workspaceId: artifact.workspace_id,
        name: artifact.name,
        mediaKind: artifact.media_kind,
        currentVersionId: artifact.current_version_id,
        sourceRunId: artifact.source_run_id,
        deletedAt: artifact.deleted_at,
        purgedAt: artifact.purged_at,
        createdAt: artifact.created_at,
        versions: versions.rows.map((version: {
          id: string;
          sequence: number;
          sha256: string;
          content_md5: string;
          size_bytes: string;
          mime_type: string;
          width: number | null;
          height: number | null;
          duration_ms: string | null;
          source: "upload" | "generated" | "restore";
          source_run_id: string | null;
          parent_version_id: string | null;
          verification_status: ArtifactVersionRecord["verificationStatus"];
          purge_status: ArtifactVersionRecord["purgeStatus"];
          purge_started_at: Date | null;
          purged_at: Date | null;
          created_at: Date;
        }) => ({
          id: version.id,
          sequence: version.sequence,
          sha256: version.sha256,
          contentMd5: version.content_md5,
          sizeBytes: Number(version.size_bytes),
          mimeType: version.mime_type,
          width: version.width,
          height: version.height,
          durationMs: version.duration_ms === null
            ? null
            : Number(version.duration_ms),
          source: version.source,
          sourceRunId: version.source_run_id,
          parentVersionId: version.parent_version_id,
          verificationStatus: version.verification_status,
          purgeStatus: version.purge_status,
          purgeStartedAt: version.purge_started_at,
          purgedAt: version.purged_at,
          createdAt: version.created_at,
        })),
      },
    };
  }

  async softDeleteArtifact(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly artifactId: string;
  }): Promise<SoftDeleteArtifactResult> {
    return await withArtifactTransaction(this.#pool, async (client) => {
      if (
        !await hasWorkspaceMembership(
          client,
          input.workspaceId,
          input.actorUserId,
        )
      ) {
        return { kind: "not_found" } as const;
      }
      const { rows } = await client.query<{
        deleted_at: Date | null;
        purge_after: Date | null;
        purged_at: Date | null;
      }>(
        `select deleted_at, purge_after, purged_at
           from relay.artifacts
          where workspace_id = $1 and id = $2
          for update`,
        [input.workspaceId, input.artifactId],
      );
      if (rows.length === 0 || rows[0].purged_at !== null) {
        return { kind: "not_found" } as const;
      }
      if (rows[0].deleted_at !== null) {
        return {
          kind: "already_deleted",
          purgeAfter: asDate(rows[0].purge_after!),
        } as const;
      }

      const now = this.#now();
      const purgeAfter = new Date(
        now.getTime() + this.#purgeDelaySeconds * 1000,
      );
      await client.query(
        `update relay.artifacts
            set deleted_at = $3, purge_after = $4, purge_status = 'pending',
                purge_last_error = null
          where workspace_id = $1 and id = $2`,
        [input.workspaceId, input.artifactId, now, purgeAfter],
      );
      return { kind: "deleted", purgeAfter } as const;
    });
  }

  async restoreArtifact(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly artifactId: string;
    readonly sourceVersionId?: string;
  }): Promise<RestoreArtifactResult> {
    const artifactVersionId = generateArtifactId("aver");
    const uploadId = generateArtifactId("upl");
    const objectKey = createImmutableObjectKey({
      artifactId: input.artifactId,
      artifactVersionId,
    });
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#uploadTtlSeconds * 1000);

    const staged = await withArtifactTransaction(this.#pool, async (client) => {
      if (
        !await hasWorkspaceMembership(
          client,
          input.workspaceId,
          input.actorUserId,
        )
      ) {
        return { kind: "not_found" } as const;
      }
      const artifact = await client.query<{
        current_version_id: string | null;
        purge_status: string;
      }>(
        `select current_version_id, purge_status
           from relay.artifacts
          where workspace_id = $1 and id = $2
            and deleted_at is not null and purged_at is null
          for update`,
        [input.workspaceId, input.artifactId],
      );
      if (
        artifact.rows.length === 0 ||
        artifact.rows[0].purge_status !== "pending" ||
        artifact.rows[0].current_version_id === null
      ) {
        return { kind: "not_found" } as const;
      }
      const expectedPreviousVersionId = artifact.rows[0].current_version_id;
      const sourceVersionId = input.sourceVersionId ??
        expectedPreviousVersionId;
      const source = await client.query<VersionSourceRow>(
        `select id, object_key, storage_version_id, sha256, content_md5,
                size_bytes, mime_type, width, height, duration_ms,
                source_run_id, metadata
           from relay.artifact_versions
          where workspace_id = $1 and artifact_id = $2 and id = $3
            and verification_status in ('head_verified', 'cryptographically_verified')
            and purged_at is null
          for share`,
        [input.workspaceId, input.artifactId, sourceVersionId],
      );
      if (source.rows.length === 0) {
        return { kind: "source_unavailable" } as const;
      }
      const sourceRow = source.rows[0];
      const sequenceResult = await client.query<{ sequence: number }>(
        `select max(sequence) + 1 as sequence
           from relay.artifact_versions
          where workspace_id = $1 and artifact_id = $2`,
        [input.workspaceId, input.artifactId],
      );
      const sequence = sequenceResult.rows[0].sequence;
      const sizeBytes = Number(sourceRow.size_bytes);
      const reservation = await this.#quota.reserve(client, {
        workspaceId: input.workspaceId,
        operationId: uploadId,
        bytes: sizeBytes,
      });
      if (reservation.kind === "denied") {
        return { kind: "quota_exceeded" } as const;
      }

      await client.query(
        `insert into relay.artifact_versions
           (id, workspace_id, artifact_id, sequence, object_key, sha256,
            content_md5, size_bytes, mime_type, width, height, duration_ms,
            source, source_run_id, parent_version_id, metadata,
            verification_status, created_at)
         values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           'restore', $13, $14, $15::jsonb, 'pending', $16
         )`,
        [
          artifactVersionId,
          input.workspaceId,
          input.artifactId,
          sequence,
          objectKey,
          sourceRow.sha256,
          sourceRow.content_md5,
          sizeBytes,
          sourceRow.mime_type,
          sourceRow.width,
          sourceRow.height,
          sourceRow.duration_ms === null ? null : Number(sourceRow.duration_ms),
          sourceRow.source_run_id,
          sourceRow.id,
          serializeDurableObject(sourceRow.metadata ?? {}),
          now,
        ],
      );
      await client.query(
        `insert into relay.artifact_uploads
           (id, workspace_id, artifact_id, artifact_version_id, kind,
            object_key, expected_previous_version_id, expected_size_bytes,
            expected_mime_type, expected_sha256, content_md5, expires_at,
            quota_reservation_id, created_artifact, created_at)
         values ($1, $2, $3, $4, 'restore', $5, $6, $7, $8, $9, $10,
                 $11, $12, false, $13)`,
        [
          uploadId,
          input.workspaceId,
          input.artifactId,
          artifactVersionId,
          objectKey,
          expectedPreviousVersionId,
          sizeBytes,
          sourceRow.mime_type,
          sourceRow.sha256,
          sourceRow.content_md5,
          expiresAt,
          reservation.reservationId,
          now,
        ],
      );
      return {
        kind: "staged",
        source: sourceRow,
      } as const;
    });

    if (staged.kind !== "staged") return staged;
    try {
      const sourceObject = await this.#storage.getObjectStream({
        key: staged.source.object_key,
        storageVersionId: staged.source.storage_version_id ?? undefined,
      });
      if (
        sourceObject === null ||
        sourceHeadMismatch(staged.source, sourceObject.head)
      ) {
        await this.#failPendingUpload(
          input.workspaceId,
          uploadId,
          sourceObject === null
            ? "restore_source_missing"
            : "restore_source_mismatch",
          false,
        );
        return { kind: "source_unavailable" };
      }
      const head = await this.#storage.putObject({
        key: objectKey,
        body: sourceObject.body,
        sizeBytes: Number(staged.source.size_bytes),
        contentType: staged.source.mime_type,
        contentMd5: staged.source.content_md5,
        sha256Hex: staged.source.sha256,
        metadata: {
          "relay-upload-id": uploadId,
          "relay-sha256": staged.source.sha256,
        },
      });
      const completed = await this.#finalizePendingUpload(
        input.workspaceId,
        uploadId,
        head,
      );
      return completed.kind === "completed"
        ? {
          kind: "restored",
          artifactId: completed.artifactId,
          artifactVersionId: completed.artifactVersionId,
        }
        : { kind: "conflict" };
    } catch {
      await this.#failPendingUpload(
        input.workspaceId,
        uploadId,
        "restore_storage_failed",
        false,
      );
      return { kind: "storage_error" };
    }
  }

  async createOutputSet(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly itemNames: readonly string[];
    readonly warnings?: readonly unknown[];
  }): Promise<CreateOutputSetResult> {
    if (input.itemNames.length === 0 || input.itemNames.length > 1_000) {
      throw new ArtifactInputError(
        "itemNames",
        "must contain between 1 and 1000 items",
      );
    }
    const names = input.itemNames.map((name, index) =>
      validateDisplayName(name, `itemNames[${index}]`)
    );
    const warnings = serializeDurableArray(input.warnings ?? []);
    const outputSetId = generateArtifactId("outset");
    const now = this.#now();

    return await withArtifactTransaction(this.#pool, async (client) => {
      const run = await client.query<{ output_set_id: string | null }>(
        `select output_set_id
           from relay.tool_runs
          where workspace_id = $1 and id = $2
          for update`,
        [input.workspaceId, input.runId],
      );
      if (run.rows.length === 0) return { kind: "not_found" } as const;
      if (run.rows[0].output_set_id !== null) {
        const existing = await client.query<{
          requested_count: number;
          warnings_match: boolean;
        }>(
          `select requested_count, warnings = $3::jsonb as warnings_match
             from relay.output_sets
            where workspace_id = $1 and id = $2`,
          [input.workspaceId, run.rows[0].output_set_id, warnings],
        );
        const existingItems = await client.query<{ name: string }>(
          `select name
             from relay.output_items
            where workspace_id = $1 and output_set_id = $2
            order by ordinal`,
          [input.workspaceId, run.rows[0].output_set_id],
        );
        if (
          existing.rows[0]?.requested_count !== names.length ||
          existing.rows[0]?.warnings_match !== true ||
          !sameStringArray(
            existingItems.rows.map((item: { name: string }) => item.name),
            names,
          )
        ) {
          return { kind: "conflict" } as const;
        }
        return {
          kind: "already_exists",
          outputSetId: run.rows[0].output_set_id,
        } as const;
      }

      await client.query(
        `insert into relay.output_sets
           (id, workspace_id, run_id, requested_count, warnings, created_at)
         values ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          outputSetId,
          input.workspaceId,
          input.runId,
          names.length,
          warnings,
          now,
        ],
      );
      for (let ordinal = 0; ordinal < names.length; ordinal++) {
        await client.query(
          `insert into relay.output_items
             (workspace_id, output_set_id, name, ordinal, created_at)
           values ($1, $2, $3, $4, $5)`,
          [input.workspaceId, outputSetId, names[ordinal], ordinal, now],
        );
      }
      await client.query(
        `update relay.tool_runs
            set output_set_id = $3, result_completeness = 'pending'
          where workspace_id = $1 and id = $2`,
        [input.workspaceId, input.runId, outputSetId],
      );
      return { kind: "created", outputSetId } as const;
    });
  }

  async getOutputSet(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly outputSetId: string;
  }): Promise<OutputSetRecord | null> {
    if (
      !await hasWorkspaceMembership(
        this.#pool,
        input.workspaceId,
        input.actorUserId,
      )
    ) {
      return null;
    }
    return await this.#readOutputSet(input.workspaceId, input.outputSetId);
  }

  /** Trusted worker-only read; callers must already own workspace authorization. */
  async getOutputSetInternal(input: {
    readonly workspaceId: string;
    readonly outputSetId: string;
  }): Promise<OutputSetRecord | null> {
    return await this.#readOutputSet(input.workspaceId, input.outputSetId);
  }

  async #readOutputSet(
    workspaceId: string,
    outputSetId: string,
  ): Promise<OutputSetRecord | null> {
    const output = await this.#pool.query<{
      id: string;
      workspace_id: string;
      run_id: string;
      requested_count: number;
      produced_count: number;
      completeness: OutputSetRecord["completeness"];
      warnings: unknown;
    }>(
      `select id, workspace_id, run_id, requested_count, produced_count,
              completeness, warnings
         from relay.output_sets
        where workspace_id = $1 and id = $2`,
      [workspaceId, outputSetId],
    );
    if (output.rows.length === 0) return null;
    const items = await this.#pool.query<{
      ordinal: number;
      name: string;
      status: OutputItemRecord["status"];
      artifact_version_id: string | null;
      error_code: string | null;
    }>(
      `select ordinal, name, status, artifact_version_id, error_code
         from relay.output_items
        where workspace_id = $1 and output_set_id = $2
        order by ordinal`,
      [workspaceId, outputSetId],
    );
    const row = output.rows[0];
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      requestedCount: row.requested_count,
      producedCount: row.produced_count,
      completeness: row.completeness,
      warnings: parseJsonArray(row.warnings),
      items: items.rows.map((item: {
        ordinal: number;
        name: string;
        status: OutputItemRecord["status"];
        artifact_version_id: string | null;
        error_code: string | null;
      }) => ({
        ordinal: item.ordinal,
        name: item.name,
        status: item.status,
        artifactVersionId: item.artifact_version_id,
        errorCode: item.error_code,
      })),
    };
  }

  async ingestGeneratedOutput(
    input: GeneratedOutputInput,
  ): Promise<IngestGeneratedOutputResult> {
    if (!(input.bytes instanceof Uint8Array)) {
      throw new ArtifactInputError("bytes", "must be a Uint8Array");
    }
    const ordinal = validateNonNegativeInteger(input.ordinal, "ordinal");
    const sizeBytes = validateByteCount(input.bytes.byteLength);
    const artifactName = validateDisplayName(
      input.artifactName,
      "artifactName",
    );
    const mediaKind = validateMediaKind(input.mediaKind);
    const mimeType = validateMimeType(input.mimeType);
    const width = validatePositiveInteger(input.width, "width");
    const height = validatePositiveInteger(input.height, "height");
    const durationMs = validatePositiveInteger(input.durationMs, "durationMs");
    const metadata = serializeDurableObject(input.metadata ?? {});
    const sha256 = await sha256Hex(input.bytes);
    const contentMd5 = md5Base64(input.bytes);
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#uploadTtlSeconds * 1000);
    const proposedArtifactId = generateArtifactId("art");
    const proposedVersionId = generateArtifactId("aver");
    const proposedUploadId = generateArtifactId("upl");
    const proposedObjectKey = createImmutableObjectKey({
      artifactId: proposedArtifactId,
      artifactVersionId: proposedVersionId,
    });

    const staged = await withArtifactTransaction(this.#pool, async (client) => {
      const item = await client.query<{
        id: string;
        name: string;
        status: OutputItemRecord["status"];
        artifact_version_id: string | null;
        error_code: string | null;
        run_id: string;
        created_by: string;
      }>(
        `select oi.id, oi.name, oi.status, oi.artifact_version_id,
                oi.error_code, os.run_id, tr.created_by
           from relay.output_items oi
           join relay.output_sets os
             on os.workspace_id = oi.workspace_id
            and os.id = oi.output_set_id
           join relay.tool_runs tr
             on tr.workspace_id = os.workspace_id and tr.id = os.run_id
          where oi.workspace_id = $1 and oi.output_set_id = $2
            and oi.ordinal = $3
          for update of oi, os`,
        [input.workspaceId, input.outputSetId, ordinal],
      );
      if (item.rows.length === 0) return { kind: "not_found" } as const;
      const itemRow = item.rows[0];
      if (itemRow.name !== artifactName) return { kind: "conflict" } as const;
      if (itemRow.status === "succeeded") {
        return {
          kind: "already_recorded",
          artifactVersionId: itemRow.artifact_version_id!,
        } as const;
      }
      if (itemRow.status === "failed") return { kind: "conflict" } as const;

      const existing = await client.query<
        UploadRow & {
          artifact_name: string;
          media_kind: string;
          width: number | null;
          height: number | null;
          duration_ms: string | null;
          metadata_match: boolean;
        }
      >(
        `select u.id, u.workspace_id, u.artifact_id,
                u.artifact_version_id, u.output_item_id, u.kind,
                u.object_key, u.expected_previous_version_id,
                u.expected_size_bytes, u.expected_mime_type,
                u.expected_sha256, u.content_md5, u.status, u.expires_at,
                u.failure_code, u.quota_reservation_id, u.quota_state,
                u.created_artifact,
                u.became_current, u.cleanup_storage_version_id,
                a.name as artifact_name, a.media_kind, v.width, v.height,
                v.duration_ms, v.metadata = $3::jsonb as metadata_match
           from relay.artifact_uploads u
           join relay.artifacts a
             on a.workspace_id = u.workspace_id and a.id = u.artifact_id
           join relay.artifact_versions v
             on v.workspace_id = u.workspace_id
            and v.id = u.artifact_version_id
          where u.workspace_id = $1 and u.output_item_id = $2
          for update of u`,
        [input.workspaceId, itemRow.id, metadata],
      );
      if (existing.rows.length > 0) {
        const upload = existing.rows[0];
        if (
          upload.status !== "pending" || upload.kind !== "generated" ||
          upload.artifact_name !== artifactName ||
          upload.media_kind !== mediaKind ||
          Number(upload.expected_size_bytes) !== sizeBytes ||
          upload.expected_mime_type !== mimeType ||
          upload.expected_sha256 !== sha256 ||
          upload.content_md5 !== contentMd5 || upload.width !== width ||
          upload.height !== height ||
          (upload.duration_ms === null ? null : Number(upload.duration_ms)) !==
            durationMs ||
          upload.metadata_match !== true
        ) {
          return { kind: "conflict" } as const;
        }
        return { kind: "staged", upload, existing: true } as const;
      }

      const reservation = await this.#quota.reserve(client, {
        workspaceId: input.workspaceId,
        operationId: proposedUploadId,
        bytes: sizeBytes,
      });
      if (reservation.kind === "denied") {
        return { kind: "quota_exceeded" } as const;
      }

      await client.query(
        `insert into relay.artifacts
           (id, workspace_id, name, media_kind, source_run_id, created_by,
            created_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          proposedArtifactId,
          input.workspaceId,
          artifactName,
          mediaKind,
          itemRow.run_id,
          itemRow.created_by,
          now,
        ],
      );
      await client.query(
        `insert into relay.artifact_versions
           (id, workspace_id, artifact_id, sequence, object_key, sha256,
            content_md5, size_bytes, mime_type, width, height, duration_ms,
            source, source_run_id, metadata, verification_status, created_at)
         values (
           $1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11,
           'generated', $12, $13::jsonb, 'pending', $14
         )`,
        [
          proposedVersionId,
          input.workspaceId,
          proposedArtifactId,
          proposedObjectKey,
          sha256,
          contentMd5,
          sizeBytes,
          mimeType,
          width,
          height,
          durationMs,
          itemRow.run_id,
          metadata,
          now,
        ],
      );
      await client.query(
        `insert into relay.artifact_uploads
           (id, workspace_id, artifact_id, artifact_version_id,
            output_item_id, kind, object_key, expected_size_bytes,
            expected_mime_type, expected_sha256, content_md5, expires_at,
            quota_reservation_id, created_artifact, created_at)
         values (
           $1, $2, $3, $4, $5, 'generated', $6, $7, $8, $9, $10,
           $11, $12, true, $13
         )`,
        [
          proposedUploadId,
          input.workspaceId,
          proposedArtifactId,
          proposedVersionId,
          itemRow.id,
          proposedObjectKey,
          sizeBytes,
          mimeType,
          sha256,
          contentMd5,
          expiresAt,
          reservation.reservationId,
          now,
        ],
      );

      const upload: UploadRow = {
        id: proposedUploadId,
        workspace_id: input.workspaceId,
        artifact_id: proposedArtifactId,
        artifact_version_id: proposedVersionId,
        output_item_id: itemRow.id,
        kind: "generated",
        object_key: proposedObjectKey,
        expected_previous_version_id: null,
        expected_size_bytes: String(sizeBytes),
        expected_mime_type: mimeType,
        expected_sha256: sha256,
        content_md5: contentMd5,
        status: "pending",
        expires_at: expiresAt,
        failure_code: null,
        quota_reservation_id: reservation.reservationId,
        quota_state: "reserved",
        created_artifact: true,
        became_current: null,
        cleanup_storage_version_id: null,
      };
      return { kind: "staged", upload, existing: false } as const;
    });

    if (staged.kind !== "staged") return staged;
    let head: ObjectHead | null = null;
    try {
      head = await this.#storage.headObject({ key: staged.upload.object_key });
      if (head === null) {
        try {
          head = await this.#storage.putObject({
            key: staged.upload.object_key,
            body: input.bytes,
            sizeBytes,
            contentType: mimeType,
            contentMd5,
            sha256Hex: sha256,
            metadata: {
              "relay-upload-id": staged.upload.id,
              "relay-sha256": sha256,
            },
          });
        } catch {
          head = await this.#storage.headObject({
            key: staged.upload.object_key,
          });
          if (head === null) return { kind: "storage_error" };
        }
      }
    } catch {
      return { kind: "storage_error" };
    }

    const mismatch = headMismatch(staged.upload, head);
    if (mismatch !== null) {
      const failed = await this.#failPendingUpload(
        input.workspaceId,
        staged.upload.id,
        mismatch,
        false,
        head,
      );
      if (failed.result.kind === "completed") {
        return {
          kind: "stored",
          artifactId: failed.result.artifactId,
          artifactVersionId: failed.result.artifactVersionId,
        };
      }
      if (failed.result.kind === "not_found") return { kind: "not_found" };
      return { kind: "conflict" };
    }

    const completed = await this.#finalizePendingUpload(
      input.workspaceId,
      staged.upload.id,
      head,
      true,
    );
    if (completed.kind === "completed") {
      return {
        kind: "stored",
        artifactId: completed.artifactId,
        artifactVersionId: completed.artifactVersionId,
      };
    }
    if (completed.kind === "not_found") return { kind: "not_found" };
    return { kind: "conflict" };
  }

  async recordGeneratedOutputFailure(input: {
    readonly workspaceId: string;
    readonly outputSetId: string;
    readonly ordinal: number;
    readonly errorCode: string;
  }): Promise<RecordOutputFailureResult> {
    const ordinal = validateNonNegativeInteger(input.ordinal, "ordinal");
    const errorCode = validateErrorCode(input.errorCode);
    return await withArtifactTransaction(this.#pool, async (client) => {
      const item = await client.query<{
        id: string;
        status: OutputItemRecord["status"];
        error_code: string | null;
      }>(
        `select oi.id, oi.status, oi.error_code
           from relay.output_items oi
           join relay.output_sets os
             on os.workspace_id = oi.workspace_id
            and os.id = oi.output_set_id
          where oi.workspace_id = $1 and oi.output_set_id = $2
            and oi.ordinal = $3
          for update of os, oi`,
        [input.workspaceId, input.outputSetId, ordinal],
      );
      if (item.rows.length === 0) return { kind: "not_found" } as const;
      if (item.rows[0].status === "succeeded") {
        return { kind: "conflict" } as const;
      }
      if (item.rows[0].status === "failed") {
        return item.rows[0].error_code === errorCode
          ? { kind: "already_recorded" } as const
          : { kind: "conflict" } as const;
      }

      const upload = await client.query<UploadRow>(
        `select id, workspace_id, artifact_id, artifact_version_id,
                output_item_id, kind, object_key, expected_previous_version_id,
                expected_size_bytes, expected_mime_type, expected_sha256,
                content_md5, status, expires_at, failure_code,
                quota_reservation_id, quota_state, created_artifact,
                became_current, cleanup_storage_version_id
           from relay.artifact_uploads
          where workspace_id = $1 and output_item_id = $2
          for update`,
        [input.workspaceId, item.rows[0].id],
      );
      if (upload.rows.length > 0) {
        if (upload.rows[0].status !== "pending") {
          return { kind: "conflict" } as const;
        }
        await this.#transitionPendingToFailure(
          client,
          upload.rows[0],
          errorCode,
          false,
          this.#now(),
        );
        return { kind: "recorded" } as const;
      }

      const now = this.#now();
      await client.query(
        `update relay.output_items
            set status = 'failed', error_code = $4, completed_at = $5
          where workspace_id = $1 and output_set_id = $2
            and ordinal = $3 and status = 'pending'`,
        [input.workspaceId, input.outputSetId, ordinal, errorCode, now],
      );
      await refreshOutputSet(client, input.workspaceId, input.outputSetId, now);
      return { kind: "recorded" } as const;
    });
  }

  async createArtifactDownloadUrl(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly artifactId: string;
    readonly artifactVersionId?: string;
    readonly contentDisposition?: "attachment" | "inline";
    readonly expiresInSeconds?: number;
  }): Promise<ArtifactDownloadResult> {
    const expiresInSeconds = validateSeconds(
      input.expiresInSeconds ?? this.#downloadTtlSeconds,
      "expiresInSeconds",
    );
    const contentDisposition = input.contentDisposition ?? "attachment";
    const { rows } = await this.#pool.query<{
      artifact_id: string;
      artifact_version_id: string;
      object_key: string;
      storage_version_id: string | null;
      mime_type: string;
    }>(
      `select a.id as artifact_id, v.id as artifact_version_id,
              v.object_key, v.storage_version_id, v.mime_type
         from relay.artifacts a
         join relay.artifact_versions v
           on v.workspace_id = a.workspace_id
          and v.artifact_id = a.id
          and v.id = coalesce($4, a.current_version_id)
        where a.workspace_id = $1 and a.id = $2
          and a.deleted_at is null and a.purged_at is null
          and v.purged_at is null
          and v.verification_status in ('head_verified', 'cryptographically_verified')
          and exists (
            select 1 from auth.member m
             where m."organizationId" = a.workspace_id
               and m."userId" = $3
          )`,
      [
        input.workspaceId,
        input.artifactId,
        input.actorUserId,
        input.artifactVersionId ?? null,
      ],
    );
    if (rows.length === 0) return { kind: "not_found" };
    const row = rows[0];
    const download = await this.#storage.createDownloadUrl({
      key: row.object_key,
      storageVersionId: row.storage_version_id ?? undefined,
      expiresInSeconds,
      contentDisposition,
      contentType: row.mime_type,
    });
    return {
      kind: "authorized",
      artifactId: row.artifact_id,
      artifactVersionId: row.artifact_version_id,
      download,
    };
  }

  async createShareLink(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly artifactId: string;
    readonly followCurrent: boolean;
    readonly artifactVersionId?: string | null;
    readonly expiresAt?: Date | null;
    readonly maxResolutions?: number | null;
    readonly requireAuth?: boolean;
    readonly contentDisposition: "attachment" | "inline";
  }): Promise<CreateShareLinkResult> {
    if (
      (input.followCurrent && input.artifactVersionId != null) ||
      (!input.followCurrent && !input.artifactVersionId)
    ) {
      throw new ArtifactInputError(
        "artifactVersionId",
        "must be absent for follow-current links and present for pinned links",
      );
    }
    if (
      input.contentDisposition !== "attachment" &&
      input.contentDisposition !== "inline"
    ) {
      throw new ArtifactInputError(
        "contentDisposition",
        "must be attachment or inline",
      );
    }

    const now = this.#now();
    const expiresAt = validateOptionalFutureDate(
      input.expiresAt,
      now,
      "expiresAt",
    );
    const maxResolutions = validatePositiveInteger(
      input.maxResolutions,
      "maxResolutions",
    );
    const shareLinkId = generateArtifactId("share");
    const token = generateShareSecret();
    const tokenHash = await hashShareSecret(token);

    const result = await withArtifactTransaction(this.#pool, async (client) => {
      if (
        !await hasWorkspaceMembership(
          client,
          input.workspaceId,
          input.actorUserId,
        )
      ) {
        return { kind: "not_found" } as const;
      }
      const target = await client.query<{ version_id: string | null }>(
        `select case when $3::boolean then a.current_version_id else $4 end
                  as version_id
           from relay.artifacts a
          where a.workspace_id = $1 and a.id = $2
            and a.deleted_at is null and a.purged_at is null
          for share`,
        [
          input.workspaceId,
          input.artifactId,
          input.followCurrent,
          input.artifactVersionId ?? null,
        ],
      );
      const versionId = target.rows[0]?.version_id;
      if (versionId == null) return { kind: "not_found" } as const;
      const version = await client.query<{ present: boolean }>(
        `select exists (
           select 1 from relay.artifact_versions
            where workspace_id = $1 and artifact_id = $2 and id = $3
              and purged_at is null
              and verification_status in ('head_verified', 'cryptographically_verified')
         ) as present`,
        [input.workspaceId, input.artifactId, versionId],
      );
      if (version.rows[0]?.present !== true) {
        return { kind: "not_found" } as const;
      }

      await client.query(
        `insert into relay.share_links
           (id, workspace_id, artifact_id, artifact_version_id, token_hash,
            follow_current, expires_at, max_resolutions, require_auth,
            content_disposition, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          shareLinkId,
          input.workspaceId,
          input.artifactId,
          input.followCurrent ? null : versionId,
          tokenHash,
          input.followCurrent,
          expiresAt,
          maxResolutions,
          input.requireAuth ?? false,
          input.contentDisposition,
          input.actorUserId,
          now,
        ],
      );
      return {
        kind: "created",
        value: { shareLinkId, token },
      } as const;
    });
    return result;
  }

  async revokeShareLink(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly shareLinkId: string;
  }): Promise<RevokeShareLinkResult> {
    return await withArtifactTransaction(this.#pool, async (client) => {
      if (
        !await hasWorkspaceMembership(
          client,
          input.workspaceId,
          input.actorUserId,
        )
      ) {
        return { kind: "not_found" } as const;
      }
      const link = await client.query<{ revoked_at: Date | null }>(
        `select revoked_at
           from relay.share_links
          where workspace_id = $1 and id = $2
          for update`,
        [input.workspaceId, input.shareLinkId],
      );
      if (link.rows.length === 0) return { kind: "not_found" } as const;
      if (link.rows[0].revoked_at !== null) {
        return { kind: "already_revoked" } as const;
      }
      await client.query(
        `update relay.share_links
            set revoked_at = $3
          where workspace_id = $1 and id = $2 and revoked_at is null`,
        [input.workspaceId, input.shareLinkId, this.#now()],
      );
      return { kind: "revoked" } as const;
    });
  }

  async resolveShareLink(input: {
    readonly token: string;
    readonly actorUserId?: string;
  }): Promise<ResolveShareLinkResult> {
    if (!SHARE_TOKEN_PATTERN.test(input.token)) return { kind: "unavailable" };
    const tokenHash = await hashShareSecret(input.token);
    return await withArtifactTransaction(this.#pool, async (client) => {
      const link = await client.query<{
        id: string;
        workspace_id: string;
        artifact_id: string;
        artifact_version_id: string | null;
        current_version_id: string | null;
        follow_current: boolean;
        expires_at: Date | null;
        max_resolutions: number | null;
        resolution_count: number;
        require_auth: boolean;
        content_disposition: "attachment" | "inline";
        revoked_at: Date | null;
        deleted_at: Date | null;
        purged_at: Date | null;
      }>(
        `select sl.id, sl.workspace_id, sl.artifact_id,
                sl.artifact_version_id, a.current_version_id,
                sl.follow_current, sl.expires_at, sl.max_resolutions,
                sl.resolution_count, sl.require_auth,
                sl.content_disposition, sl.revoked_at,
                a.deleted_at, a.purged_at
           from relay.share_links sl
           join relay.artifacts a
             on a.workspace_id = sl.workspace_id and a.id = sl.artifact_id
          where sl.token_hash = $1
          for update of sl, a`,
        [tokenHash],
      );
      if (link.rows.length === 0) return { kind: "unavailable" } as const;
      const row = link.rows[0];
      const now = this.#now();
      if (
        row.revoked_at !== null || row.deleted_at !== null ||
        row.purged_at !== null ||
        (row.expires_at !== null &&
          asDate(row.expires_at).getTime() <= now.getTime()) ||
        (row.max_resolutions !== null &&
          row.resolution_count >= row.max_resolutions)
      ) {
        return { kind: "unavailable" } as const;
      }
      if (row.require_auth && input.actorUserId === undefined) {
        return { kind: "authentication_required" } as const;
      }
      if (
        row.require_auth &&
        !await hasWorkspaceMembership(
          client,
          row.workspace_id,
          input.actorUserId!,
        )
      ) {
        return { kind: "unavailable" } as const;
      }

      let downloadTtlSeconds = this.#downloadTtlSeconds;
      const policyExpiresAt = row.expires_at === null
        ? null
        : asDate(row.expires_at);
      if (policyExpiresAt !== null) {
        const remainingSeconds = Math.floor(
          (policyExpiresAt.getTime() - now.getTime()) / 1000,
        );
        if (remainingSeconds < 1) return { kind: "unavailable" } as const;
        downloadTtlSeconds = Math.min(downloadTtlSeconds, remainingSeconds);
      }

      const versionId = row.follow_current
        ? row.current_version_id
        : row.artifact_version_id;
      if (versionId === null) return { kind: "unavailable" } as const;
      const version = await client.query<{
        object_key: string;
        storage_version_id: string | null;
        mime_type: string;
      }>(
        `select object_key, storage_version_id, mime_type
           from relay.artifact_versions
          where workspace_id = $1 and artifact_id = $2 and id = $3
            and purged_at is null
            and verification_status in ('head_verified', 'cryptographically_verified')
          for share`,
        [row.workspace_id, row.artifact_id, versionId],
      );
      if (version.rows.length === 0) return { kind: "unavailable" } as const;
      const target = version.rows[0];
      const download = await this.#storage.createDownloadUrl({
        key: target.object_key,
        storageVersionId: target.storage_version_id ?? undefined,
        expiresInSeconds: downloadTtlSeconds,
        notAfter: policyExpiresAt ?? undefined,
        contentDisposition: row.content_disposition,
        contentType: target.mime_type,
      });
      if (
        policyExpiresAt !== null &&
        download.expiresAt.getTime() > policyExpiresAt.getTime()
      ) {
        return { kind: "unavailable" } as const;
      }
      const counted = await client.query(
        `update relay.share_links
            set resolution_count = resolution_count + 1,
                last_resolved_at = $2
          where token_hash = $1 and revoked_at is null
            and (expires_at is null or expires_at > $2)
            and (max_resolutions is null or resolution_count < max_resolutions)`,
        [tokenHash, now],
      );
      if ((counted.rowCount ?? 0) !== 1) {
        return { kind: "unavailable" } as const;
      }
      return {
        kind: "authorized",
        shareLinkId: row.id,
        artifactId: row.artifact_id,
        artifactVersionId: versionId,
        download,
      } as const;
    });
  }

  async expirePendingUploads(
    limit = MAX_BATCH_SIZE,
  ): Promise<readonly ExpiredUpload[]> {
    validateBatchSize(limit);
    const { rows } = await this.#pool.query<{
      id: string;
      workspace_id: string;
      artifact_id: string;
      artifact_version_id: string;
      object_key: string;
    }>(
      `select id, workspace_id, artifact_id, artifact_version_id, object_key
         from relay.artifact_uploads
        where status = 'pending' and expires_at <= $1
        order by expires_at, created_at
        limit $2`,
      [this.#now(), limit],
    );
    const expired: ExpiredUpload[] = [];
    for (const upload of rows) {
      const outcome = await this.#failPendingUpload(
        upload.workspace_id,
        upload.id,
        "upload_expired",
        true,
      );
      if (!outcome.transitioned) continue;
      expired.push({
        uploadId: upload.id,
        workspaceId: upload.workspace_id,
        artifactId: upload.artifact_id,
        artifactVersionId: upload.artifact_version_id,
        objectKey: upload.object_key,
      });
    }
    return expired;
  }

  async claimUploadCleanup(
    limit = MAX_BATCH_SIZE,
  ): Promise<readonly UploadCleanupLease[]> {
    validateBatchSize(limit);
    const now = this.#now();
    const staleBefore = new Date(
      now.getTime() - this.#cleanupLeaseSeconds * 1000,
    );
    return await withArtifactTransaction(this.#pool, async (client) => {
      const candidates = await client.query<{
        id: string;
        workspace_id: string;
        artifact_id: string;
        artifact_version_id: string;
        object_key: string;
        storage_version_id: string | null;
      }>(
        `select u.id, u.workspace_id, u.artifact_id,
                u.artifact_version_id, u.object_key,
                coalesce(u.cleanup_storage_version_id, v.storage_version_id)
                  as storage_version_id
           from relay.artifact_uploads u
           join relay.artifact_versions v
             on v.workspace_id = u.workspace_id
            and v.id = u.artifact_version_id
          where u.status in ('failed', 'expired')
            and u.quota_state = 'cleanup_held'
            and (
              (
                u.cleanup_status = 'pending'
                and u.cleanup_available_at <= $1
              ) or (
                u.cleanup_status = 'claimed'
                and u.cleanup_claimed_at <= $2
              )
            )
          order by coalesce(u.cleanup_claimed_at, u.cleanup_available_at),
                   u.created_at
          for update of u skip locked
          limit $3`,
        [now, staleBefore, limit],
      );
      const leases: UploadCleanupLease[] = [];
      for (const candidate of candidates.rows) {
        const leaseToken = generateArtifactId("lease");
        await client.query(
          `update relay.artifact_uploads
              set cleanup_status = 'claimed', cleanup_lease_token = $3,
                  cleanup_claimed_at = $4,
                  cleanup_attempt_count = cleanup_attempt_count + 1,
                  cleanup_last_error = null
            where workspace_id = $1 and id = $2
              and quota_state = 'cleanup_held'
              and cleanup_status in ('pending', 'claimed')`,
          [candidate.workspace_id, candidate.id, leaseToken, now],
        );
        leases.push({
          uploadId: candidate.id,
          workspaceId: candidate.workspace_id,
          artifactId: candidate.artifact_id,
          artifactVersionId: candidate.artifact_version_id,
          objectKey: candidate.object_key,
          storageVersionId: candidate.storage_version_id,
          leaseToken,
        });
      }
      return leases;
    });
  }

  async processUploadCleanup(
    lease: UploadCleanupLease,
  ): Promise<CleanupExecutionResult> {
    const authoritative = await this.#pool.query<{
      object_key: string;
      storage_version_id: string | null;
    }>(
      `select u.object_key,
              coalesce(u.cleanup_storage_version_id, v.storage_version_id)
                as storage_version_id
         from relay.artifact_uploads u
         join relay.artifact_versions v
           on v.workspace_id = u.workspace_id and v.id = u.artifact_version_id
        where u.workspace_id = $1 and u.id = $2
          and u.status in ('failed', 'expired')
          and u.quota_state = 'cleanup_held'
          and u.cleanup_status = 'claimed' and u.cleanup_lease_token = $3`,
      [lease.workspaceId, lease.uploadId, lease.leaseToken],
    );
    if (authoritative.rows.length === 0) return { kind: "lease_lost" };
    try {
      await this.#storage.hardDeleteObject({
        key: authoritative.rows[0].object_key,
        storageVersionId: authoritative.rows[0].storage_version_id ?? undefined,
      });
    } catch {
      const retryAt = new Date(
        this.#now().getTime() + this.#cleanupLeaseSeconds * 1000,
      );
      const released = await this.#pool.query(
        `update relay.artifact_uploads
            set cleanup_status = 'pending', cleanup_lease_token = null,
                cleanup_claimed_at = null, cleanup_available_at = $4,
                cleanup_last_error = $5
          where workspace_id = $1 and id = $2
            and cleanup_status = 'claimed' and cleanup_lease_token = $3`,
        [
          lease.workspaceId,
          lease.uploadId,
          lease.leaseToken,
          retryAt,
          SAFE_ERROR_CODE,
        ],
      );
      return (released.rowCount ?? 0) === 1
        ? { kind: "retry_scheduled" }
        : { kind: "lease_lost" };
    }

    return await withArtifactTransaction(this.#pool, async (client) => {
      const current = await client.query<{
        quota_reservation_id: string;
        expected_size_bytes: string;
      }>(
        `select quota_reservation_id, expected_size_bytes
           from relay.artifact_uploads
          where workspace_id = $1 and id = $2
            and status in ('failed', 'expired')
            and quota_state = 'cleanup_held'
            and cleanup_status = 'claimed' and cleanup_lease_token = $3
          for update`,
        [lease.workspaceId, lease.uploadId, lease.leaseToken],
      );
      if (current.rows.length === 0) return { kind: "lease_lost" } as const;
      await this.#quota.release(client, {
        workspaceId: lease.workspaceId,
        reservationId: current.rows[0].quota_reservation_id,
        bytes: Number(current.rows[0].expected_size_bytes),
      });
      await client.query(
        `update relay.artifact_uploads
            set quota_state = 'released', cleanup_status = 'deleted',
                cleanup_lease_token = null, cleanup_claimed_at = null,
                cleanup_last_error = null
          where workspace_id = $1 and id = $2
            and cleanup_status = 'claimed' and cleanup_lease_token = $3`,
        [lease.workspaceId, lease.uploadId, lease.leaseToken],
      );
      return { kind: "deleted" } as const;
    });
  }

  async claimArtifactPurges(
    limit = MAX_BATCH_SIZE,
  ): Promise<readonly ArtifactPurgeLease[]> {
    validateBatchSize(limit);
    const now = this.#now();
    const staleBefore = new Date(
      now.getTime() - this.#cleanupLeaseSeconds * 1000,
    );
    return await withArtifactTransaction(this.#pool, async (client) => {
      const artifacts = await client.query<{
        id: string;
        workspace_id: string;
        purge_status: "pending" | "claimed" | "deleting_pending" | "deleting";
      }>(
        `select a.id, a.workspace_id, a.purge_status
           from relay.artifacts a
          where (
            (
              a.purge_status = 'pending'
              and a.purge_after <= $1
              and not exists (
                select 1 from relay.artifact_uploads u
                 where u.workspace_id = a.workspace_id
                   and u.artifact_id = a.id
                   and (
                     u.status = 'pending'
                     or u.quota_state = 'cleanup_held'
                     or u.cleanup_status in ('pending', 'claimed')
                   )
              )
            )
            or a.purge_status = 'deleting_pending'
            or (
              a.purge_status in ('claimed', 'deleting')
              and a.purge_claimed_at <= $2
            )
          )
          order by coalesce(a.purge_claimed_at, a.purge_after), a.created_at
          for update of a skip locked
          limit $3`,
        [now, staleBefore, limit],
      );
      const leases: ArtifactPurgeLease[] = [];
      for (const artifact of artifacts.rows) {
        const leaseToken = generateArtifactId("please");
        const destructive = artifact.purge_status === "deleting" ||
          artifact.purge_status === "deleting_pending";
        await client.query(
          `update relay.artifacts
              set purge_status = $3, purge_lease_token = $4,
                  purge_claimed_at = $5,
                  purge_attempt_count = purge_attempt_count + 1,
                  purge_last_error = null
            where workspace_id = $1 and id = $2`,
          [
            artifact.workspace_id,
            artifact.id,
            destructive ? "deleting" : "claimed",
            leaseToken,
            now,
          ],
        );
        const objects = await client.query<{
          artifact_version_id: string;
          object_key: string;
          storage_version_id: string | null;
        }>(
          `select v.id as artifact_version_id, v.object_key,
                  coalesce(u.cleanup_storage_version_id, v.storage_version_id)
                    as storage_version_id
             from relay.artifact_versions v
             left join relay.artifact_uploads u
               on u.workspace_id = v.workspace_id
              and u.artifact_version_id = v.id
            where v.workspace_id = $1 and v.artifact_id = $2
              and v.purge_status <> 'deleted'
            order by v.sequence`,
          [artifact.workspace_id, artifact.id],
        );
        leases.push({
          artifactId: artifact.id,
          workspaceId: artifact.workspace_id,
          leaseToken,
          objects: objects.rows.map((object: {
            artifact_version_id: string;
            object_key: string;
            storage_version_id: string | null;
          }) => ({
            artifactVersionId: object.artifact_version_id,
            objectKey: object.object_key,
            storageVersionId: object.storage_version_id,
          })),
        });
      }
      return leases;
    });
  }

  async processArtifactPurge(
    lease: ArtifactPurgeLease,
  ): Promise<PurgeExecutionResult> {
    const began = await withArtifactTransaction(this.#pool, async (client) => {
      const artifact = await client.query<{ purge_status: string }>(
        `select purge_status
           from relay.artifacts
          where workspace_id = $1 and id = $2
            and purge_status in ('claimed', 'deleting')
            and purge_lease_token = $3
          for update`,
        [lease.workspaceId, lease.artifactId, lease.leaseToken],
      );
      if (artifact.rows.length === 0) return false;
      if (artifact.rows[0].purge_status === "claimed") {
        await client.query(
          `update relay.artifacts
              set purge_status = 'deleting', purge_io_started_at = $4,
                  purge_claimed_at = $4
            where workspace_id = $1 and id = $2
              and purge_status = 'claimed' and purge_lease_token = $3`,
          [
            lease.workspaceId,
            lease.artifactId,
            lease.leaseToken,
            this.#now(),
          ],
        );
      }
      return true;
    });
    if (!began) return { kind: "lease_lost" };

    const versions = await this.#pool.query<{
      artifact_version_id: string;
    }>(
      `select id as artifact_version_id
         from relay.artifact_versions
        where workspace_id = $1 and artifact_id = $2
          and purge_status <> 'deleted'
        order by sequence`,
      [lease.workspaceId, lease.artifactId],
    );

    for (const candidate of versions.rows) {
      const object = await withArtifactTransaction(
        this.#pool,
        async (client) => {
          const owned = await client.query<{ present: boolean }>(
            `select true as present
             from relay.artifacts
            where workspace_id = $1 and id = $2
              and purge_status = 'deleting' and purge_lease_token = $3
            for update`,
            [lease.workspaceId, lease.artifactId, lease.leaseToken],
          );
          if (owned.rows.length === 0) return null;
          await client.query(
            `update relay.artifacts
              set purge_claimed_at = $4
            where workspace_id = $1 and id = $2
              and purge_status = 'deleting' and purge_lease_token = $3`,
            [
              lease.workspaceId,
              lease.artifactId,
              lease.leaseToken,
              this.#now(),
            ],
          );
          const version = await client.query<{
            id: string;
            object_key: string;
            storage_version_id: string | null;
            cleanup_storage_version_id: string | null;
            purge_status: "not_requested" | "deleting" | "deleted";
          }>(
            `select v.id, v.object_key, v.storage_version_id,
                  u.cleanup_storage_version_id, v.purge_status
             from relay.artifact_versions v
             left join relay.artifact_uploads u
               on u.workspace_id = v.workspace_id
              and u.artifact_version_id = v.id
            where v.workspace_id = $1 and v.artifact_id = $2 and v.id = $3
            for update of v`,
            [
              lease.workspaceId,
              lease.artifactId,
              candidate.artifact_version_id,
            ],
          );
          if (
            version.rows.length === 0 ||
            version.rows[0].purge_status === "deleted"
          ) {
            return { kind: "already_deleted" } as const;
          }
          await client.query(
            `update relay.artifact_versions
              set purge_status = 'deleting',
                  purge_lease_token = $4,
                  purge_started_at = coalesce(purge_started_at, $5)
            where workspace_id = $1 and artifact_id = $2 and id = $3
              and purge_status in ('not_requested', 'deleting')`,
            [
              lease.workspaceId,
              lease.artifactId,
              candidate.artifact_version_id,
              lease.leaseToken,
              this.#now(),
            ],
          );
          return {
            kind: "delete",
            key: version.rows[0].object_key,
            storageVersionId: version.rows[0].cleanup_storage_version_id ??
              version.rows[0].storage_version_id,
          } as const;
        },
      );
      if (object === null) return { kind: "lease_lost" };
      if (object.kind === "already_deleted") continue;

      try {
        await this.#storage.hardDeleteObject({
          key: object.key,
          storageVersionId: object.storageVersionId ?? undefined,
        });
      } catch {
        return await this.#releaseArtifactPurge(lease);
      }

      let progressed: boolean;
      try {
        progressed = await withArtifactTransaction(
          this.#pool,
          async (client) => {
            const owned = await client.query<{ present: boolean }>(
              `select true as present
               from relay.artifacts
              where workspace_id = $1 and id = $2
                and purge_status = 'deleting' and purge_lease_token = $3
              for update`,
              [lease.workspaceId, lease.artifactId, lease.leaseToken],
            );
            if (owned.rows.length === 0) return false;
            const version = await client.query<{
              size_bytes: string;
              purge_status: string;
              purge_lease_token: string | null;
            }>(
              `select size_bytes, purge_status, purge_lease_token
               from relay.artifact_versions
              where workspace_id = $1 and artifact_id = $2 and id = $3
              for update`,
              [
                lease.workspaceId,
                lease.artifactId,
                candidate.artifact_version_id,
              ],
            );
            const row = version.rows[0];
            if (row === undefined) return false;
            if (row.purge_status === "deleted") return true;
            if (
              row.purge_status !== "deleting" ||
              row.purge_lease_token !== lease.leaseToken
            ) {
              return false;
            }
            const upload = await client.query<{
              quota_reservation_id: string;
              quota_state: string;
            }>(
              `select quota_reservation_id, quota_state
               from relay.artifact_uploads
              where workspace_id = $1 and artifact_version_id = $2
              for update`,
              [lease.workspaceId, candidate.artifact_version_id],
            );
            const quota = upload.rows[0];
            if (quota?.quota_state === "committed") {
              await this.#quota.decrementCommitted(client, {
                workspaceId: lease.workspaceId,
                reservationId: quota.quota_reservation_id,
                operationId: `purge:${candidate.artifact_version_id}`,
                bytes: Number(row.size_bytes),
              });
              await client.query(
                `update relay.artifact_uploads
                  set quota_state = 'decremented'
                where workspace_id = $1 and artifact_version_id = $2
                  and quota_state = 'committed'`,
                [lease.workspaceId, candidate.artifact_version_id],
              );
            } else if (quota?.quota_state === "cleanup_held") {
              throw new Error("cleanup debt must settle before artifact purge");
            }
            await client.query(
              `update relay.artifact_versions
                set purge_status = 'deleted', purge_lease_token = null,
                    purged_at = $4
              where workspace_id = $1 and artifact_id = $2 and id = $3
                and purge_status = 'deleting' and purge_lease_token = $5`,
              [
                lease.workspaceId,
                lease.artifactId,
                candidate.artifact_version_id,
                this.#now(),
                lease.leaseToken,
              ],
            );
            return true;
          },
        );
      } catch {
        return await this.#releaseArtifactPurge(lease);
      }
      if (!progressed) return { kind: "lease_lost" };
    }

    return await withArtifactTransaction(this.#pool, async (client) => {
      const owned = await client.query<{ present: boolean }>(
        `select true as present
           from relay.artifacts
          where workspace_id = $1 and id = $2
            and purge_status = 'deleting' and purge_lease_token = $3
          for update`,
        [lease.workspaceId, lease.artifactId, lease.leaseToken],
      );
      if (owned.rows.length === 0) return { kind: "lease_lost" } as const;
      const remaining = await client.query<{ present: boolean }>(
        `select exists (
           select 1 from relay.artifact_versions
            where workspace_id = $1 and artifact_id = $2
              and purge_status <> 'deleted'
         ) as present`,
        [lease.workspaceId, lease.artifactId],
      );
      if (remaining.rows[0]?.present === true) {
        throw new Error("artifact purge progress is incomplete");
      }
      const now = this.#now();
      await client.query(
        `update relay.artifacts
            set current_version_id = null, purge_status = 'purged',
                purge_lease_token = null, purge_claimed_at = null,
                purge_last_error = null, purged_at = $3
          where workspace_id = $1 and id = $2
            and purge_status = 'deleting' and purge_lease_token = $4`,
        [lease.workspaceId, lease.artifactId, now, lease.leaseToken],
      );
      return { kind: "purged" } as const;
    });
  }

  async #releaseArtifactPurge(
    lease: ArtifactPurgeLease,
  ): Promise<PurgeExecutionResult> {
    const released = await this.#pool.query(
      `update relay.artifacts
          set purge_status = 'deleting_pending', purge_lease_token = null,
              purge_claimed_at = null, purge_last_error = $4
        where workspace_id = $1 and id = $2
          and purge_status = 'deleting' and purge_lease_token = $3`,
      [
        lease.workspaceId,
        lease.artifactId,
        lease.leaseToken,
        SAFE_ERROR_CODE,
      ],
    );
    return (released.rowCount ?? 0) === 1
      ? { kind: "retry_scheduled" }
      : { kind: "lease_lost" };
  }
}
