import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { createS3ObjectStorage } from "./s3.ts";

const credentials = {
  accessKeyId: "explicit-test-key",
  secretAccessKey: "explicit-test-secret",
};
const key =
  "artifacts/art_0123456789abcdef0123456789abcdef/aver_fedcba9876543210fedcba9876543210/0123456789abcdef0123456789abcdef0123456789abcdef";

Deno.test("S3 signing uses the public endpoint and exact required headers", async () => {
  const now = new Date("2026-08-23T00:00:00.000Z");
  const storage = createS3ObjectStorage({
    bucket: "relay-contract",
    region: "us-east-1",
    credentials,
    internalEndpoint: "http://minio.internal:9000",
    publicSigningEndpoint: "https://objects.example.test",
    forcePathStyle: true,
    bucketVersioning: "enabled",
    now: () => now,
  });

  try {
    const authorization = await storage.createUploadUrl({
      key,
      uploadId: "upl_0123456789abcdef0123456789abcdef",
      contentType: "image/png",
      contentMd5: "XUFAKrxLKna5cZ2REBfFkg==",
      sha256Hex:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      expiresInSeconds: 60,
    });

    const url = new URL(authorization.url);
    assertEquals(url.origin, "https://objects.example.test");
    assertEquals(url.pathname, `/relay-contract/${key}`);
    assertStringIncludes(
      url.searchParams.get("X-Amz-Credential") ?? "",
      credentials.accessKeyId,
    );
    assertEquals(
      authorization.expiresAt.toISOString(),
      "2026-08-23T00:01:00.000Z",
    );
    assertEquals(authorization.requiredHeaders, {
      "content-type": "image/png",
      "content-md5": "XUFAKrxLKna5cZ2REBfFkg==",
      "x-amz-checksum-sha256": "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
      "x-amz-meta-relay-upload-id": "upl_0123456789abcdef0123456789abcdef",
      "x-amz-meta-relay-sha256":
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "if-none-match": "*",
    });

    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    for (
      const header of [
        "content-md5",
        "content-type",
        "host",
        "x-amz-checksum-sha256",
        "if-none-match",
        "x-amz-meta-relay-sha256",
        "x-amz-meta-relay-upload-id",
      ]
    ) {
      assertMatch(signedHeaders, new RegExp(`(?:^|;)${header}(?:;|$)`));
    }
    assertEquals(
      authorization.url.includes(credentials.secretAccessKey),
      false,
    );
  } finally {
    storage.close();
  }
});

Deno.test("S3 signing supports virtual-host addressing", async () => {
  const storage = createS3ObjectStorage({
    bucket: "relay-contract",
    region: "auto",
    credentials,
    publicSigningEndpoint: "https://objects.example.test",
    internalEndpoint: "https://objects-internal.example.test",
    forcePathStyle: false,
    bucketVersioning: "disabled",
  });

  try {
    const authorization = await storage.createDownloadUrl({
      key,
      expiresInSeconds: 30,
    });
    const url = new URL(authorization.url);
    assertEquals(url.hostname, "relay-contract.objects.example.test");
    assertEquals(url.pathname, `/${key}`);
  } finally {
    storage.close();
  }
});

Deno.test("download signing caps TTL to an absolute policy deadline", async () => {
  const now = new Date("2026-08-23T00:00:00.000Z");
  const storage = createS3ObjectStorage({
    bucket: "relay-contract",
    region: "us-east-1",
    credentials,
    internalEndpoint: "https://objects.example.test",
    forcePathStyle: true,
    bucketVersioning: "enabled",
    now: () => now,
  });
  try {
    const authorization = await storage.createDownloadUrl({
      key,
      expiresInSeconds: 60,
      notAfter: new Date(now.getTime() + 10_500),
    });
    assertEquals(
      authorization.expiresAt.toISOString(),
      "2026-08-23T00:00:10.000Z",
    );
    assertEquals(
      new URL(authorization.url).searchParams.get("X-Amz-Expires"),
      "10",
    );
  } finally {
    storage.close();
  }
});

Deno.test("S3 signing matches R2 and AWS endpoint profiles", async () => {
  const r2 = createS3ObjectStorage({
    bucket: "relay-contract",
    region: "auto",
    credentials,
    internalEndpoint: "https://account.r2.cloudflarestorage.com",
    publicSigningEndpoint: "https://account.r2.cloudflarestorage.com",
    forcePathStyle: false,
    bucketVersioning: "disabled",
  });
  const aws = createS3ObjectStorage({
    bucket: "relay-contract",
    region: "us-west-2",
    credentials: { ...credentials, sessionToken: "temporary-session-token" },
    forcePathStyle: false,
    bucketVersioning: "enabled",
  });
  try {
    const r2Url = new URL(
      (await r2.createDownloadUrl({
        key,
        expiresInSeconds: 30,
      })).url,
    );
    assertEquals(
      r2Url.hostname,
      "relay-contract.account.r2.cloudflarestorage.com",
    );
    assertStringIncludes(
      r2Url.searchParams.get("X-Amz-Credential") ?? "",
      "/auto/s3/aws4_request",
    );

    const awsUrl = new URL(
      (await aws.createDownloadUrl({
        key,
        expiresInSeconds: 30,
      })).url,
    );
    assertEquals(awsUrl.hostname, "relay-contract.s3.us-west-2.amazonaws.com");
    assertStringIncludes(
      awsUrl.searchParams.get("X-Amz-Credential") ?? "",
      "/us-west-2/s3/aws4_request",
    );
    assertEquals(
      awsUrl.searchParams.get("X-Amz-Security-Token"),
      "temporary-session-token",
    );
  } finally {
    r2.close();
    aws.close();
  }
});

Deno.test("S3 storage rejects non-immutable keys and malformed versions", async () => {
  const storage = createS3ObjectStorage({
    bucket: "relay-contract",
    region: "us-east-1",
    credentials,
    internalEndpoint: "http://127.0.0.1:9000",
    forcePathStyle: true,
    bucketVersioning: "enabled",
  });
  try {
    await assertRejects(
      () =>
        storage.createDownloadUrl({
          key: "user/file.png",
          expiresInSeconds: 30,
        }),
      TypeError,
      "immutable key",
    );
    await assertRejects(
      () =>
        storage.createDownloadUrl({
          key,
          expiresInSeconds: 30,
          storageVersionId: "https://signed.example.test/version",
        }),
      TypeError,
      "storageVersionId",
    );
    await assertRejects(
      () =>
        storage.createUploadUrl({
          key,
          uploadId: "caller-controlled",
          contentType: "image/png",
          contentMd5: "XUFAKrxLKna5cZ2REBfFkg==",
          sha256Hex:
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          expiresInSeconds: 30,
        }),
      TypeError,
      "Relay upload ID",
    );
  } finally {
    storage.close();
  }
});

Deno.test("S3 storage requires literal credentials and safe endpoints", () => {
  assertThrows(
    () =>
      createS3ObjectStorage({
        bucket: "relay-contract",
        region: "us-east-1",
        credentials: { accessKeyId: "", secretAccessKey: "" },
        forcePathStyle: true,
        bucketVersioning: "enabled",
      }),
    TypeError,
    "credentials.accessKeyId",
  );

  assertThrows(
    () =>
      createS3ObjectStorage({
        bucket: "relay-contract",
        region: "us-east-1",
        credentials,
        internalEndpoint: "https://user:password@example.test",
        forcePathStyle: true,
        bucketVersioning: "enabled",
      }),
    TypeError,
    "must not contain credentials",
  );
});
