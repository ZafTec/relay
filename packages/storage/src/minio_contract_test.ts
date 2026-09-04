import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { md5Base64, sha256Hex } from "./checksums.ts";
import { createImmutableObjectKey } from "./keys.ts";
import { createS3ObjectStorage } from "./s3.ts";

const runContract = Deno.env.get("RUN_MINIO_CONTRACT_TESTS") === "1";
const endpoint = Deno.env.get("MINIO_ENDPOINT") ?? "http://127.0.0.1:9000";
const accessKeyId = Deno.env.get("MINIO_ACCESS_KEY") ?? "relay_dev_only";
const secretAccessKey = Deno.env.get("MINIO_SECRET_KEY") ?? "relay_dev_only";

function body(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
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

Deno.test({
  name: "S3 object-storage contract passes against MinIO",
  ignore: !runContract,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
    const bucket = `relay-storage-${suffix}`;
    const credentials = { accessKeyId, secretAccessKey };
    const admin = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      defaultUserAgentProvider: () =>
        Promise.resolve([["relay-storage-contract", "1"]]),
    });
    const storage = createS3ObjectStorage({
      bucket,
      region: "us-east-1",
      credentials,
      internalEndpoint: endpoint,
      publicSigningEndpoint: endpoint,
      forcePathStyle: true,
      bucketVersioning: "enabled",
      requestTimeoutMs: 5_000,
    });

    try {
      await admin.send(new CreateBucketCommand({ Bucket: bucket }));
      assertEquals(await storage.checkHealth(), {
        name: "storage",
        status: "error",
        message: "bucket versioning must be enabled",
      });

      const missingStorage = createS3ObjectStorage({
        bucket: `${bucket}-missing`,
        region: "us-east-1",
        credentials,
        internalEndpoint: endpoint,
        forcePathStyle: true,
        bucketVersioning: "enabled",
        requestTimeoutMs: 5_000,
      });
      try {
        assertEquals(await missingStorage.checkHealth(), {
          name: "storage",
          status: "error",
          message: "bucket is unavailable",
        });
      } finally {
        missingStorage.close();
      }

      const invalidCredentialsStorage = createS3ObjectStorage({
        bucket,
        region: "us-east-1",
        credentials: {
          accessKeyId: `${accessKeyId}-invalid`,
          secretAccessKey: `${secretAccessKey}-invalid`,
        },
        internalEndpoint: endpoint,
        forcePathStyle: true,
        bucketVersioning: "enabled",
        requestTimeoutMs: 5_000,
      });
      try {
        const readiness = await invalidCredentialsStorage.checkHealth();
        assertEquals(readiness, {
          name: "storage",
          status: "error",
          message: "bucket is unavailable",
        });
        assertEquals(
          JSON.stringify(readiness).includes(secretAccessKey),
          false,
        );
      } finally {
        invalidCredentialsStorage.close();
      }

      await admin.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );
      assertEquals(await storage.checkHealth(), {
        name: "storage",
        status: "ok",
      });
      await admin.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: "Suspended" },
        }),
      );
      assertEquals(await storage.checkHealth(), {
        name: "storage",
        status: "error",
        message: "bucket versioning must be enabled",
      });
      await admin.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );

      const bytes = new TextEncoder().encode(
        `relay-minio-contract-${crypto.randomUUID()}`,
      );
      const contentMd5 = md5Base64(bytes);
      const digest = await sha256Hex(bytes);
      const artifactId = "art_0123456789abcdef0123456789abcdef";
      const versionId = "aver_fedcba9876543210fedcba9876543210";
      const key = createImmutableObjectKey({
        artifactId,
        artifactVersionId: versionId,
      });
      const uploadId = "upl_0123456789abcdef0123456789abcdef";
      const authorization = await storage.createUploadUrl({
        key,
        uploadId,
        sizeBytes: bytes.byteLength,
        contentType: "application/octet-stream",
        contentMd5,
        sha256Hex: digest,
        expiresInSeconds: 60,
      });

      const uploadUrl = new URL(authorization.url);
      assertEquals(uploadUrl.origin, endpoint);
      assertStringIncludes(uploadUrl.pathname, `/${bucket}/${key}`);
      assertEquals(
        authorization.requiredHeaders["content-length"],
        String(bytes.byteLength),
      );

      const uploaded = await fetch(authorization.url, {
        method: authorization.method,
        headers: authorization.requiredHeaders,
        body: body(bytes),
      });
      assertEquals(uploaded.ok, true, await uploaded.text());

      const head = await storage.headObject({ key });
      assertExists(head);
      assertEquals(head.sizeBytes, bytes.byteLength);
      assertEquals(head.contentType, "application/octet-stream");
      assertEquals(head.metadata["relay-upload-id"], uploadId);
      assertEquals(head.metadata["relay-sha256"], digest);
      assertEquals(head.checksumSha256, hexToBase64(digest));

      const oversizedBytes = new Uint8Array(bytes.byteLength + 1);
      oversizedBytes.set(bytes);
      oversizedBytes[bytes.byteLength] = 0x21;
      const oversizedKey = createImmutableObjectKey({
        artifactId,
        artifactVersionId: "aver_55555555555555555555555555555555",
      });
      const oversizedAuthorization = await storage.createUploadUrl({
        key: oversizedKey,
        uploadId: "upl_55555555555555555555555555555555",
        sizeBytes: bytes.byteLength,
        contentType: "application/octet-stream",
        contentMd5: md5Base64(oversizedBytes),
        sha256Hex: await sha256Hex(oversizedBytes),
        expiresInSeconds: 60,
      });
      const oversizedResponse = await fetch(oversizedAuthorization.url, {
        method: "PUT",
        headers: {
          ...oversizedAuthorization.requiredHeaders,
          "content-length": String(oversizedBytes.byteLength),
        },
        body: body(oversizedBytes),
      });
      assertEquals(oversizedResponse.ok, false);
      assertEquals(await storage.headObject({ key: oversizedKey }), null);

      const downloaded = await storage.createDownloadUrl({
        key,
        expiresInSeconds: 30,
        contentDisposition: "attachment; filename=contract.bin",
      });
      const downloadResponse = await fetch(downloaded.url);
      assertEquals(downloadResponse.ok, true);
      assertEquals(
        new Uint8Array(await downloadResponse.arrayBuffer()),
        bytes,
      );

      const serverBytes = new TextEncoder().encode("server-controlled-output");
      const serverSha256 = await sha256Hex(serverBytes);
      const serverKey = createImmutableObjectKey({
        artifactId,
        artifactVersionId: "aver_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      const serverHead = await storage.putObject({
        key: serverKey,
        body: serverBytes,
        sizeBytes: serverBytes.byteLength,
        contentType: "application/octet-stream",
        contentMd5: md5Base64(serverBytes),
        sha256Hex: serverSha256,
        metadata: {
          "relay-upload-id": "upl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "relay-sha256": serverSha256,
        },
      });
      assertEquals(serverHead.checksumSha256, hexToBase64(serverSha256));
      const serverRead = await storage.getObjectStream({ key: serverKey });
      assertExists(serverRead);
      assertEquals(
        new Uint8Array(await new Response(serverRead.body).arrayBuffer()),
        serverBytes,
      );
      const copySource = await storage.getObjectStream({ key: serverKey });
      assertExists(copySource);
      const copyKey = createImmutableObjectKey({
        artifactId,
        artifactVersionId: "aver_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      });
      await storage.putObject({
        key: copyKey,
        body: copySource.body,
        sizeBytes: serverBytes.byteLength,
        contentType: "application/octet-stream",
        contentMd5: md5Base64(serverBytes),
        sha256Hex: serverSha256,
        metadata: {
          "relay-upload-id": "upl_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "relay-sha256": serverSha256,
        },
      });
      const copied = await storage.getObjectStream({ key: copyKey });
      assertExists(copied);
      assertEquals(
        new Uint8Array(await new Response(copied.body).arrayBuffer()),
        serverBytes,
      );
      await storage.hardDeleteObject({
        key: copyKey,
        storageVersionId: copied.head.storageVersionId ?? undefined,
      });

      await admin.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: serverKey,
        }),
      );
      assertEquals(await storage.headObject({ key: serverKey }), null);
      const hidden = await admin.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: serverKey,
        }),
      );
      assertEquals(
        (hidden.Versions ?? []).some((version) => version.Key === serverKey),
        true,
      );
      assertEquals(
        (hidden.DeleteMarkers ?? []).some((marker) => marker.Key === serverKey),
        true,
      );
      const hardDeleted = await storage.hardDeleteObject({ key: serverKey });
      assertEquals(hardDeleted.deletedVersions >= 1, true);
      assertEquals(hardDeleted.deletedDeleteMarkers >= 1, true);
      const confirmed = await admin.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: serverKey,
        }),
      );
      assertEquals(
        [...(confirmed.Versions ?? []), ...(confirmed.DeleteMarkers ?? [])]
          .some((identity) => identity.Key === serverKey),
        false,
      );

      const changedHeaderKey = createImmutableObjectKey({
        artifactId,
        artifactVersionId: "aver_11111111111111111111111111111111",
      });
      const changedHeaderAuth = await storage.createUploadUrl({
        key: changedHeaderKey,
        uploadId: "upl_11111111111111111111111111111111",
        sizeBytes: bytes.byteLength,
        contentType: "application/octet-stream",
        contentMd5,
        sha256Hex: digest,
        expiresInSeconds: 60,
      });
      const changedHeaders = {
        ...changedHeaderAuth.requiredHeaders,
        "content-type": "text/plain",
      };
      const changedHeaderResponse = await fetch(changedHeaderAuth.url, {
        method: "PUT",
        headers: changedHeaders,
        body: body(bytes),
      });
      assertEquals(changedHeaderResponse.ok, false);

      const missingHeaderKey = createImmutableObjectKey({
        artifactId,
        artifactVersionId: "aver_22222222222222222222222222222222",
      });
      const missingHeaderAuth = await storage.createUploadUrl({
        key: missingHeaderKey,
        uploadId: "upl_22222222222222222222222222222222",
        sizeBytes: bytes.byteLength,
        contentType: "application/octet-stream",
        contentMd5,
        sha256Hex: digest,
        expiresInSeconds: 60,
      });
      const missingHeaders = { ...missingHeaderAuth.requiredHeaders };
      delete missingHeaders["x-amz-checksum-sha256"];
      const missingHeaderResponse = await fetch(missingHeaderAuth.url, {
        method: "PUT",
        headers: missingHeaders,
        body: body(bytes),
      });
      assertEquals(missingHeaderResponse.ok, false);

      const alteredKey = createImmutableObjectKey({
        artifactId,
        artifactVersionId: "aver_33333333333333333333333333333333",
      });
      const alteredAuth = await storage.createUploadUrl({
        key: alteredKey,
        uploadId: "upl_33333333333333333333333333333333",
        sizeBytes: bytes.byteLength,
        contentType: "application/octet-stream",
        contentMd5,
        sha256Hex: digest,
        expiresInSeconds: 60,
      });
      const alteredResponse = await fetch(alteredAuth.url, {
        method: "PUT",
        headers: alteredAuth.requiredHeaders,
        body: body(new TextEncoder().encode("altered bytes")),
      });
      assertEquals(alteredResponse.ok, false);

      const wrongMethod = await fetch(authorization.url, {
        method: "GET",
        headers: authorization.requiredHeaders,
      });
      assertEquals(wrongMethod.ok, false);

      const overwriteAuthorization = await storage.createUploadUrl({
        key,
        uploadId,
        sizeBytes: bytes.byteLength,
        contentType: "application/octet-stream",
        contentMd5,
        sha256Hex: digest,
        expiresInSeconds: 60,
      });
      const overwrite = await fetch(overwriteAuthorization.url, {
        method: "PUT",
        headers: overwriteAuthorization.requiredHeaders,
        body: body(bytes),
      });
      assertEquals(overwrite.status, 412);

      const expiringKey = createImmutableObjectKey({
        artifactId,
        artifactVersionId: "aver_44444444444444444444444444444444",
      });
      const expiring = await storage.createUploadUrl({
        key: expiringKey,
        uploadId: "upl_44444444444444444444444444444444",
        sizeBytes: bytes.byteLength,
        contentType: "application/octet-stream",
        contentMd5,
        sha256Hex: digest,
        expiresInSeconds: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      const expired = await fetch(expiring.url, {
        method: "PUT",
        headers: expiring.requiredHeaders,
        body: body(bytes),
      });
      assertEquals(expired.ok, false);
    } finally {
      storage.close();
      await cleanBucket(admin, bucket);
      admin.destroy();
    }
  },
});
