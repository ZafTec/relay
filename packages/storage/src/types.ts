export type ObjectBody = Uint8Array | ReadableStream<Uint8Array>;

export interface ObjectHead {
  readonly key: string;
  readonly sizeBytes: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly storageVersionId: string | null;
  readonly checksumSha256: string | null;
  readonly lastModified: Date | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CreateUploadUrlRequest {
  readonly key: string;
  readonly uploadId: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly contentMd5: string;
  readonly sha256Hex: string;
  readonly expiresInSeconds: number;
}

export interface UploadAuthorization {
  readonly method: "PUT";
  readonly url: string;
  readonly expiresAt: Date;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface CreateDownloadUrlRequest {
  readonly key: string;
  readonly expiresInSeconds: number;
  /** Optional absolute policy deadline; the signer caps TTL against its own clock. */
  readonly notAfter?: Date;
  readonly contentDisposition?: string;
  readonly contentType?: string;
  readonly storageVersionId?: string;
}

export interface DownloadAuthorization {
  readonly method: "GET";
  readonly url: string;
  readonly expiresAt: Date;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface PutObjectRequest {
  readonly key: string;
  readonly body: ObjectBody;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly contentMd5: string;
  readonly sha256Hex: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface GetObjectRequest {
  readonly key: string;
  readonly storageVersionId?: string;
}

export interface ObjectRead {
  readonly head: ObjectHead;
  readonly body: ReadableStream<Uint8Array>;
}

export interface HardDeleteObjectRequest {
  readonly key: string;
  /** Known version when available; hard deletion still removes every version. */
  readonly storageVersionId?: string;
}

export interface HardDeleteResult {
  readonly key: string;
  readonly deletedVersions: number;
  readonly deletedDeleteMarkers: number;
}

/**
 * Provider-neutral object operations needed by artifact services. URLs are
 * short-lived return values only; callers must never persist them.
 */
export interface ObjectStorage {
  createUploadUrl(
    request: CreateUploadUrlRequest,
  ): Promise<UploadAuthorization>;
  createDownloadUrl(
    request: CreateDownloadUrlRequest,
  ): Promise<DownloadAuthorization>;
  putObject(request: PutObjectRequest): Promise<ObjectHead>;
  getObjectStream(request: GetObjectRequest): Promise<ObjectRead | null>;
  headObject(request: GetObjectRequest): Promise<ObjectHead | null>;
  /** Resolves only after the key has no physical versions or delete markers. */
  hardDeleteObject(request: HardDeleteObjectRequest): Promise<HardDeleteResult>;
}
