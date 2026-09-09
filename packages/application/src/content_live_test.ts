import { assert, assertEquals, assertThrows } from "@std/assert";
import { createDatabasePool } from "@relay/database";
import {
  ArtifactService,
  PostgresArtifactMutationIdempotencyRepository,
  PostgresArtifactQuota,
  ShareTokenCodec,
} from "@relay/artifacts";
import { createS3ObjectStorage } from "@relay/storage";
import { ArtifactCommandAdapter } from "./artifact-commands.ts";
import { PostgresArtifactReadService } from "./postgres/artifacts.ts";
import { fetchRemoteContent } from "./remote-content.ts";
import { deleteManagedWorkspace } from "../../auth/src/workspace-management.ts";
import {
  createContentService,
  decodeUploadedContent,
  MAX_INLINE_CONTENT_BYTES,
} from "./content.ts";

Deno.test("inline content decoding rejects invalid and oversized input before persistence", () => {
  assertEquals(
    decodeUploadedContent({ encoding: "text", content: "ሰላም" }),
    new TextEncoder().encode("ሰላም"),
  );
  for (
    const content of [
      "data:text/plain;base64,QQ==",
      "not base64",
      "QR==",
      "Q===",
    ]
  ) {
    assertThrows(() => {
      decodeUploadedContent({ encoding: "base64", content });
    });
  }
  assertThrows(() => {
    decodeUploadedContent({
      encoding: "text",
      content: "ሀ".repeat(MAX_INLINE_CONTENT_BYTES / 2),
    });
  }, RangeError);
});

