import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import pg from "pg";
import { md5Base64, sha256Hex } from "@relay/storage/checksums";
import type { ObjectStorage } from "@relay/storage/types";
import { createS3ObjectStorage } from "../../storage/src/s3.ts";
import type { ArtifactQuota } from "./quota.ts";
import { ArtifactService } from "./service.ts";
import { createInMemoryQuota } from "./test_support.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const runContract = Deno.env.get("RUN_ARTIFACT_CONTRACT_TESTS") === "1" &&
  databaseUrl !== undefined;
const endpoint = Deno.env.get("MINIO_ENDPOINT") ?? "http://127.0.0.1:9000";
const accessKeyId = Deno.env.get("MINIO_ACCESS_KEY") ?? "relay_dev_only";
const secretAccessKey = Deno.env.get("MINIO_SECRET_KEY") ?? "relay_dev_only";

async function cleanBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    while (true) {
      const listed = await client.send(
        new ListObjectVersionsCommand({ Bucket: bucket }),
      );
      const objects = [
        ...(listed.Versions ?? []),
        ...(listed.DeleteMarkers ?? []),
      ].flatMap((object) =>
        object.Key === undefined || object.VersionId === undefined
          ? []
          : [{ Key: object.Key, VersionId: object.VersionId }]
      );
      if (objects.length === 0) break;
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
    }
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    if (status !== 404) throw error;
  }
}

async function createWorkspace(
  pool: InstanceType<typeof pg.Pool>,
  label: string,
): Promise<{ userId: string; workspaceId: string }> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `user_${label}_${suffix}`;
  const workspaceId = `org_${label}_${suffix}`;
  await pool.query(
    `insert into auth."user" (id, name, email, "emailVerified")
     values ($1, $2, $3, true)`,
    [userId, `${label} user`, `${label}-${suffix}@example.test`],
  );
  await pool.query(
    `insert into auth.organization (id, name, slug, "createdAt")
     values ($1, $2, $3, now())`,
    [workspaceId, `${label} workspace`, `${label}-${suffix}`],
  );
  await pool.query(
    `insert into auth.member
       (id, "organizationId", "userId", role, "createdAt")
     values ($1, $2, $3, 'owner', now())`,
    [`member_${label}_${suffix}`, workspaceId, userId],
  );
  return { userId, workspaceId };
}

async function createRun(
  pool: InstanceType<typeof pg.Pool>,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const toolId = `tool_${suffix}`;
  const toolVersionId = `tver_${suffix}`;
  const runId = `run_${suffix}`;
  await pool.query(
    `insert into relay.tools (id, key, name, lifecycle, visibility)
     values ($1, $2, 'Storage contract tool', 'internal', 'internal')`,
    [toolId, `storage.contract.${suffix}`],
  );
  await pool.query(
    `insert into relay.tool_versions
       (id, tool_id, version, input_schema, output_schema, handler_key,
        execution_mode, max_duration_seconds, immutable_hash)
     values ($1, $2, 1, '{}', '{}', 'storage.contract', 'async', 30,
             repeat('0', 64))`,
    [toolVersionId, toolId],
  );
  await pool.query(
    `insert into relay.tool_runs
       (id, workspace_id, tool_version_id, status, input, created_by)
     values ($1, $2, $3, 'running', '{}', $4)`,
    [runId, workspaceId, toolVersionId, userId],
  );
  return runId;
}

async function uploadAuthorization(
  authorization: {
    readonly method: "PUT";
    readonly url: string;
    readonly requiredHeaders: Readonly<Record<string, string>>;
  },
  bytes: Uint8Array,
): Promise<void> {
  const response = await fetch(authorization.url, {
    method: authorization.method,
    headers: authorization.requiredHeaders,
    body: new Uint8Array(bytes).buffer,
  });
  assertEquals(response.ok, true, await response.text());
}

