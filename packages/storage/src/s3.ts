import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { PutObjectCommandInput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ReadinessCheck } from "@relay/contracts";
import { Readable } from "node:stream";
import type {
  CreateDownloadUrlRequest,
  CreateUploadUrlRequest,
  DownloadAuthorization,
  GetObjectRequest,
  HardDeleteObjectRequest,
  HardDeleteResult,
  ObjectHead,
  ObjectRead,
  ObjectStorage,
  PutObjectRequest,
  UploadAuthorization,
} from "./types.ts";

const OBJECT_KEY_PATTERN =
  /^artifacts\/art_[0-9a-f]{32}\/aver_[0-9a-f]{32}\/[0-9a-f]{48}$/;
const UPLOAD_ID_PATTERN = /^upl_[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTENT_MD5_PATTERN = /^[A-Za-z0-9+/]{22}==$/;
const METADATA_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTENT_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const RAW_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\//i;
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

export interface StaticS3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface S3ObjectStorageConfig {
  readonly bucket: string;
  readonly region: string;
  readonly credentials: StaticS3Credentials;
  /** Endpoint used for server-side HEAD/GET/PUT/DELETE traffic. */
  readonly internalEndpoint?: string | URL;
  /** Endpoint embedded into client-facing signatures. Defaults to internal. */
  readonly publicSigningEndpoint?: string | URL;
  readonly forcePathStyle: boolean;
  /**
   * Must match hard-delete behavior. Suspended remains versioned for deletion,
   * but readiness requires the remote bucket status to be exactly Enabled.
   */
  readonly bucketVersioning: "disabled" | "enabled";
  /** Optional per-attempt connection and request deadline in milliseconds. */
  readonly requestTimeoutMs?: number;
  readonly now?: () => Date;
}

export interface S3CompatibleStorage extends ObjectStorage {
  checkHealth(): Promise<ReadinessCheck>;
  close(): void;
}

export class S3ObjectStorageError extends Error {
  override readonly name = "S3ObjectStorageError";
  readonly operation: string;

  constructor(operation: string, options?: ErrorOptions) {
    super(`S3-compatible object operation failed: ${operation}`, options);
    this.operation = operation;
  }
}

interface TransformableBody {
  transformToWebStream(): ReadableStream<Uint8Array>;
}

function sdkRequestBody(
  body: PutObjectRequest["body"],
): PutObjectCommandInput["Body"] {
  if (body instanceof Uint8Array) return body;
  return Readable.fromWeb(
    body as unknown as globalThis.ReadableStream<Uint8Array>,
  ) as PutObjectCommandInput["Body"];
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function normalizeEndpoint(
  endpoint: string | URL | undefined,
  label: string,
): string | undefined {
  if (endpoint === undefined) return undefined;
  const parsed = endpoint instanceof URL
    ? new URL(endpoint)
    : new URL(endpoint);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`${label} must use http or https`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError(
      `${label} must not contain credentials, query, or hash`,
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function assertObjectKey(key: string): void {
  if (!OBJECT_KEY_PATTERN.test(key)) {
    throw new TypeError("object key is not a Relay immutable key");
  }
}

function assertStorageVersionId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (
    normalized.length === 0 || normalized.length > 1024 ||
    /[\r\n\0]/.test(normalized) || RAW_URL_PATTERN.test(normalized)
  ) {
    throw new TypeError("storageVersionId is invalid");
  }
  return normalized;
}

function assertSizeBytes(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new RangeError("sizeBytes must be a non-negative safe integer");
  }
}

function optionalRequestTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("requestTimeoutMs must be a positive safe integer");
  }
  return value;
}

function assertSeconds(seconds: number): void {
  if (
    !Number.isSafeInteger(seconds) || seconds < 1 ||
    seconds > MAX_PRESIGN_SECONDS
  ) {
    throw new RangeError(
      `expiresInSeconds must be an integer from 1 to ${MAX_PRESIGN_SECONDS}`,
    );
  }
}

