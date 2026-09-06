import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import type { ObjectHead, ObjectStorage } from "@relay/storage/types";
import type { ArtifactDatabasePool } from "./database.ts";
import {
  type ArtifactMutationClaim,
  type ArtifactMutationOperation,
  type ArtifactMutationQueryExecutor,
  type ArtifactMutationResultReference,
  type ClaimArtifactMutationInput,
  type ClaimArtifactMutationResult,
  type CompleteArtifactMutationResult,
  fingerprintArtifactMutationRequest,
  hashArtifactMutationIdempotencyKey,
  PostgresArtifactMutationIdempotencyRepository,
} from "./idempotency.ts";
import { generateShareSecret, hashShareSecret } from "./ids.ts";
import type { ArtifactQuota } from "./quota.ts";
import { ArtifactService } from "./service.ts";
import { ShareTokenCodec } from "./share-tokens.ts";
import { ArtifactInputError } from "./validation.ts";

const bytes = new TextEncoder().encode("hello");
const sha256 =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const contentMd5 = "XUFAKrxLKna5cZ2REBfFkg==";

function fakePool(membership: boolean): {
  readonly pool: ArtifactDatabasePool;
  readonly statements: string[];
} {
  const statements: string[] = [];
  const client = {
    query<T>(text: string): Promise<{ rows: T[]; rowCount: number }> {
      statements.push(text.trim());
      if (text.includes("from auth.member")) {
        return Promise.resolve({
          rows: [{ present: membership }] as T[],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release() {},
  };
  return {
    statements,
    pool: {
      connect: () => Promise.resolve(client),
    } as unknown as ArtifactDatabasePool,
  };
}

function fakeStorage(options?: {
  readonly failSigning?: boolean;
  readonly onSign?: () => void;
}): ObjectStorage {
  const missing = (): Promise<never> =>
    Promise.reject(new Error("unexpected storage operation"));
  return {
    createUploadUrl: () => {
      options?.onSign?.();
      if (options?.failSigning) {
        return Promise.reject(new Error("signing failed"));
      }
      return Promise.resolve({
        method: "PUT",
        url: "https://ephemeral.example.test/upload",
        expiresAt: new Date(Date.now() + 60_000),
        requiredHeaders: {},
      });
    },
    createDownloadUrl: missing,
    putObject: missing,
    getObjectStream: missing,
    headObject: (): Promise<ObjectHead | null> => Promise.resolve(null),
    hardDeleteObject: missing,
  };
}

function input() {
  return {
    workspaceId: "workspace",
    actorUserId: "user",
    target: {
      kind: "new_artifact" as const,
      name: "Artifact",
      mediaKind: "document",
    },
    sizeBytes: bytes.byteLength,
    mimeType: "text/plain",
    sha256,
    contentMd5,
  };
}

interface TestQueryResult {
  readonly rows: readonly unknown[];
  readonly rowCount?: number;
}

interface TestQueryRecord {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly transactional: boolean;
}

function memoryPool(
  handler: (
    text: string,
    params: readonly unknown[],
    transactional: boolean,
  ) => TestQueryResult | Promise<TestQueryResult>,
): {
  readonly pool: ArtifactDatabasePool;
  readonly client: ArtifactMutationQueryExecutor;
  readonly queries: TestQueryRecord[];
} {
  const queries: TestQueryRecord[] = [];
  const execute = async <T>(
    text: string,
    params: unknown[] = [],
    transactional: boolean,
  ): Promise<{ rows: T[]; rowCount: number }> => {
    const normalized = text.trim();
    queries.push({ text: normalized, params, transactional });
    if (
      normalized === "begin" || normalized === "commit" ||
      normalized === "rollback"
    ) {
      return { rows: [], rowCount: 0 };
    }
    const result = await handler(normalized, params, transactional);
    return {
      rows: [...result.rows] as T[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  };
  const client = {
    query: <T>(text: string, params?: unknown[]) =>
      execute<T>(text, params, true),
    release() {},
  };
  return {
    client,
    queries,
    pool: {
      query: <T>(text: string, params?: unknown[]) =>
        execute<T>(text, params, false),
      connect: () => Promise.resolve(client),
    } as unknown as ArtifactDatabasePool,
  };
}

interface MemoryIdempotencyEntry {
  readonly fingerprint: string;
  readonly reference: ArtifactMutationResultReference;
}

class MemoryIdempotencyRepository
  extends PostgresArtifactMutationIdempotencyRepository {
  readonly claimQueryables: ArtifactMutationQueryExecutor[] = [];
  readonly completeQueryables: ArtifactMutationQueryExecutor[] = [];
  readonly requests: unknown[] = [];
  readonly references: ArtifactMutationResultReference[] = [];
  readonly #entries = new Map<string, MemoryIdempotencyEntry>();

  #scope(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly operation: ArtifactMutationOperation;
    readonly idempotencyKeyHash: string;
  }): string {
    return [
      input.workspaceId,
      input.actorUserId,
      input.operation,
      input.idempotencyKeyHash,
    ].join("\0");
  }

  override async claim<Operation extends ArtifactMutationOperation>(
    queryable: ArtifactMutationQueryExecutor,
    input: ClaimArtifactMutationInput<Operation>,
  ): Promise<ClaimArtifactMutationResult<Operation>> {
    this.claimQueryables.push(queryable);
    this.requests.push(input.request);
    const [idempotencyKeyHash, requestFingerprint] = await Promise.all([
      hashArtifactMutationIdempotencyKey(input),
      fingerprintArtifactMutationRequest(input.operation, {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        request: input.request,
      }),
    ]);
    const claim: ArtifactMutationClaim<Operation> = {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      operation: input.operation,
      idempotencyKeyHash,
      requestFingerprint,
    };
    const existing = this.#entries.get(this.#scope(claim));
    if (existing === undefined) return { kind: "claimed", claim };
    if (existing.fingerprint !== requestFingerprint) {
      return { kind: "conflict" };
    }
    return {
      kind: "replay",
      reference: existing.reference as ArtifactMutationResultReference<
        Operation
      >,
    };
  }

  override complete<Operation extends ArtifactMutationOperation>(
    queryable: ArtifactMutationQueryExecutor,
    claim: ArtifactMutationClaim<Operation>,
    reference: ArtifactMutationResultReference<Operation>,
  ): Promise<CompleteArtifactMutationResult<Operation>> {
    this.completeQueryables.push(queryable);
    this.references.push(reference);
    this.#entries.set(this.#scope(claim), {
      fingerprint: claim.requestFingerprint,
      reference,
    });
    return Promise.resolve({ kind: "completed", reference });
  }
}

function noOpQuota(overrides: Partial<ArtifactQuota> = {}): ArtifactQuota {
  return {
    reserve: () =>
      Promise.resolve({ kind: "reserved", reservationId: "reservation_test" }),
    commit: () => Promise.resolve(),
    release: () => Promise.resolve(),
    decrementCommitted: () => Promise.resolve(),
    ...overrides,
  };
}

function signingKey(version: number, byte: number) {
  return { version, secret: new Uint8Array(32).fill(byte) };
}

Deno.test("ArtifactService validates durable input before touching dependencies", async () => {
  const { pool, statements } = fakePool(true);
  const service = new ArtifactService({
    pool,
    storage: fakeStorage(),
    quota: {
      reserve: () => Promise.reject(new Error("unexpected quota call")),
      commit: () => Promise.reject(new Error("unexpected quota call")),
      release: () => Promise.reject(new Error("unexpected quota call")),
      decrementCommitted: () =>
        Promise.reject(new Error("unexpected quota call")),
    },
  });

  await assertRejects(
    () =>
      service.beginDirectUpload({
        ...input(),
        metadata: { providerUrl: "https://provider.example.test/result" },
      }),
    ArtifactInputError,
    "raw URL",
  );
  assertEquals(statements, []);
  assertThrows(
    () =>
      new ArtifactService({
        pool,
        storage: fakeStorage(),
        quota: {} as ArtifactQuota,
        uploadTtlSeconds: 0,
      }),
    TypeError,
    "uploadTtlSeconds",
  );
  assertThrows(
    () =>
      new ArtifactService({
        pool,
        storage: fakeStorage(),
        quota: {} as ArtifactQuota,
        maxUploadBytes: 0,
      }),
    TypeError,
    "maxUploadBytes",
  );
});

Deno.test("direct upload enforces its size ceiling at the boundary", async () => {
  const { pool, statements } = fakePool(true);
  let quotaCalls = 0;
  let signingCalls = 0;
  const service = new ArtifactService({
    pool,
    storage: fakeStorage({ onSign: () => signingCalls++ }),
    quota: noOpQuota({
      reserve: (_queryable, request) => {
        quotaCalls += 1;
        assertEquals(request.bytes, bytes.byteLength);
        return Promise.resolve({
          kind: "reserved",
          reservationId: "reservation_test",
        });
      },
    }),
    maxUploadBytes: bytes.byteLength,
  });

  assertEquals(
    await service.beginDirectUpload({
      ...input(),
      sizeBytes: bytes.byteLength + 1,
      idempotencyKey: "oversized-upload",
    }),
    { kind: "quota_exceeded", replayed: false },
  );
  assertEquals(statements, []);
  assertEquals(quotaCalls, 0);
  assertEquals(signingCalls, 0);

  const atLimit = await service.beginDirectUpload(input());
  assertEquals(atLimit.kind, "created");
  assertEquals(quotaCalls, 1);
  assertEquals(signingCalls, 1);
  assertEquals(statements[0], "begin");
  assertEquals(statements.at(-1), "commit");
});

Deno.test("unauthorized direct upload neither reserves quota nor signs", async () => {
  const { pool, statements } = fakePool(false);
  let quotaCalls = 0;
  let signingCalls = 0;
  const service = new ArtifactService({
    pool,
    storage: fakeStorage({ onSign: () => signingCalls++ }),
    quota: {
      reserve: () => {
        quotaCalls++;
        return Promise.resolve({ kind: "denied" });
      },
      commit: () => Promise.resolve(),
      release: () => Promise.resolve(),
      decrementCommitted: () => Promise.resolve(),
    },
  });

  assertEquals(await service.beginDirectUpload(input()), { kind: "not_found" });
  assertEquals(quotaCalls, 0);
  assertEquals(signingCalls, 0);
  assertEquals(statements[0], "begin");
  assertEquals(statements.at(-1), "commit");
});

Deno.test("quota denial does not mint an upload authorization", async () => {
  const { pool } = fakePool(true);
  let signingCalls = 0;
  const service = new ArtifactService({
    pool,
    storage: fakeStorage({ onSign: () => signingCalls++ }),
    quota: {
      reserve: () => Promise.resolve({ kind: "denied" }),
      commit: () => Promise.resolve(),
      release: () => Promise.resolve(),
      decrementCommitted: () => Promise.resolve(),
    },
  });

  assertEquals(await service.beginDirectUpload(input()), {
    kind: "quota_exceeded",
  });
  assertEquals(signingCalls, 0);
});

Deno.test("expired completion returns authoritative locked state in output-first order", async () => {
  const statements: string[] = [];
  const pending = {
    id: "upl_0123456789abcdef0123456789abcdef",
    workspace_id: "workspace",
    artifact_id: "art_0123456789abcdef0123456789abcdef",
    artifact_version_id: "aver_0123456789abcdef0123456789abcdef",
    output_item_id: "42",
    kind: "generated",
    object_key:
      "artifacts/art_0123456789abcdef0123456789abcdef/aver_0123456789abcdef0123456789abcdef/0123456789abcdef0123456789abcdef0123456789abcdef",
    expected_previous_version_id: null,
    expected_size_bytes: "5",
    expected_mime_type: "text/plain",
    expected_sha256: sha256,
    content_md5: contentMd5,
    status: "pending",
    expires_at: new Date("2020-01-01T00:00:00.000Z"),
    failure_code: null,
    quota_reservation_id: "reservation_test",
    quota_state: "reserved",
    created_artifact: true,
    became_current: null,
    cleanup_storage_version_id: null,
  };
  const completed = {
    ...pending,
    status: "completed",
    quota_state: "committed",
    became_current: true,
  };
  const client = {
    query<T>(text: string): Promise<{ rows: T[]; rowCount: number }> {
      statements.push(text.trim());
      if (text.includes("select output_item_id")) {
        return Promise.resolve({
          rows: [{ output_item_id: "42" }] as T[],
          rowCount: 1,
        });
      }
      if (text.includes("for update of os, oi")) {
        return Promise.resolve({ rows: [{ id: "42" }] as T[], rowCount: 1 });
      }
      if (
        text.includes("from relay.artifact_uploads") &&
        text.includes("for update")
      ) {
        return Promise.resolve({ rows: [completed] as T[], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release() {},
  };
  const pool = {
    query: <T>(text: string): Promise<{ rows: T[]; rowCount: number }> => {
      statements.push(text.trim());
      return Promise.resolve({ rows: [pending] as T[], rowCount: 1 });
    },
    connect: () => Promise.resolve(client),
  } as unknown as ArtifactDatabasePool;
  const service = new ArtifactService({
    pool,
    storage: fakeStorage(),
    quota: {
      reserve: () => Promise.reject(new Error("unexpected quota call")),
      commit: () => Promise.reject(new Error("unexpected quota call")),
      release: () => Promise.reject(new Error("unexpected quota call")),
      decrementCommitted: () =>
        Promise.reject(new Error("unexpected quota call")),
    },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  assertEquals(
    await service.completeUpload({
      workspaceId: "workspace",
      actorUserId: "user",
      uploadId: pending.id,
    }),
    {
      kind: "completed",
      artifactId: pending.artifact_id,
      artifactVersionId: pending.artifact_version_id,
      becameCurrent: true,
    },
  );
  const outputLock = statements.findIndex((text) =>
    text.includes("for update of os, oi")
  );
  const uploadLock = statements.findIndex((text) =>
    text.includes("from relay.artifact_uploads") && text.includes("for update")
  );
  assertEquals(outputLock >= 0, true);
  assertEquals(uploadLock > outputLock, true);
});

Deno.test("signing failure rolls back the quota transaction", async () => {
  const { pool, statements } = fakePool(true);
  let reservations = 0;
  const service = new ArtifactService({
    pool,
    storage: fakeStorage({ failSigning: true }),
    quota: {
      reserve: () => {
        reservations++;
        return Promise.resolve({
          kind: "reserved",
          reservationId: "reservation_test",
        });
      },
      commit: () => Promise.resolve(),
      release: () => Promise.resolve(),
      decrementCommitted: () => Promise.resolve(),
    },
  });

  await assertRejects(
    () => service.beginDirectUpload(input()),
    Error,
    "signing failed",
  );
  assertEquals(reservations, 1);
  assertEquals(statements.at(-1), "rollback");
  assertEquals(
    statements.some((statement) =>
      statement.includes("insert into relay.artifact_uploads")
    ),
    false,
  );
});

Deno.test("idempotent upload creation reuses IDs, refreshes bounded authorization, and conflicts across targets", async () => {
  let clock = new Date("2026-08-25T12:00:00.000Z");
  let upload: Record<string, unknown> | null = null;
  let sequence = 0;
  const database = memoryPool((text, params) => {
    if (text.includes("from auth.member")) {
      return { rows: [{ present: true }] };
    }
    if (text.includes("insert into relay.artifact_versions")) {
      sequence = params[3] as number;
      return { rows: [] };
    }
    if (text.includes("insert into relay.artifact_uploads")) {
      upload = {
        id: params[0],
        workspace_id: params[1],
        artifact_id: params[2],
        artifact_version_id: params[3],
        output_item_id: null,
        kind: "direct_upload",
        object_key: params[4],
        expected_previous_version_id: params[5],
        expected_size_bytes: String(params[6]),
        expected_mime_type: params[7],
        expected_sha256: params[8],
        content_md5: params[9],
        status: "pending",
        expires_at: params[10],
        failure_code: null,
        quota_reservation_id: params[11],
        quota_state: "reserved",
        created_artifact: params[12],
        became_current: null,
        cleanup_storage_version_id: null,
      };
      return { rows: [] };
    }
    if (text.includes("select output_item_id")) {
      return upload === null
        ? { rows: [] }
        : { rows: [{ output_item_id: null }] };
    }
    if (
      text.includes("from relay.artifact_uploads") &&
      text.includes("for update")
    ) {
      return upload === null ? { rows: [] } : { rows: [upload] };
    }
    if (text.startsWith("select sequence")) {
      return { rows: [{ sequence }] };
    }
    return { rows: [] };
  });
  const idempotencyRepository = new MemoryIdempotencyRepository();
  let reserveCalls = 0;
  let signingCalls = 0;
  const signedSizes: number[] = [];
  const storage: ObjectStorage = {
    ...fakeStorage(),
    createUploadUrl: (request) => {
      signingCalls += 1;
      signedSizes.push(request.sizeBytes);
      return Promise.resolve({
        method: "PUT",
        url: `https://ephemeral.example.test/upload/${signingCalls}`,
        expiresAt: new Date(
          clock.getTime() + request.expiresInSeconds * 1000,
        ),
        requiredHeaders: {},
      });
    },
  };
  const service = new ArtifactService({
    pool: database.pool,
    storage,
    quota: noOpQuota({
      reserve: (_queryable, request) => {
        reserveCalls += 1;
        return Promise.resolve({
          kind: "reserved",
          reservationId: `quota_${request.operationId}`,
        });
      },
    }),
    idempotencyRepository,
    uploadTtlSeconds: 120,
    now: () => new Date(clock),
  });
  const request = {
    ...input(),
    idempotencyKey: "upload-request-1",
    metadata: { second: 2, first: 1 },
  };

  const first = await service.beginDirectUpload(request);
  assertEquals(first.kind, "created");
  if (first.kind !== "created") throw new Error("upload was not created");
  assertEquals(first.replayed, false);

  clock = new Date(clock.getTime() + 30_000);
  const replay = await service.beginDirectUpload({
    ...request,
    metadata: { first: 1, second: 2 },
  });
  assertEquals(replay.kind, "created");
  if (replay.kind !== "created") throw new Error("upload was not replayed");
  assertEquals(replay.replayed, true);
  assertEquals(replay.value.uploadId, first.value.uploadId);
  assertEquals(replay.value.artifactId, first.value.artifactId);
  assertEquals(replay.value.artifactVersionId, first.value.artifactVersionId);
  assertNotEquals(replay.value.upload.url, first.value.upload.url);
  assertEquals(
    replay.value.upload.expiresAt.getTime() <=
      first.value.upload.expiresAt.getTime(),
    true,
  );
  assertEquals(reserveCalls, 1);
  assertEquals(signingCalls, 2);
  assertEquals(signedSizes, [bytes.byteLength, bytes.byteLength]);

  upload = { ...upload!, status: "completed", became_current: true };
  const terminal = await service.beginDirectUpload(request);
  assertEquals(terminal, {
    kind: "completed",
    uploadId: first.value.uploadId,
    artifactId: first.value.artifactId,
    artifactVersionId: first.value.artifactVersionId,
    sequence: first.value.sequence,
    becameCurrent: true,
    replayed: true,
  });
  assertEquals(signingCalls, 2);

  assertEquals(
    await service.beginDirectUpload({
      ...request,
      sizeBytes: bytes.byteLength + 1,
    }),
    { kind: "idempotency_conflict" },
  );
  assertEquals(
    await service.beginDirectUpload({
      ...request,
      target: {
        kind: "new_version",
        artifactId: "art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    }),
    { kind: "idempotency_conflict" },
  );
  assertEquals(reserveCalls, 1);
  assertEquals(
    database.queries.some((query) =>
      query.params.some((parameter) =>
        parameter === first.value.upload.url ||
        parameter === replay.value.upload.url
      )
    ),
    false,
  );
  assertEquals(
    idempotencyRepository.claimQueryables.every((queryable) =>
      queryable === database.client
    ),
    true,
  );
  assertEquals(idempotencyRepository.completeQueryables, [database.client]);
});

Deno.test("idempotent completion replays terminal state without repeating quota or transitions", async () => {
  const uploadId = "upl_0123456789abcdef0123456789abcdef";
  const artifactId = "art_0123456789abcdef0123456789abcdef";
  const artifactVersionId = "aver_0123456789abcdef0123456789abcdef";
  const objectKey =
    `artifacts/${artifactId}/${artifactVersionId}/0123456789abcdef0123456789abcdef0123456789abcdef`;
  const uploads = new Map<string, Record<string, unknown>>([
    [
      uploadId,
      {
        id: uploadId,
        workspace_id: "workspace",
        artifact_id: artifactId,
        artifact_version_id: artifactVersionId,
        output_item_id: null,
        kind: "direct_upload",
        object_key: objectKey,
        expected_previous_version_id: null,
        expected_size_bytes: "5",
        expected_mime_type: "text/plain",
        expected_sha256: sha256,
        content_md5: contentMd5,
        status: "pending",
        expires_at: new Date("2026-08-25T12:10:00.000Z"),
        failure_code: null,
        quota_reservation_id: "reservation_complete",
        quota_state: "reserved",
        created_artifact: true,
        became_current: null,
        cleanup_storage_version_id: null,
      },
    ],
    [
      "upl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      {
        id: "upl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        workspace_id: "workspace",
        artifact_id: "art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        artifact_version_id: "aver_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        output_item_id: null,
        kind: "direct_upload",
        object_key:
          "artifacts/art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/aver_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expected_previous_version_id: null,
        expected_size_bytes: "5",
        expected_mime_type: "text/plain",
        expected_sha256: sha256,
        content_md5: contentMd5,
        status: "completed",
        expires_at: new Date("2026-08-25T12:10:00.000Z"),
        failure_code: null,
        quota_reservation_id: "reservation_other",
        quota_state: "committed",
        created_artifact: true,
        became_current: true,
        cleanup_storage_version_id: null,
      },
    ],
  ]);
  let completionUpdates = 0;
  const database = memoryPool((text, params) => {
    if (
      text.includes("from relay.artifact_uploads u") &&
      text.includes("exists (")
    ) {
      const row = uploads.get(params[1] as string);
      return row === undefined ? { rows: [] } : { rows: [row] };
    }
    if (text.includes("from auth.member")) {
      return { rows: [{ present: true }] };
    }
    if (text.includes("select output_item_id")) {
      const row = uploads.get(params[1] as string);
      return row === undefined
        ? { rows: [] }
        : { rows: [{ output_item_id: row.output_item_id }] };
    }
    if (
      text.includes("from relay.artifact_uploads") &&
      text.includes("for update")
    ) {
      const row = uploads.get(params[1] as string);
      return row === undefined ? { rows: [] } : { rows: [row] };
    }
    if (
      text.includes("select current_version_id, deleted_at, purge_status")
    ) {
      return {
        rows: [{
          current_version_id: null,
          deleted_at: null,
          purge_status: "not_requested",
        }],
      };
    }
    if (
      text.includes("update relay.artifacts") &&
      text.includes("set current_version_id")
    ) {
      return { rows: [], rowCount: 1 };
    }
    if (
      text.includes("update relay.artifact_uploads") &&
      text.includes("set status = 'completed'")
    ) {
      const row = uploads.get(params[1] as string)!;
      uploads.set(params[1] as string, {
        ...row,
        status: "completed",
        quota_state: "committed",
        became_current: params[3],
      });
      completionUpdates += 1;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  });
  const idempotencyRepository = new MemoryIdempotencyRepository();
  let headCalls = 0;
  let quotaCommits = 0;
  const storage: ObjectStorage = {
    ...fakeStorage(),
    headObject: ({ key }) => {
      headCalls += 1;
      return Promise.resolve({
        key,
        sizeBytes: bytes.byteLength,
        contentType: "text/plain",
        etag: "etag",
        storageVersionId: "storage-version",
        checksumSha256: null,
        lastModified: null,
        metadata: {
          "relay-upload-id": uploadId,
          "relay-sha256": sha256,
        },
      });
    },
  };
  const service = new ArtifactService({
    pool: database.pool,
    storage,
    quota: noOpQuota({
      commit: (queryable) => {
        assertEquals(queryable, database.client);
        quotaCommits += 1;
        return Promise.resolve();
      },
    }),
    idempotencyRepository,
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  const request = {
    workspaceId: "workspace",
    actorUserId: "user",
    uploadId,
    idempotencyKey: "complete-request-1",
  };

  assertEquals(await service.completeUpload(request), {
    kind: "completed",
    artifactId,
    artifactVersionId,
    becameCurrent: true,
    replayed: false,
  });
  assertEquals(await service.completeUpload(request), {
    kind: "completed",
    artifactId,
    artifactVersionId,
    becameCurrent: true,
    replayed: true,
  });
  assertEquals(
    await service.completeUpload({
      ...request,
      uploadId: "upl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    { kind: "idempotency_conflict" },
  );
  assertEquals(headCalls, 1);
  assertEquals(quotaCommits, 1);
  assertEquals(completionUpdates, 1);
  assertEquals(idempotencyRepository.completeQueryables, [database.client]);
});

Deno.test("idempotent share creation replays the historical token across key rotation", async () => {
  let clock = new Date("2026-08-25T12:00:00.000Z");
  const artifactId = "art_0123456789abcdef0123456789abcdef";
  const artifactVersionId = "aver_0123456789abcdef0123456789abcdef";
  const links = new Map<string, Record<string, unknown>>();
  let insertCalls = 0;
  const database = memoryPool((text, params) => {
    if (text.includes("from auth.member")) {
      return { rows: [{ present: true }] };
    }
    if (text.includes("select case when $3::boolean")) {
      return params[1] === artifactId
        ? { rows: [{ version_id: artifactVersionId }] }
        : { rows: [] };
    }
    if (
      text.includes("select exists (") &&
      text.includes("from relay.artifact_versions")
    ) {
      return { rows: [{ present: true }] };
    }
    if (text.includes("insert into relay.share_links")) {
      links.set(params[0] as string, {
        id: params[0],
        workspace_id: params[1],
        artifact_id: params[2],
        artifact_version_id: params[3],
        token_hash: params[4],
        token_key_version: params[5],
        follow_current: params[6],
        expires_at: params[7],
        max_resolutions: params[8],
        require_auth: params[9],
        content_disposition: params[10],
        created_by: params[11],
        created_at: params[12],
      });
      insertCalls += 1;
      return { rows: [] };
    }
    if (text.includes("select id, artifact_id, token_hash")) {
      const row = links.get(params[2] as string);
      return row !== undefined && row.artifact_id === params[1]
        ? { rows: [row] }
        : { rows: [] };
    }
    return { rows: [] };
  });
  const idempotencyRepository = new MemoryIdempotencyRepository();
  const oldCodec = new ShareTokenCodec({
    activeVersion: 1,
    keys: [signingKey(1, 0x11)],
  });
  const oldService = new ArtifactService({
    pool: database.pool,
    storage: fakeStorage(),
    quota: noOpQuota(),
    idempotencyRepository,
    shareTokenCodec: oldCodec,
    now: () => new Date(clock),
  });
  const expiresAt = new Date(clock.getTime() + 60_000);
  const request = {
    workspaceId: "workspace",
    actorUserId: "user",
    artifactId,
    followCurrent: true,
    expiresAt,
    maxResolutions: 3,
    requireAuth: true,
    contentDisposition: "attachment" as const,
    idempotencyKey: "share-request-1",
  };

  const first = await oldService.createShareLink(request);
  assertEquals(first.kind, "created");
  if (first.kind !== "created") throw new Error("share link was not created");
  assertEquals(first.replayed, false);
  const stored = links.get(first.value.shareLinkId)!;
  assertEquals(stored.token_key_version, 1);
  assertEquals(stored.token_hash, await hashShareSecret(first.value.token));

  clock = new Date(clock.getTime() + 120_000);
  const rotatedService = new ArtifactService({
    pool: database.pool,
    storage: fakeStorage(),
    quota: noOpQuota(),
    idempotencyRepository,
    shareTokenCodec: new ShareTokenCodec({
      activeVersion: 2,
      keys: [signingKey(2, 0x22), signingKey(1, 0x11)],
    }),
    now: () => new Date(clock),
  });
  const replay = await rotatedService.createShareLink(request);
  assertEquals(replay, {
    kind: "created",
    value: first.value,
    replayed: true,
  });
  assertEquals(insertCalls, 1);

  const current = await rotatedService.createShareLink({
    ...request,
    idempotencyKey: "share-request-2",
    expiresAt: null,
  });
  assertEquals(current.kind, "created");
  if (current.kind !== "created") {
    throw new Error("rotated link was not created");
  }
  assertEquals(links.get(current.value.shareLinkId)?.token_key_version, 2);
  assertNotEquals(current.value.token, first.value.token);

  assertEquals(
    await rotatedService.createShareLink({
      ...request,
      artifactId: "art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    { kind: "idempotency_conflict" },
  );
  assertEquals(insertCalls, 2);
  const insertParameters = database.queries
    .filter((query) => query.text.includes("insert into relay.share_links"))
    .flatMap((query) => query.params);
  assertEquals(insertParameters.includes(first.value.token), false);
  assertEquals(
    JSON.stringify(idempotencyRepository.requests).includes(first.value.token),
    false,
  );
  assertEquals(
    idempotencyRepository.claimQueryables.every((queryable) =>
      queryable === database.client
    ),
    true,
  );
  assertEquals(
    idempotencyRepository.completeQueryables.every((queryable) =>
      queryable === database.client
    ),
    true,
  );
});

Deno.test("idempotent revocation binds the artifact and never repeats the transition", async () => {
  const artifactId = "art_0123456789abcdef0123456789abcdef";
  const shareLinkId = "share_0123456789abcdef0123456789abcdef";
  const link = {
    artifactId,
    revokedAt: null as Date | null,
  };
  let updateCalls = 0;
  const database = memoryPool((text, params) => {
    if (text.includes("from auth.member")) {
      return { rows: [{ present: true }] };
    }
    if (text.includes("select revoked_at")) {
      const matches = params.length === 3 && params[0] === "workspace" &&
        params[1] === link.artifactId && params[2] === shareLinkId;
      return matches
        ? { rows: [{ revoked_at: link.revokedAt }] }
        : { rows: [] };
    }
    if (text.includes("update relay.share_links")) {
      const matches = params.length === 4 && params[0] === "workspace" &&
        params[1] === link.artifactId && params[2] === shareLinkId;
      if (matches && link.revokedAt === null) {
        link.revokedAt = params[3] as Date;
        updateCalls += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [] };
  });
  const idempotencyRepository = new MemoryIdempotencyRepository();
  const service = new ArtifactService({
    pool: database.pool,
    storage: fakeStorage(),
    quota: noOpQuota(),
    idempotencyRepository,
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  const request = {
    workspaceId: "workspace",
    actorUserId: "user",
    artifactId,
    shareLinkId,
    idempotencyKey: "revoke-request-1",
  };

  assertEquals(await service.revokeShareLink(request), {
    kind: "revoked",
    replayed: false,
  });
  assertEquals(await service.revokeShareLink(request), {
    kind: "revoked",
    replayed: true,
  });
  assertEquals(updateCalls, 1);

  assertEquals(
    await service.revokeShareLink({
      ...request,
      artifactId: "art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    { kind: "idempotency_conflict" },
  );
  assertEquals(
    await service.revokeShareLink({
      ...request,
      artifactId: "art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      idempotencyKey: "revoke-request-2",
    }),
    { kind: "not_found", replayed: false },
  );
  assertEquals(updateCalls, 1);
  assertEquals(
    idempotencyRepository.claimQueryables.every((queryable) =>
      queryable === database.client
    ),
    true,
  );
  assertEquals(idempotencyRepository.completeQueryables, [database.client]);
  const boundQueries = database.queries.filter((query) =>
    query.text.includes("relay.share_links") &&
    (query.text.includes("select revoked_at") ||
      query.text.includes("set revoked_at"))
  );
  assertEquals(
    boundQueries.every((query) =>
      query.text.includes("artifact_id = $2") && query.params.length >= 3
    ),
    true,
  );
});

Deno.test("legacy random share tokens continue resolving by token hash", async () => {
  const token = generateShareSecret();
  const tokenHash = await hashShareSecret(token);
  const database = memoryPool((text, params) => {
    if (text.includes("from relay.share_links sl")) {
      assertEquals(params, [tokenHash]);
      return {
        rows: [{
          id: "share_0123456789abcdef0123456789abcdef",
          workspace_id: "workspace",
          artifact_id: "art_0123456789abcdef0123456789abcdef",
          artifact_version_id: "aver_0123456789abcdef0123456789abcdef",
          current_version_id: "aver_0123456789abcdef0123456789abcdef",
          follow_current: false,
          expires_at: null,
          max_resolutions: null,
          resolution_count: 0,
          require_auth: false,
          content_disposition: "attachment",
          revoked_at: null,
          deleted_at: null,
          purged_at: null,
        }],
      };
    }
    if (text.includes("from relay.artifact_versions")) {
      return {
        rows: [{
          object_key: "artifacts/example",
          storage_version_id: null,
          mime_type: "text/plain",
        }],
      };
    }
    if (text.includes("update relay.share_links")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  });
  const storage: ObjectStorage = {
    ...fakeStorage(),
    createDownloadUrl: () =>
      Promise.resolve({
        method: "GET",
        url: "https://ephemeral.example.test/download",
        expiresAt: new Date("2026-08-25T12:01:00.000Z"),
        requiredHeaders: {},
      }),
  };
  const service = new ArtifactService({
    pool: database.pool,
    storage,
    quota: noOpQuota(),
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });

  const result = await service.resolveShareLink({ token });
  assertEquals(result.kind, "authorized");
  assertEquals(
    database.queries.some((query) =>
      query.text.includes("where sl.token_hash = $1") &&
      query.params[0] === tokenHash
    ),
    true,
  );
});