const url = Deno.env.get("DATABASE_URL");
Deno.test({
  name:
    "content uploads persist verified bytes in MinIO with quota, replay, private downloads and revocable permanent links",
  ignore: !url || Deno.env.get("RUN_ARTIFACT_CONTRACT_TESTS") !== "1",
  fn: async () => {
    const pool = createDatabasePool({
      url: new URL(url!),
      poolMax: 5,
      connectTimeoutMs: 5000,
      statementTimeoutMs: 10000,
    }, "relay-api");
    const storage = createS3ObjectStorage({
      bucket: "relay-artifacts",
      region: "us-east-1",
      internalEndpoint: Deno.env.get("MINIO_ENDPOINT") ??
        "http://127.0.0.1:9000",
      credentials: {
        accessKeyId: Deno.env.get("MINIO_ACCESS_KEY") ?? "relay_dev_only",
        secretAccessKey: Deno.env.get("MINIO_SECRET_KEY") ?? "relay_dev_only",
      },
      forcePathStyle: true,
      bucketVersioning: "enabled",
    });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const context = {
      workspaceId: `content-workspace-${suffix}`,
      actorUserId: `content-user-${suffix}`,
    };
    let storageLimit = "64";
    const domain = new ArtifactService({
      pool,
      storage,
      quota: new PostgresArtifactQuota({
        limitProvider: {
          getLimit: () =>
            Promise.resolve({ kind: "limited", maxBytes: storageLimit }),
        },
      }),
      idempotencyRepository:
        new PostgresArtifactMutationIdempotencyRepository(),
      shareTokenCodec: new ShareTokenCodec({
        activeVersion: 1,
        keys: [{ version: 1, secret: new Uint8Array(32).fill(1) }],
      }),
    });
    const reads = new PostgresArtifactReadService(pool);
    const commands = new ArtifactCommandAdapter(domain);
    const artifactServices = {
      get: reads.get.bind(reads),
      list: reads.list.bind(reads),
      createDownload: commands.createDownload.bind(commands),
      createUpload: commands.createUpload.bind(commands),
      completeUpload: commands.completeUpload.bind(commands),
      createShareLink: commands.createShareLink.bind(commands),
      revokeShareLink: commands.revokeShareLink.bind(commands),
      resolveShareLink: commands.resolveShareLink.bind(commands),
    };
    const service = createContentService(
      domain,
      artifactServices,
      "http://localhost:8000",
    );
    try {
      await pool.query(
        'insert into auth."user"(id,name,email,"emailVerified") values($1,\'Content test\',$2,true)',
        [context.actorUserId, `${suffix}@example.test`],
      );
      await pool.query(
        "insert into auth.organization(id,name,slug,\"createdAt\") values($1,'Content test',$2,now())",
        [context.workspaceId, suffix],
      );
      await pool.query(
        'insert into auth.member(id,"organizationId","userId",role,"createdAt") values($1,$2,$3,\'owner\',now())',
        [suffix, context.workspaceId, context.actorUserId],
      );
      const content = "%PDF-1.4\n% fixture\n%%EOF";
      const input = {
        name: "chat.pdf",
        mimeType: "application/pdf",
        encoding: "base64" as const,
        content: btoa(content),
      };
      assertEquals(
        (await service.upload(
          { ...context, actorUserId: "foreign-user" },
          input,
          "foreign",
        )).kind,
        "not_found",
      );
      const uploaded = await service.upload(context, input, "stable-upload");
      assert(uploaded.kind === "authorized");
      assertEquals(uploaded.access, "temporary");
      assert(uploaded.expiresAt);
      const downloaded = await fetch(uploaded.url);
      assertEquals(downloaded.status, 200);
      assertEquals(await downloaded.text(), content);
      const replayed = await service.upload(context, input, "stable-upload");
      assert(replayed.kind === "authorized");
      assertEquals(replayed.artifactVersionId, uploaded.artifactVersionId);
      const changed = await service.upload(context, {
        ...input,
        content: btoa("different bytes"),
      }, "stable-upload");
      assertEquals(changed.kind, "idempotency_conflict");
      const overflow = await service.upload(context, {
        ...input,
        content: btoa("x".repeat(65)),
      }, "over-limit");
      assertEquals(overflow.kind, "quota_exceeded");
      const detail = await reads.get(context, uploaded.artifactId);
      assert(detail.kind === "found");
      assertEquals(detail.artifact.versions.length, 1);
      assertEquals(
        detail.artifact.currentVersion?.sizeBytes,
        new TextEncoder().encode(content).byteLength,
      );
      assertEquals(detail.artifact.shares.length, 0);
      const share = await service.access(context, {
        artifactId: uploaded.artifactId,
        access: "permanent",
      }, "stable-share");
      assert(share.kind === "authorized");
      assertEquals(share.expiresAt, null);
      assert(share.shareLinkId);
      const shareReplay = await service.access(context, {
        artifactId: uploaded.artifactId,
        access: "permanent",
      }, "stable-share");
      assertEquals(shareReplay, share);
      const token = share.url.split("/").at(-1)!;
      assertEquals((await commands.resolveShareLink(token)).kind, "authorized");
      assertEquals(
        (await commands.revokeShareLink(
          context,
          uploaded.artifactId,
          share.shareLinkId,
          "revoke-share",
        )).kind,
        "revoked",
      );
      assertEquals(
        (await commands.resolveShareLink(token)).kind,
        "unavailable",
      );
      let remoteBytes = new TextEncoder().encode("Imported notes");
      const imports = createContentService(
        domain,
        artifactServices,
        "http://localhost:8000",
        (raw) =>
          fetchRemoteContent(raw, {
            resolve: () =>
              Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
            request: () =>
              Promise.resolve({
                status: 200,
                type: "text/plain",
                body: (async function* () {
                  yield remoteBytes;
                })(),
                close() {},
              }),
          }),
      );
      const imported = await imports.importUrl!(context, {
        url: "https://files.example.test/notes.txt",
      }, "url-import");
      assert(imported.kind === "authorized");
      assertEquals(await (await fetch(imported.url)).text(), "Imported notes");
      const importReplay = await imports.importUrl!(context, {
        url: "https://files.example.test/notes.txt",
      }, "url-import");
      assert(importReplay.kind === "authorized");
      assertEquals(importReplay.artifactVersionId, imported.artifactVersionId);
      remoteBytes = new TextEncoder().encode("Changed notes");
      assertEquals(
        (await imports.importUrl!(context, {
          url: "https://files.example.test/notes.txt",
        }, "url-import")).kind,
        "idempotency_conflict",
      );
      remoteBytes = new Uint8Array(65).fill(65);
      assertEquals(
        (await imports.importUrl!(context, {
          url: "https://files.example.test/large.txt",
        }, "url-overflow")).kind,
        "quota_exceeded",
      );
      // Deleting a workspace revokes permanent links and marks its stored files for cleanup.
      storageLimit = "100000000";
      remoteBytes = new Uint8Array(5_000_001).fill(65);
      const largeImport = await imports.importUrl!(context, {
        url: "https://files.example.test/large.txt",
      }, "url-above-inline-limit");
      assert(largeImport.kind === "authorized");
      assertEquals(
        (await (await fetch(largeImport.url)).arrayBuffer()).byteLength,
        5_000_001,
      );
      const activeShare = await service.access(context, {
        artifactId: imported.artifactId,
        access: "permanent",
      }, "workspace-share");
      assert(activeShare.kind === "authorized");
      const session = `content-session-${suffix}`;
      await pool.query(
        'insert into auth.session(id,"userId",token,"expiresAt","createdAt","updatedAt") values($1,$2,$1,now()+interval \'1 day\',now(),now())',
        [session, context.actorUserId],
      );
      await deleteManagedWorkspace(pool, session, context.workspaceId, suffix);
      assertEquals(
        (await commands.resolveShareLink(activeShare.url.split("/").at(-1)!))
          .kind,
        "unavailable",
      );
      assertEquals(
        (await pool.query(
          "select count(*)::integer as count from relay.artifacts where workspace_id=$1 and deleted_at is not null and purge_status='pending'",
          [context.workspaceId],
        )).rows[0].count,
        3,
      );
      await pool.query("delete from auth.session where id=$1", [session]);
      await pool.query('delete from auth.member where "organizationId"=$1', [
        context.workspaceId,
      ]);
      assertEquals(
        (await service.access(context, { artifactId: uploaded.artifactId }))
          .kind,
        "not_found",
      );
    } finally {
      const rows = (await pool.query(
        "select object_key from relay.artifact_versions where workspace_id=$1",
        [context.workspaceId],
      )).rows;
      for (const row of rows) {
        await storage.hardDeleteObject({ key: row.object_key });
      }
      storage.close();
      await pool.end();
      // Immutable artifact and quota history stays in the disposable database.
    }
  },
});