function assertContentType(contentType: string): string {
  const value = contentType.trim().toLowerCase();
  if (
    value.length === 0 || value.length > 255 || /[\r\n\0]/.test(value) ||
    value.includes("://") || !CONTENT_TYPE_PATTERN.test(value)
  ) {
    throw new TypeError("contentType is invalid");
  }
  return value;
}

function assertChecksums(contentMd5: string, sha256Hex: string): void {
  if (!CONTENT_MD5_PATTERN.test(contentMd5)) {
    throw new TypeError("contentMd5 must be a base64-encoded MD5 digest");
  }
  if (!SHA256_PATTERN.test(sha256Hex)) {
    throw new TypeError("sha256Hex must be a lowercase SHA-256 digest");
  }
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

function normalizeMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(metadata ?? {})) {
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (!METADATA_KEY_PATTERN.test(key)) {
      throw new TypeError(`invalid object metadata key: ${rawKey}`);
    }
    if (
      value.length === 0 || value.length > 1024 || /[\r\n]/.test(value) ||
      value.includes("://")
    ) {
      throw new TypeError(`invalid object metadata value for ${rawKey}`);
    }
    result[key] = value;
  }
  return result;
}

function normalizeEtag(etag: string | undefined): string | null {
  if (etag === undefined || etag.length === 0) return null;
  return etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
}

function checkedSize(size: number | undefined): number {
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
    throw new S3ObjectStorageError("read object metadata");
  }
  return size;
}

function objectHead(
  key: string,
  output: {
    readonly ContentLength?: number;
    readonly ContentType?: string;
    readonly ETag?: string;
    readonly VersionId?: string;
    readonly ChecksumSHA256?: string;
    readonly LastModified?: Date;
    readonly Metadata?: Record<string, string>;
  },
): ObjectHead {
  return {
    key,
    sizeBytes: checkedSize(output.ContentLength),
    contentType: output.ContentType ?? null,
    etag: normalizeEtag(output.ETag),
    storageVersionId: output.VersionId ?? null,
    checksumSha256: output.ChecksumSHA256 ?? null,
    lastModified: output.LastModified ?? null,
    metadata: Object.freeze({ ...(output.Metadata ?? {}) }),
  };
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return candidate.name === "NoSuchKey" || candidate.name === "NotFound" ||
    candidate.$metadata?.httpStatusCode === 404;
}

function uploadMetadata(
  uploadId: string,
  sha256Hex: string,
): Record<string, string> {
  const normalizedUploadId = requiredText(uploadId, "uploadId");
  if (!UPLOAD_ID_PATTERN.test(normalizedUploadId)) {
    throw new TypeError("uploadId is not a Relay upload ID");
  }
  return {
    "relay-upload-id": normalizedUploadId,
    "relay-sha256": sha256Hex,
  };
}

function createClient(
  config: S3ObjectStorageConfig,
  endpoint: string | undefined,
): S3Client {
  const requestTimeoutMs = optionalRequestTimeout(config.requestTimeoutMs);
  return new S3Client({
    region: requiredText(config.region, "region"),
    endpoint,
    forcePathStyle: config.forcePathStyle,
    // Passing a value object is deliberate: the SDK never installs its generic
    // filesystem/process/metadata credential provider chain for this client.
    credentials: {
      accessKeyId: requiredText(
        config.credentials.accessKeyId,
        "credentials.accessKeyId",
      ),
      secretAccessKey: requiredText(
        config.credentials.secretAccessKey,
        "credentials.secretAccessKey",
      ),
      sessionToken: config.credentials.sessionToken === undefined
        ? undefined
        : requiredText(
          config.credentials.sessionToken,
          "credentials.sessionToken",
        ),
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: requestTimeoutMs === undefined ? undefined : {
      connectionTimeout: requestTimeoutMs,
      requestTimeout: requestTimeoutMs,
      throwOnRequestTimeout: true,
    },
    // Deno deployments intentionally run without --allow-sys. Supplying a
    // deterministic provider prevents the Node default from probing OS details.
    defaultUserAgentProvider: () => Promise.resolve([["relay-storage", "1"]]),
  });
}

/** Read-only S3 readiness check; it never creates or configures the bucket. */
export async function checkS3StorageHealth(
  client: Pick<S3Client, "send">,
  bucket: string,
): Promise<ReadinessCheck> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    return {
      name: "storage",
      status: "error",
      message: "bucket is unavailable",
    };
  }

  try {
    const versioning = await client.send(
      new GetBucketVersioningCommand({ Bucket: bucket }),
    );
    if (versioning.Status !== "Enabled") {
      return {
        name: "storage",
        status: "error",
        message: "bucket versioning must be enabled",
      };
    }
  } catch {
    return {
      name: "storage",
      status: "error",
      message: "unable to verify bucket versioning",
    };
  }

  return { name: "storage", status: "ok" };
}