async function readDownload(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `download failed with ${response.status}: ${await response.text()}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function failHardDeleteOn(
  storage: ObjectStorage,
  failureCall: number,
): ObjectStorage {
  let calls = 0;
  return {
    createUploadUrl: (request) => storage.createUploadUrl(request),
    createDownloadUrl: (request) => storage.createDownloadUrl(request),
    putObject: (request) => storage.putObject(request),
    getObjectStream: (request) => storage.getObjectStream(request),
    headObject: (request) => storage.headObject(request),
    hardDeleteObject: (request) => {
      calls += 1;
      return calls === failureCall
        ? Promise.reject(new Error("injected hard-delete failure"))
        : storage.hardDeleteObject(request);
    },
  };
}

async function claimWorkspaceArtifactPurges(
  pool: InstanceType<typeof pg.Pool>,
  service: ArtifactService,
  workspaceId: string,
  limit?: number,
): Promise<Awaited<ReturnType<ArtifactService["claimArtifactPurges"]>>> {
  const isolation = await pool.connect();
  try {
    await isolation.query("begin");
    // Maintenance claims are global, but this contract owns a separate bucket.
    // Leave older fixtures untouched and let SKIP LOCKED isolate this batch.
    await isolation.query(
      `select id from relay.artifacts
        where workspace_id <> $1
          and purge_status in ('pending', 'claimed', 'deleting_pending', 'deleting')
        for update skip locked`,
      [workspaceId],
    );
    return await service.claimArtifactPurges(limit);
  } finally {
    try {
      await isolation.query("rollback");
    } finally {
      isolation.release();
    }
  }
}

Deno.test({
  name: "artifact lifecycle contract passes against PostgreSQL and MinIO",
  ignore: !runContract,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl! });
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
    const bucket = `relay-artifacts-${suffix}`;
    const credentials = { accessKeyId, secretAccessKey };
    const admin = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      defaultUserAgentProvider: () =>
        Promise.resolve([["relay-artifact-contract", "1"]]),
    });
    const storage = createS3ObjectStorage({
      bucket,
      region: "us-east-1",
      credentials,
      internalEndpoint: endpoint,
      publicSigningEndpoint: endpoint,
      forcePathStyle: true,
      bucketVersioning: "enabled",
    });
    const quota = createInMemoryQuota();
    let clock = new Date();
    const service = new ArtifactService({
      pool,
      storage,
      quota,
      uploadTtlSeconds: 120,
      cleanupLeaseSeconds: 10,
      purgeDelaySeconds: 60,
      downloadTtlSeconds: 60,
      now: () => new Date(clock),
    });

    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    await admin.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
    try {
      const currentUser = await pool.query<{ current_user: string }>(
        "select current_user",
      );
      assertEquals(currentUser.rows[0].current_user, "relay_app");

      const primary = await createWorkspace(pool, "primary");
      const other = await createWorkspace(pool, "other");
      const runId = await createRun(pool, primary.workspaceId, primary.userId);

      const v1Bytes = new TextEncoder().encode("artifact-version-one");
      const v1 = await service.beginDirectUpload({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        target: {
          kind: "new_artifact",
          name: "Primary artifact",
          mediaKind: "document",
        },
        sizeBytes: v1Bytes.byteLength,
        mimeType: "text/plain",
        sha256: await sha256Hex(v1Bytes),
        contentMd5: md5Base64(v1Bytes),
        metadata: { source: "contract" },
      });
      assertEquals(v1.kind, "created");
      if (v1.kind !== "created") {
        throw new Error("direct upload was not staged");
      }
      await uploadAuthorization(v1.value.upload, v1Bytes);
      const concurrentCompletion = await Promise.all([
        service.completeUpload({
          workspaceId: primary.workspaceId,
          actorUserId: primary.userId,
          uploadId: v1.value.uploadId,
        }),
        service.completeUpload({
          workspaceId: primary.workspaceId,
          actorUserId: primary.userId,
          uploadId: v1.value.uploadId,
        }),
      ]);
      for (const completion of concurrentCompletion) {
        assertEquals(completion.kind, "completed");
        if (completion.kind === "completed") {
          assertEquals(
            completion.artifactVersionId,
            v1.value.artifactVersionId,
          );
          assertEquals(completion.becameCurrent, true);
        }
      }

      const replayed = await service.completeUpload({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        uploadId: v1.value.uploadId,
      });
      assertEquals(replayed.kind, "completed");
      if (replayed.kind === "completed") {
        assertEquals(replayed.becameCurrent, true);
      }

      const foundV1 = await service.getArtifact({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        artifactId: v1.value.artifactId,
      });
      assertEquals(foundV1.kind, "found");
      assertEquals(
        await service.getArtifact({
          workspaceId: other.workspaceId,
          actorUserId: other.userId,
          artifactId: v1.value.artifactId,
        }),
        { kind: "not_found" },
      );
      assertEquals(
        await service.getArtifact({
          workspaceId: primary.workspaceId,
          actorUserId: other.userId,
          artifactId: v1.value.artifactId,
        }),
        { kind: "not_found" },
      );

      const unauthorizedUploadCount = await pool.query<{ count: string }>(
        "select count(*) from relay.artifact_uploads where workspace_id = $1",
        [other.workspaceId],
      );
      const crossWorkspaceUpload = await service.beginDirectUpload({
        workspaceId: other.workspaceId,
        actorUserId: other.userId,
        target: { kind: "new_version", artifactId: v1.value.artifactId },
        sizeBytes: v1Bytes.byteLength,
        mimeType: "text/plain",
        sha256: await sha256Hex(v1Bytes),
        contentMd5: md5Base64(v1Bytes),
      });
      assertEquals(crossWorkspaceUpload, { kind: "not_found" });
      const unauthorizedUploadCountAfter = await pool.query<{ count: string }>(
        "select count(*) from relay.artifact_uploads where workspace_id = $1",
        [other.workspaceId],
      );
      assertEquals(
        unauthorizedUploadCountAfter.rows[0].count,
        unauthorizedUploadCount.rows[0].count,
      );

      const v2Bytes = new TextEncoder().encode("artifact-version-two");
      const v3Bytes = new TextEncoder().encode("artifact-version-three-stale");
      const [v2, v3] = await Promise.all([
        service.beginDirectUpload({
          workspaceId: primary.workspaceId,
          actorUserId: primary.userId,
          target: { kind: "new_version", artifactId: v1.value.artifactId },
          sizeBytes: v2Bytes.byteLength,
          mimeType: "text/plain",
          sha256: await sha256Hex(v2Bytes),
          contentMd5: md5Base64(v2Bytes),
        }),
        service.beginDirectUpload({
          workspaceId: primary.workspaceId,
          actorUserId: primary.userId,
          target: { kind: "new_version", artifactId: v1.value.artifactId },
          sizeBytes: v3Bytes.byteLength,
          mimeType: "text/plain",
          sha256: await sha256Hex(v3Bytes),
          contentMd5: md5Base64(v3Bytes),
        }),
      ]);
      assertEquals(v2.kind, "created");
      assertEquals(v3.kind, "created");
      if (v2.kind !== "created" || v3.kind !== "created") {
        throw new Error("parallel versions were not staged");
      }
      await Promise.all([
        uploadAuthorization(v2.value.upload, v2Bytes),
        uploadAuthorization(v3.value.upload, v3Bytes),
      ]);
      const v2Completion = await service.completeUpload({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        uploadId: v2.value.uploadId,
      });
      const v3Completion = await service.completeUpload({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        uploadId: v3.value.uploadId,
      });
      assertEquals(v2Completion.kind, "completed");
      assertEquals(v3Completion.kind, "completed");
      if (v2Completion.kind === "completed") {
        assertEquals(v2Completion.becameCurrent, true);
      }
      if (v3Completion.kind === "completed") {
        assertEquals(v3Completion.becameCurrent, false);
      }
      const originalReplayAfterAdvance = await service.completeUpload({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        uploadId: v1.value.uploadId,
      });
      assertEquals(originalReplayAfterAdvance.kind, "completed");
      if (originalReplayAfterAdvance.kind === "completed") {
        assertEquals(originalReplayAfterAdvance.becameCurrent, true);
      }
      const staleReplay = await service.completeUpload({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        uploadId: v3.value.uploadId,
      });
      assertEquals(staleReplay.kind, "completed");
      if (staleReplay.kind === "completed") {
        assertEquals(staleReplay.becameCurrent, false);
      }

      const versionKeys = await pool.query<{ object_key: string }>(
        `select object_key from relay.artifact_versions
          where workspace_id = $1 and artifact_id = $2`,
        [primary.workspaceId, v1.value.artifactId],
      );
      assertEquals(
        new Set(
          versionKeys.rows.map((row: { object_key: string }) => row.object_key),
        ).size,
        3,
      );

      const managedDownload = await service.createArtifactDownloadUrl({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        artifactId: v1.value.artifactId,
      });
      assertEquals(managedDownload.kind, "authorized");
      if (managedDownload.kind === "authorized") {
        assertEquals(await readDownload(managedDownload.download.url), v2Bytes);
      }

      const pinned = await service.createShareLink({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        artifactId: v1.value.artifactId,
        followCurrent: false,
        artifactVersionId: v1.value.artifactVersionId,
        contentDisposition: "attachment",
      });
      const following = await service.createShareLink({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        artifactId: v1.value.artifactId,
        followCurrent: true,
        maxResolutions: 5,
        contentDisposition: "inline",
      });
      assertEquals(pinned.kind, "created");
      assertEquals(following.kind, "created");
      if (pinned.kind !== "created" || following.kind !== "created") {
        throw new Error("share links were not created");
      }
      const pinnedResolution = await service.resolveShareLink({
        token: pinned.value.token,
      });
      const followingResolution = await service.resolveShareLink({
        token: following.value.token,
      });
      assertEquals(pinnedResolution.kind, "authorized");
      assertEquals(followingResolution.kind, "authorized");
      if (pinnedResolution.kind === "authorized") {
        assertEquals(
          await readDownload(pinnedResolution.download.url),
          v1Bytes,
        );
      }
      if (followingResolution.kind === "authorized") {
        assertEquals(
          await readDownload(followingResolution.download.url),
          v2Bytes,
        );
      }

      const limited = await service.createShareLink({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        artifactId: v1.value.artifactId,
        followCurrent: true,
        maxResolutions: 1,
        contentDisposition: "attachment",
      });
      assertEquals(limited.kind, "created");
      if (limited.kind !== "created") throw new Error("limited link missing");
      const limitedResults = await Promise.all([
        service.resolveShareLink({ token: limited.value.token }),
        service.resolveShareLink({ token: limited.value.token }),
      ]);
      assertEquals(
        limitedResults.filter((result) => result.kind === "authorized").length,
        1,
      );
      assertEquals(
        limitedResults.filter((result) => result.kind === "unavailable").length,
        1,
      );
      const limitedCount = await pool.query<{ resolution_count: number }>(
        "select resolution_count from relay.share_links where id = $1",
        [limited.value.shareLinkId],
      );
      assertEquals(limitedCount.rows[0].resolution_count, 1);

      const authenticated = await service.createShareLink({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        artifactId: v1.value.artifactId,
        followCurrent: true,
        requireAuth: true,
        contentDisposition: "attachment",
      });
      assertEquals(authenticated.kind, "created");
      if (authenticated.kind !== "created") {
        throw new Error("auth link missing");
      }
      assertEquals(
        await service.resolveShareLink({ token: authenticated.value.token }),
        { kind: "authentication_required" },
      );
      assertEquals(
        await service.resolveShareLink({
          token: authenticated.value.token,
          actorUserId: other.userId,
        }),
        { kind: "unavailable" },
      );
      assertEquals(
        (await service.resolveShareLink({
          token: authenticated.value.token,
          actorUserId: primary.userId,
        })).kind,
        "authorized",
      );
      assertEquals(
        await service.revokeShareLink({
          workspaceId: primary.workspaceId,
          actorUserId: primary.userId,
          shareLinkId: authenticated.value.shareLinkId,
        }),
        { kind: "revoked" },
      );
      assertEquals(
        await service.revokeShareLink({
          workspaceId: primary.workspaceId,
          actorUserId: primary.userId,
          shareLinkId: authenticated.value.shareLinkId,
        }),
        { kind: "already_revoked" },
      );
      assertEquals(
        await service.resolveShareLink({
          token: authenticated.value.token,
          actorUserId: primary.userId,
        }),
        { kind: "unavailable" },
      );
      assertEquals(
        await service.createShareLink({
          workspaceId: other.workspaceId,
          actorUserId: other.userId,
          artifactId: v1.value.artifactId,
          followCurrent: true,
          contentDisposition: "attachment",
        }),
        { kind: "not_found" },
      );

      const outputSet = await service.createOutputSet({
        workspaceId: primary.workspaceId,
        runId,
        itemNames: ["Generated first", "Generated second"],
        warnings: [{ code: "safe_warning" }],
      });
      assertEquals(outputSet.kind, "created");
      if (outputSet.kind !== "created") throw new Error("output set missing");
      assertEquals(
        (await service.createOutputSet({
          workspaceId: primary.workspaceId,
          runId,
          itemNames: ["Generated first", "Generated second"],
          warnings: [{ code: "safe_warning" }],
        })).kind,
        "already_exists",
      );
      assertEquals(
        await service.createOutputSet({
          workspaceId: primary.workspaceId,
          runId,
          itemNames: ["Different first", "Different second"],
          warnings: [{ code: "safe_warning" }],
        }),
        { kind: "conflict" },
      );

      const generatedBytes = new TextEncoder().encode("generated-output");
      const generated = await service.ingestGeneratedOutput({
        workspaceId: primary.workspaceId,
        outputSetId: outputSet.outputSetId,
        ordinal: 0,
        bytes: generatedBytes,
        artifactName: "Generated first",
        mediaKind: "document",
        mimeType: "text/plain",
        metadata: { provider: "normalized" },
      });
      assertEquals(generated.kind, "stored");
      if (generated.kind !== "stored") {
        throw new Error("generated output missing");
      }
      assertEquals(
        (await service.ingestGeneratedOutput({
          workspaceId: primary.workspaceId,
          outputSetId: outputSet.outputSetId,
          ordinal: 0,
          bytes: generatedBytes,
          artifactName: "Generated first",
          mediaKind: "document",
          mimeType: "text/plain",
          metadata: { provider: "normalized" },
        })).kind,
        "already_recorded",
      );
      assertEquals(
        await service.recordGeneratedOutputFailure({
          workspaceId: primary.workspaceId,
          outputSetId: outputSet.outputSetId,
          ordinal: 1,
          errorCode: "provider.rejected",
        }),
        { kind: "recorded" },
      );
      assertEquals(
        await service.recordGeneratedOutputFailure({
          workspaceId: primary.workspaceId,
          outputSetId: outputSet.outputSetId,
          ordinal: 1,
          errorCode: "provider.rejected",
        }),
        { kind: "already_recorded" },
      );
      const finalOutputSet = await service.getOutputSet({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        outputSetId: outputSet.outputSetId,
      });
      assertExists(finalOutputSet);
      assertEquals(finalOutputSet.producedCount, 1);
      assertEquals(finalOutputSet.completeness, "partial");
      assertEquals(finalOutputSet.items.map((item) => item.status), [
        "succeeded",
        "failed",
      ]);
      assertEquals(
        await service.getOutputSet({
          workspaceId: other.workspaceId,
          actorUserId: other.userId,
          outputSetId: outputSet.outputSetId,
        }),
        null,
      );
      assertEquals(
        await service.getOutputSet({
          workspaceId: primary.workspaceId,
          actorUserId: other.userId,
          outputSetId: outputSet.outputSetId,
        }),
        null,
      );

      const generatedVersion = await pool.query<{
        verification_status: string;
      }>(
        `select verification_status from relay.artifact_versions
          where workspace_id = $1 and id = $2`,
        [primary.workspaceId, generated.artifactVersionId],
      );
      assertEquals(
        generatedVersion.rows[0].verification_status,
        "cryptographically_verified",
      );

      const shareExpiresAt = new Date(clock.getTime() + 10_000);
      const expiring = await service.createShareLink({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        artifactId: generated.artifactId,
        followCurrent: true,
        expiresAt: shareExpiresAt,
        contentDisposition: "attachment",
      });
      assertEquals(expiring.kind, "created");
      if (expiring.kind !== "created") throw new Error("expiring link missing");
      const expiringResolution = await service.resolveShareLink({
        token: expiring.value.token,
      });
      assertEquals(expiringResolution.kind, "authorized");
      if (expiringResolution.kind === "authorized") {
        assertEquals(
          expiringResolution.download.expiresAt.getTime() <=
            shareExpiresAt.getTime(),
          true,
        );
      }
      clock = new Date(clock.getTime() + 11_000);
      assertEquals(
        await service.resolveShareLink({ token: expiring.value.token }),
        { kind: "unavailable" },
      );

      const mismatchBytes = new TextEncoder().encode("mismatched-upload");
      const mismatch = await service.beginDirectUpload({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        target: {
          kind: "new_artifact",
          name: "Mismatch artifact",
          mediaKind: "document",
        },
        sizeBytes: mismatchBytes.byteLength,
        mimeType: "text/plain",
        sha256: await sha256Hex(mismatchBytes),
        contentMd5: md5Base64(mismatchBytes),
      });
      assertEquals(mismatch.kind, "created");
      if (mismatch.kind !== "created") {
        throw new Error("mismatch upload missing");
      }
      const mismatchRow = await pool.query<{
        object_key: string;
        quota_reservation_id: string;
      }>(
        `select object_key, quota_reservation_id
           from relay.artifact_uploads where id = $1`,
        [mismatch.value.uploadId],
      );
      await storage.putObject({
        key: mismatchRow.rows[0].object_key,
        body: mismatchBytes,
        sizeBytes: mismatchBytes.byteLength,
        contentType: "text/plain",
        contentMd5: md5Base64(mismatchBytes),
        sha256Hex: await sha256Hex(mismatchBytes),
        metadata: {
          "relay-upload-id": "upl_ffffffffffffffffffffffffffffffff",
          "relay-sha256": await sha256Hex(mismatchBytes),
        },
      });
      const mismatchCompletion = await service.completeUpload({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        uploadId: mismatch.value.uploadId,
      });
      assertEquals(mismatchCompletion.kind, "verification_failed");
      assertEquals(
        quota.reserved.get(mismatchRow.rows[0].quota_reservation_id),
        "reserved",
      );
      const mismatchDebt = await pool.query<{
        quota_state: string;
        cleanup_status: string;
      }>(
        `select quota_state, cleanup_status
           from relay.artifact_uploads where id = $1`,
        [mismatch.value.uploadId],
      );
      assertEquals(mismatchDebt.rows[0], {
        quota_state: "cleanup_held",
        cleanup_status: "pending",
      });
      const earlyCleanup = await service.claimUploadCleanup();
      assertEquals(
        earlyCleanup.some((lease) =>
          lease.uploadId === mismatch.value.uploadId
        ),
        false,
      );
      for (const lease of earlyCleanup) {
        await service.processUploadCleanup(lease);
      }

      const abandonedBytes = new TextEncoder().encode("abandoned-upload");
      const abandoned = await service.beginDirectUpload({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        target: {
          kind: "new_artifact",
          name: "Abandoned artifact",
          mediaKind: "document",
        },
        sizeBytes: abandonedBytes.byteLength,
        mimeType: "text/plain",
        sha256: await sha256Hex(abandonedBytes),
        contentMd5: md5Base64(abandonedBytes),
      });
      assertEquals(abandoned.kind, "created");
      if (abandoned.kind !== "created") {
        throw new Error("abandoned upload missing");
      }
      await uploadAuthorization(abandoned.value.upload, abandonedBytes);
      const abandonedReservation = await pool.query<{
        quota_reservation_id: string;
      }>(
        "select quota_reservation_id from relay.artifact_uploads where id = $1",
        [abandoned.value.uploadId],
      );

      await assertRejects(
        () =>
          pool.query(
            `update relay.artifact_versions
                set object_key = object_key || '0'
              where id = $1`,
            [v1.value.artifactVersionId],
          ),
        Error,
        "immutable",
      );
      await assertRejects(
        () =>
          pool.query(
            `update relay.artifact_versions
                set purge_status = 'deleted', purged_at = now()
              where id = $1`,
            [v1.value.artifactVersionId],
          ),
        Error,
        "purge",
      );
      await assertRejects(
        () =>
          pool.query(
            `update relay.artifacts
                set current_version_id = null, deleted_at = now(),
                    purge_after = now(), purge_status = 'purged',
                    purge_io_started_at = now(), purged_at = now()
              where id = $1`,
            [v1.value.artifactId],
          ),
        Error,
        "purge",
      );
      await assertRejects(
        () =>
          pool.query("delete from relay.artifacts where id = $1", [
            v1.value.artifactId,
          ]),
        Error,
        "permission denied",
      );

      const firstDelete = await service.softDeleteArtifact({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        artifactId: v1.value.artifactId,
      });
      assertEquals(firstDelete.kind, "deleted");
      assertEquals(
        (await service.softDeleteArtifact({
          workspaceId: primary.workspaceId,
          actorUserId: primary.userId,
          artifactId: v1.value.artifactId,
        })).kind,
        "already_deleted",
      );
      assertEquals(
        await service.resolveShareLink({ token: following.value.token }),
        { kind: "unavailable" },
      );
      const restored = await service.restoreArtifact({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        artifactId: v1.value.artifactId,
      });
      assertEquals(restored.kind, "restored");
      if (restored.kind !== "restored") throw new Error("restore failed");
      assertNotEquals(restored.artifactVersionId, v2.value.artifactVersionId);
      const allMainVersionKeys = await pool.query<{ object_key: string }>(
        `select object_key from relay.artifact_versions
          where workspace_id = $1 and artifact_id = $2`,
        [primary.workspaceId, v1.value.artifactId],
      );
      assertEquals(allMainVersionKeys.rows.length, 4);
      const restoredDownload = await service.createArtifactDownloadUrl({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        artifactId: v1.value.artifactId,
      });
      assertEquals(restoredDownload.kind, "authorized");
      if (restoredDownload.kind === "authorized") {
        assertEquals(
          await readDownload(restoredDownload.download.url),
          v2Bytes,
        );
      }

      const mainReservations = await pool.query<{
        quota_reservation_id: string;
      }>(
        `select quota_reservation_id
           from relay.artifact_uploads
          where workspace_id = $1 and artifact_id = $2 and status = 'completed'`,
        [primary.workspaceId, v1.value.artifactId],
      );
      assertEquals(mainReservations.rows.length, 4);

      const secondDelete = await service.softDeleteArtifact({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        artifactId: v1.value.artifactId,
      });
      assertEquals(secondDelete.kind, "deleted");
      if (secondDelete.kind !== "deleted") throw new Error("delete failed");
      clock = new Date(secondDelete.purgeAfter.getTime() + 1);
      const purgeLeases = await claimWorkspaceArtifactPurges(
        pool,
        service,
        primary.workspaceId,
      );
      const primaryPurge = purgeLeases.find((lease) =>
        lease.artifactId === v1.value.artifactId
      );
      assertExists(primaryPurge);
      const stalePurge = await service.processArtifactPurge({
        ...primaryPurge,
        leaseToken: "please_00000000000000000000000000000000",
      });
      assertEquals(stalePurge, { kind: "lease_lost" });
      const partialPurgeService = new ArtifactService({
        pool,
        storage: failHardDeleteOn(storage, 2),
        quota,
        uploadTtlSeconds: 120,
        cleanupLeaseSeconds: 10,
        purgeDelaySeconds: 60,
        downloadTtlSeconds: 60,
        now: () => new Date(clock),
      });
      assertEquals(
        await partialPurgeService.processArtifactPurge(primaryPurge),
        { kind: "retry_scheduled" },
      );
      const partialProgress = await pool.query<{
        purge_status: string;
        purge_io_started_at: Date | null;
        deleted_versions: string;
      }>(
        `select a.purge_status, a.purge_io_started_at,
                count(*) filter (where v.purge_status = 'deleted')
                  as deleted_versions
           from relay.artifacts a
           join relay.artifact_versions v
             on v.workspace_id = a.workspace_id and v.artifact_id = a.id
          where a.workspace_id = $1 and a.id = $2
          group by a.id`,
        [primary.workspaceId, v1.value.artifactId],
      );
      assertEquals(partialProgress.rows[0].purge_status, "deleting_pending");
      assertExists(partialProgress.rows[0].purge_io_started_at);
      assertEquals(Number(partialProgress.rows[0].deleted_versions), 1);
      assertEquals(
        await service.restoreArtifact({
          workspaceId: primary.workspaceId,
          actorUserId: primary.userId,
          artifactId: v1.value.artifactId,
        }),
        { kind: "not_found" },
      );
      const resumedPurge = (await claimWorkspaceArtifactPurges(
        pool,
        service,
        primary.workspaceId,
        1,
      ))[0];
      assertExists(resumedPurge);
      assertEquals(resumedPurge.artifactId, v1.value.artifactId);
      assertNotEquals(resumedPurge.leaseToken, primaryPurge.leaseToken);
      assertEquals(await service.processArtifactPurge(primaryPurge), {
        kind: "lease_lost",
      });
      assertEquals(await service.processArtifactPurge(resumedPurge), {
        kind: "purged",
      });
      for (const reservation of mainReservations.rows) {
        assertEquals(
          quota.reserved.get(reservation.quota_reservation_id),
          "decremented",
        );
      }
      assertEquals(
        await service.getArtifact({
          workspaceId: primary.workspaceId,
          actorUserId: primary.userId,
          artifactId: v1.value.artifactId,
          includeDeleted: true,
        }),
        { kind: "not_found" },
      );
      const completedProgress = await pool.query<{
        purge_status: string;
        purged_at: Date | null;
      }>(
        `select purge_status, purged_at
           from relay.artifact_versions
          where workspace_id = $1 and artifact_id = $2`,
        [primary.workspaceId, v1.value.artifactId],
      );
      assertEquals(
        completedProgress.rows.every((row: {
          purge_status: string;
          purged_at: Date | null;
        }) => row.purge_status === "deleted" && row.purged_at !== null),
        true,
      );
      for (const { object_key } of allMainVersionKeys.rows) {
        assertEquals(await storage.headObject({ key: object_key }), null);
        const physical = await admin.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: object_key,
          }),
        );
        assertEquals(
          [...(physical.Versions ?? []), ...(physical.DeleteMarkers ?? [])]
            .some((identity) => identity.Key === object_key),
          false,
        );
      }

      clock = new Date(clock.getTime() + 121_000);
      const expired = await service.expirePendingUploads();
      assert(
        expired.some((upload) => upload.uploadId === abandoned.value.uploadId),
      );
      assertEquals(
        quota.reserved.get(
          abandonedReservation.rows[0].quota_reservation_id,
        ),
        "reserved",
      );
      const cleanupLeases = await service.claimUploadCleanup();
      const mismatchLease = cleanupLeases.find((lease) =>
        lease.uploadId === mismatch.value.uploadId
      );
      const abandonedLease = cleanupLeases.find((lease) =>
        lease.uploadId === abandoned.value.uploadId
      );
      assertExists(mismatchLease);
      assertExists(abandonedLease);
      assertEquals(abandonedLease.storageVersionId, null);
      assertEquals(
        await service.processUploadCleanup({
          ...mismatchLease,
          leaseToken: "lease_00000000000000000000000000000000",
        }),
        { kind: "lease_lost" },
      );
      assertExists(
        await storage.headObject({ key: mismatchRow.rows[0].object_key }),
      );
      const failedCleanupService = new ArtifactService({
        pool,
        storage: failHardDeleteOn(storage, 1),
        quota,
        cleanupLeaseSeconds: 10,
        now: () => new Date(clock),
      });
      assertEquals(
        await failedCleanupService.processUploadCleanup(abandonedLease),
        { kind: "retry_scheduled" },
      );
      const heldCleanup = await pool.query<{
        quota_state: string;
        cleanup_status: string;
      }>(
        `select quota_state, cleanup_status
           from relay.artifact_uploads where id = $1`,
        [abandoned.value.uploadId],
      );
      assertEquals(heldCleanup.rows[0], {
        quota_state: "cleanup_held",
        cleanup_status: "pending",
      });
      assertEquals(
        quota.reserved.get(
          abandonedReservation.rows[0].quota_reservation_id,
        ),
        "reserved",
      );
      assertEquals(await service.processUploadCleanup(mismatchLease), {
        kind: "deleted",
      });
      assertEquals(
        quota.reserved.get(mismatchRow.rows[0].quota_reservation_id),
        "released",
      );
      clock = new Date(clock.getTime() + 11_000);
      const retriedCleanup = (await service.claimUploadCleanup()).find((
        lease,
      ) => lease.uploadId === abandoned.value.uploadId);
      assertExists(retriedCleanup);
      assertEquals(await service.processUploadCleanup(retriedCleanup), {
        kind: "deleted",
      });
      assertEquals(
        quota.reserved.get(
          abandonedReservation.rows[0].quota_reservation_id,
        ),
        "released",
      );
      assertEquals(
        await storage.headObject({ key: mismatchRow.rows[0].object_key }),
        null,
      );
      const abandonedKey = await pool.query<{ object_key: string }>(
        `select object_key from relay.artifact_uploads where id = $1`,
        [abandoned.value.uploadId],
      );
      const abandonedVersions = await admin.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: abandonedKey.rows[0].object_key,
        }),
      );
      assertEquals(
        [
          ...(abandonedVersions.Versions ?? []),
          ...(abandonedVersions.DeleteMarkers ?? []),
        ].some((identity) => identity.Key === abandonedKey.rows[0].object_key),
        false,
      );

      const firstFailedClaims = (await claimWorkspaceArtifactPurges(
        pool,
        service,
        primary.workspaceId,
        2,
      )).filter(
        (lease) =>
          lease.artifactId === mismatch.value.artifactId ||
          lease.artifactId === abandoned.value.artifactId,
      );
      assertEquals(firstFailedClaims.length, 2);
      clock = new Date(clock.getTime() + 11_000);
      const oneReclaimed = (await claimWorkspaceArtifactPurges(
        pool,
        service,
        primary.workspaceId,
        1,
      ))[0];
      assertExists(oneReclaimed);
      const claimStates = await pool.query<{
        id: string;
        purge_status: string;
        purge_lease_token: string;
      }>(
        `select id, purge_status, purge_lease_token
           from relay.artifacts where id = any($1::text[]) order by id`,
        [[mismatch.value.artifactId, abandoned.value.artifactId]],
      );
      assertEquals(
        claimStates.rows.filter((row: {
          id: string;
          purge_status: string;
          purge_lease_token: string;
        }) => row.purge_status === "claimed").length,
        2,
      );
      assertEquals(
        firstFailedClaims.filter((oldLease) =>
          claimStates.rows.some((row: {
            id: string;
            purge_status: string;
            purge_lease_token: string;
          }) =>
            row.id === oldLease.artifactId &&
            row.purge_lease_token === oldLease.leaseToken
          )
        ).length,
        1,
      );
      assertEquals(await service.processArtifactPurge(oneReclaimed), {
        kind: "purged",
      });
      const finalFailedClaim = (await claimWorkspaceArtifactPurges(
        pool,
        service,
        primary.workspaceId,
        1,
      ))[0];
      assertExists(finalFailedClaim);
      assertEquals(await service.processArtifactPurge(finalFailedClaim), {
        kind: "purged",
      });

      const uploadCountBefore = await pool.query<{ count: string }>(
        "select count(*) from relay.artifact_uploads",
      );
      const deniedQuota: ArtifactQuota = {
        reserve: () => Promise.resolve({ kind: "denied" }),
        commit: () => Promise.reject(new Error("unexpected quota commit")),
        release: () => Promise.reject(new Error("unexpected quota release")),
        decrementCommitted: () =>
          Promise.reject(new Error("unexpected quota decrement")),
      };
      const deniedService = new ArtifactService({
        pool,
        storage,
        quota: deniedQuota,
        now: () => new Date(clock),
      });
      const denied = await deniedService.beginDirectUpload({
        workspaceId: primary.workspaceId,
        actorUserId: primary.userId,
        target: {
          kind: "new_artifact",
          name: "Denied artifact",
          mediaKind: "document",
        },
        sizeBytes: v1Bytes.byteLength,
        mimeType: "text/plain",
        sha256: await sha256Hex(v1Bytes),
        contentMd5: md5Base64(v1Bytes),
      });
      assertEquals(denied, { kind: "quota_exceeded" });
      const uploadCountAfter = await pool.query<{ count: string }>(
        "select count(*) from relay.artifact_uploads",
      );
      assertEquals(
        uploadCountAfter.rows[0].count,
        uploadCountBefore.rows[0].count,
      );

      const rawUrls = await pool.query<{ present: boolean }>(
        `select exists (
           select 1
             from (
               select to_jsonb(a)::text as value from relay.artifacts a
               union all
               select to_jsonb(v)::text from relay.artifact_versions v
               union all
               select to_jsonb(u)::text from relay.artifact_uploads u
               union all
               select to_jsonb(os)::text from relay.output_sets os
               union all
               select to_jsonb(oi)::text from relay.output_items oi
               union all
               select to_jsonb(sl)::text from relay.share_links sl
             ) durable
            where durable.value ~* '[a-z][a-z0-9+.-]*://'
         ) as present`,
      );
      assertEquals(rawUrls.rows[0].present, false);
    } finally {
      storage.close();
      await cleanBucket(admin, bucket);
      admin.destroy();
      await pool.end();
    }
  },
});
