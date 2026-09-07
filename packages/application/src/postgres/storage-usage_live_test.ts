import { assertEquals } from "@std/assert";
import { createDatabasePool } from "@relay/database";
import { ArtifactService, PostgresArtifactQuota } from "@relay/artifacts";
import type { ObjectStorage } from "@relay/storage";
import { PostgresUsageService } from "./usage.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
Deno.test({
  name:
    "storage usage reads real reservations, cleanup debt, committed bytes and current membership from PostgreSQL",
  ignore: !databaseUrl || Deno.env.get("RUN_ARTIFACT_CONTRACT_TESTS") !== "1",
  fn: async () => {
    const pool = createDatabasePool({
      url: new URL(databaseUrl!),
      poolMax: 3,
      connectTimeoutMs: 5000,
      statementTimeoutMs: 10000,
    }, "relay-api");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const context = {
      workspaceId: `storage-usage-${suffix}`,
      actorUserId: `storage-user-${suffix}`,
    };
    let now = new Date();
    let effectiveLimit = "1000";
    const limitProvider = {
      getLimit: () =>
        Promise.resolve({ kind: "limited" as const, maxBytes: effectiveLimit }),
    };
    const quota = new PostgresArtifactQuota({ limitProvider });
    const read = new PostgresUsageService(
      pool,
      () => now,
      limitProvider.getLimit,
    );
    const unused = () =>
      Promise.reject(
        new Error("Object IO is not used by this PostgreSQL read-model test"),
      );
    const storage: ObjectStorage = {
      createUploadUrl: () =>
        Promise.resolve({
          method: "PUT",
          url: "https://uploads.example.test/fixture",
          expiresAt: new Date(now.getTime() + 60_000),
          requiredHeaders: {},
        }),
      createDownloadUrl: unused,
      putObject: unused,
      getObjectStream: unused,
      headObject: unused,
      hardDeleteObject: unused,
    };
    const artifacts = new ArtifactService({
      pool,
      storage,
      quota,
      uploadTtlSeconds: 60,
      now: () => now,
    });
    try {
      await pool.query(
        'insert into auth."user" (id, name, email, "emailVerified") values ($1,\'Storage test\',$2,true)',
        [context.actorUserId, `${suffix}@example.test`],
      );
      await pool.query(
        "insert into auth.organization (id,name,slug,\"createdAt\") values ($1,'Storage test',$2,now())",
        [context.workspaceId, suffix],
      );
      await pool.query(
        'insert into auth.member (id,"organizationId","userId",role,"createdAt") values ($1,$2,$3,\'owner\',now())',
        [suffix, context.workspaceId, context.actorUserId],
      );
      const unusedWorkspace = await read.getStorageSummary(context);
      if (unusedWorkspace.kind !== "ok") {
        throw new Error("Expected unused workspace");
      }
      assertEquals(unusedWorkspace.storage.storedBytes, "0");
      assertEquals(unusedWorkspace.storage.availableBytes, "1000");
      const upload = await artifacts.beginDirectUpload({
        ...context,
        target: {
          kind: "new_artifact",
          name: "pending.txt",
          mediaKind: "document",
        },
        sizeBytes: 150,
        mimeType: "text/plain",
        sha256: "a".repeat(64),
        contentMd5: `${"A".repeat(22)}==`,
      });
      if (upload.kind !== "created") {
        throw new Error("Expected reserved upload");
      }
      const pending = await read.getStorageSummary(context);
      if (pending.kind !== "ok") throw new Error("Expected storage");
      assertEquals(pending.storage.reservedBytes, "150");
      assertEquals(pending.storage.cleanupPendingBytes, "0");
      now = new Date(now.getTime() + 120_000);
      assertEquals(
        (await artifacts.completeUpload({
          ...context,
          uploadId: upload.value.uploadId,
        })).kind,
        "expired",
      );
      const expired = await read.getStorageSummary(context);
      if (expired.kind !== "ok") throw new Error("Expected storage");
      assertEquals(expired.storage.reservedBytes, "150");
      assertEquals(expired.storage.cleanupPendingBytes, "150");
      assertEquals(expired.storage.availableBytes, "850");

      const client = await pool.connect();
      try {
        await client.query("begin");
        const reserved = await quota.reserve(client, {
          workspaceId: context.workspaceId,
          operationId: `stored-${suffix}`,
          bytes: 400,
        });
        if (reserved.kind !== "reserved") {
          throw new Error("Expected committed fixture reservation");
        }
        await quota.commit(client, {
          workspaceId: context.workspaceId,
          reservationId: reserved.reservationId,
          bytes: 400,
        });
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      const committed = await read.getStorageSummary(context);
      if (committed.kind !== "ok") throw new Error("Expected storage");
      assertEquals(committed.storage.storedBytes, "400");
      assertEquals(committed.storage.availableBytes, "450");
      effectiveLimit = "200";
      const reduced = await read.getStorageSummary(context);
      if (reduced.kind !== "ok") throw new Error("Expected storage");
      assertEquals(reduced.storage.limitBytes, "200");
      assertEquals(reduced.storage.availableBytes, "0");
      assertEquals(
        await read.getStorageSummary({
          ...context,
          workspaceId: `foreign-${suffix}`,
        }),
        { kind: "not_found" },
      );
      await pool.query('delete from auth.member where "organizationId" = $1', [
        context.workspaceId,
      ]);
      assertEquals(await read.getStorageSummary(context), {
        kind: "not_found",
      });
    } finally {
      await pool.end();
      // Immutable fixture history belongs to the disposable integration DB;
      // the test never signs or uploads bytes to any real object store.
    }
  },
});