class AwsS3ObjectStorage implements S3CompatibleStorage {
  readonly #bucket: string;
  readonly #internalClient: S3Client;
  readonly #signingClient: S3Client;
  readonly #bucketVersioning: "disabled" | "enabled";
  readonly #now: () => Date;

  constructor(config: S3ObjectStorageConfig) {
    this.#bucket = requiredText(config.bucket, "bucket");
    if (
      !BUCKET_PATTERN.test(this.#bucket) || this.#bucket.includes("..") ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(this.#bucket)
    ) {
      throw new TypeError("bucket is not a valid S3 bucket name");
    }

    const internalEndpoint = normalizeEndpoint(
      config.internalEndpoint,
      "internalEndpoint",
    );
    const publicEndpoint = normalizeEndpoint(
      config.publicSigningEndpoint,
      "publicSigningEndpoint",
    ) ?? internalEndpoint;

    if (
      config.bucketVersioning !== "disabled" &&
      config.bucketVersioning !== "enabled"
    ) {
      throw new TypeError("bucketVersioning must be disabled or enabled");
    }
    this.#internalClient = createClient(config, internalEndpoint);
    this.#signingClient = createClient(config, publicEndpoint);
    this.#bucketVersioning = config.bucketVersioning;
    this.#now = config.now ?? (() => new Date());
  }

  async createUploadUrl(
    request: CreateUploadUrlRequest,
  ): Promise<UploadAuthorization> {
    assertObjectKey(request.key);
    assertSizeBytes(request.sizeBytes);
    assertSeconds(request.expiresInSeconds);
    assertChecksums(request.contentMd5, request.sha256Hex);
    const contentType = assertContentType(request.contentType);
    const metadata = uploadMetadata(request.uploadId, request.sha256Hex);
    const signingDate = this.#now();

    try {
      const checksumSha256 = hexToBase64(request.sha256Hex);
      const command = new PutObjectCommand({
        Bucket: this.#bucket,
        Key: request.key,
        ContentLength: request.sizeBytes,
        ContentType: contentType,
        ContentMD5: request.contentMd5,
        ChecksumSHA256: checksumSha256,
        Metadata: metadata,
        IfNoneMatch: "*",
      });
      const url = await getSignedUrl(this.#signingClient, command, {
        expiresIn: request.expiresInSeconds,
        signingDate,
        signableHeaders: new Set(["content-length", "content-type"]),
        unhoistableHeaders: new Set([
          "x-amz-checksum-sha256",
          "x-amz-meta-relay-upload-id",
          "x-amz-meta-relay-sha256",
        ]),
      });

      const requiredHeaders: Record<string, string> = {
        "content-length": String(request.sizeBytes),
        "content-type": contentType,
        "content-md5": request.contentMd5,
        "x-amz-checksum-sha256": checksumSha256,
        "x-amz-meta-relay-upload-id": metadata["relay-upload-id"],
        "x-amz-meta-relay-sha256": metadata["relay-sha256"],
      };
      requiredHeaders["if-none-match"] = "*";

      return {
        method: "PUT",
        url,
        expiresAt: new Date(
          signingDate.getTime() + request.expiresInSeconds * 1000,
        ),
        requiredHeaders: Object.freeze(requiredHeaders),
      };
    } catch (cause) {
      throw new S3ObjectStorageError("create upload authorization", { cause });
    }
  }

