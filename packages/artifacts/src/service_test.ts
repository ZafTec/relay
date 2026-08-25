import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ObjectHead, ObjectStorage } from "@relay/storage/types";
import type { ArtifactDatabasePool } from "./database.ts";
import type { ArtifactQuota } from "./quota.ts";
import { ArtifactService } from "./service.ts";
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