  async createDownloadUrl(
    request: CreateDownloadUrlRequest,
  ): Promise<DownloadAuthorization> {
    assertObjectKey(request.key);
    assertSeconds(request.expiresInSeconds);
    const signingDate = this.#now();
    let expiresInSeconds = request.expiresInSeconds;
    if (request.notAfter !== undefined) {
      const notAfter = new Date(request.notAfter);
      const remainingSeconds = Math.floor(
        (notAfter.getTime() - signingDate.getTime()) / 1000,
      );
      if (!Number.isFinite(notAfter.getTime()) || remainingSeconds < 1) {
        throw new RangeError("notAfter must leave at least one signing second");
      }
      expiresInSeconds = Math.min(expiresInSeconds, remainingSeconds);
    }
    const storageVersionId = assertStorageVersionId(request.storageVersionId);
    const responseContentType = request.contentType === undefined
      ? undefined
      : assertContentType(request.contentType);
    if (
      request.contentDisposition !== undefined &&
      (/\r|\n/.test(request.contentDisposition) ||
        request.contentDisposition.length > 1024)
    ) {
      throw new TypeError("contentDisposition is invalid");
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.#bucket,
        Key: request.key,
        VersionId: storageVersionId,
        ResponseContentDisposition: request.contentDisposition,
        ResponseContentType: responseContentType,
      });
      const url = await getSignedUrl(this.#signingClient, command, {
        expiresIn: expiresInSeconds,
        signingDate,
      });
      return {
        method: "GET",
        url,
        expiresAt: new Date(
          signingDate.getTime() + expiresInSeconds * 1000,
        ),
        requiredHeaders: Object.freeze({}),
      };
    } catch (cause) {
      throw new S3ObjectStorageError("create download authorization", {
        cause,
      });
    }
  }

  async putObject(request: PutObjectRequest): Promise<ObjectHead> {
    assertObjectKey(request.key);
    assertSizeBytes(request.sizeBytes);
    assertChecksums(request.contentMd5, request.sha256Hex);
    const metadata = normalizeMetadata(request.metadata);
    const contentType = assertContentType(request.contentType);

    try {
      await this.#internalClient.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: request.key,
          Body: sdkRequestBody(request.body),
          ContentLength: request.sizeBytes,
          ContentType: contentType,
          ContentMD5: request.contentMd5,
          ChecksumSHA256: hexToBase64(request.sha256Hex),
          Metadata: metadata,
          IfNoneMatch: "*",
        }),
      );
      const head = await this.headObject({ key: request.key });
      if (head === null) {
        throw new S3ObjectStorageError("verify put object");
      }
      return head;
    } catch (cause) {
      if (cause instanceof S3ObjectStorageError) throw cause;
      throw new S3ObjectStorageError("put object", { cause });
    }
  }

  async getObjectStream(
    request: GetObjectRequest,
  ): Promise<ObjectRead | null> {
    assertObjectKey(request.key);
    const storageVersionId = assertStorageVersionId(request.storageVersionId);
    try {
      const output = await this.#internalClient.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: request.key,
          VersionId: storageVersionId,
          ChecksumMode: "ENABLED",
        }),
      );
      if (output.Body === undefined) {
        throw new S3ObjectStorageError("read object body");
      }

      const transformable = output.Body as unknown as TransformableBody;
      if (typeof transformable.transformToWebStream !== "function") {
        throw new S3ObjectStorageError("adapt object body stream");
      }
      return {
        head: objectHead(request.key, output),
        body: transformable.transformToWebStream(),
      };
    } catch (cause) {
      if (isMissingObject(cause)) return null;
      if (cause instanceof S3ObjectStorageError) throw cause;
      throw new S3ObjectStorageError("get object stream", { cause });
    }
  }

  async headObject(request: GetObjectRequest): Promise<ObjectHead | null> {
    assertObjectKey(request.key);
    const storageVersionId = assertStorageVersionId(request.storageVersionId);
    try {
      const output = await this.#internalClient.send(
        new HeadObjectCommand({
          Bucket: this.#bucket,
          Key: request.key,
          VersionId: storageVersionId,
          ChecksumMode: "ENABLED",
        }),
      );
      return objectHead(request.key, output);
    } catch (cause) {
      if (isMissingObject(cause)) return null;
      throw new S3ObjectStorageError("head object", { cause });
    }
  }

  async hardDeleteObject(
    request: HardDeleteObjectRequest,
  ): Promise<HardDeleteResult> {
    assertObjectKey(request.key);
    assertStorageVersionId(request.storageVersionId);
    try {
      if (this.#bucketVersioning === "disabled") {
        await this.#internalClient.send(
          new DeleteObjectCommand({
            Bucket: this.#bucket,
            Key: request.key,
          }),
        );
        if (await this.headObject({ key: request.key }) !== null) {
          throw new S3ObjectStorageError("confirm unversioned hard delete");
        }
        return {
          key: request.key,
          deletedVersions: 1,
          deletedDeleteMarkers: 0,
        };
      }

      let deletedVersions = 0;
      let deletedDeleteMarkers = 0;
      for (let pass = 0; pass < 3; pass++) {
        const identities = await this.#listObjectVersions(request.key);
        if (identities.length === 0) {
          if (await this.headObject({ key: request.key }) !== null) {
            throw new S3ObjectStorageError("confirm versioned hard delete");
          }
          return {
            key: request.key,
            deletedVersions,
            deletedDeleteMarkers,
          };
        }
        for (const identity of identities) {
          await this.#internalClient.send(
            new DeleteObjectCommand({
              Bucket: this.#bucket,
              Key: request.key,
              VersionId: identity.versionId,
            }),
          );
          if (identity.deleteMarker) deletedDeleteMarkers += 1;
          else deletedVersions += 1;
        }
      }
      throw new S3ObjectStorageError("confirm versioned hard delete");
    } catch (cause) {
      if (cause instanceof S3ObjectStorageError) throw cause;
      throw new S3ObjectStorageError("hard delete object", { cause });
    }
  }

  async #listObjectVersions(key: string): Promise<
    readonly {
      readonly versionId: string;
      readonly deleteMarker: boolean;
    }[]
  > {
    const identities: {
      versionId: string;
      deleteMarker: boolean;
    }[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const listed = await this.#internalClient.send(
        new ListObjectVersionsCommand({
          Bucket: this.#bucket,
          Prefix: key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      for (const version of listed.Versions ?? []) {
        if (version.Key === key && version.VersionId !== undefined) {
          identities.push({
            versionId: version.VersionId,
            deleteMarker: false,
          });
        }
      }
      for (const marker of listed.DeleteMarkers ?? []) {
        if (marker.Key === key && marker.VersionId !== undefined) {
          identities.push({
            versionId: marker.VersionId,
            deleteMarker: true,
          });
        }
      }
      if (!listed.IsTruncated) break;
      if (listed.NextKeyMarker === undefined) {
        throw new S3ObjectStorageError("paginate object versions");
      }
      keyMarker = listed.NextKeyMarker;
      versionIdMarker = listed.NextVersionIdMarker;
    } while (true);
    return identities;
  }

  checkHealth(): Promise<ReadinessCheck> {
    return checkS3StorageHealth(this.#internalClient, this.#bucket);
  }

  close(): void {
    this.#internalClient.destroy();
    this.#signingClient.destroy();
  }
}

export function createS3ObjectStorage(
  config: S3ObjectStorageConfig,
): S3CompatibleStorage {
  return new AwsS3ObjectStorage(config);
}
