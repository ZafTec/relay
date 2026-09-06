import {
  GetBucketVersioningCommand,
  HeadBucketCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { checkS3StorageHealth, createS3ObjectStorage } from "./s3.ts";

const credentials = {
  accessKeyId: "explicit-test-key",
  secretAccessKey: "explicit-test-secret",
};
const key =
  "artifacts/art_0123456789abcdef0123456789abcdef/aver_fedcba9876543210fedcba9876543210/0123456789abcdef0123456789abcdef0123456789abcdef";

function mockedS3Client(
  send: (command: unknown) => Promise<unknown>,
): Pick<S3Client, "send"> {
  return { send } as unknown as Pick<S3Client, "send">;
}

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
    requestTimeoutMs: 1_000,
    now: () => now,
  });

  try {
    const authorization = await storage.createUploadUrl({
      key,
      uploadId: "upl_0123456789abcdef0123456789abcdef",
      sizeBytes: 5,
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
      "content-length": "5",
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
        "content-length",
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

Deno.test("S3 readiness is read-only and requires Enabled versioning", async () => {
  const commands: unknown[] = [];
  const readiness = await checkS3StorageHealth(
    mockedS3Client((command) => {
      commands.push(command);
      if (command instanceof HeadBucketCommand) return Promise.resolve({});
      if (command instanceof GetBucketVersioningCommand) {
        return Promise.resolve({ Status: "Enabled" });
      }
      return Promise.reject(new Error("unexpected S3 command"));
    }),
    "relay-contract",
  );

  assertEquals(readiness, { name: "storage", status: "ok" });
  assertEquals(commands.length, 2);
  assertEquals(commands[0] instanceof HeadBucketCommand, true);
  assertEquals(commands[1] instanceof GetBucketVersioningCommand, true);
  assertEquals((commands[0] as HeadBucketCommand).input, {
    Bucket: "relay-contract",
  });
  assertEquals((commands[1] as GetBucketVersioningCommand).input, {
    Bucket: "relay-contract",
  });
});

Deno.test("S3 readiness rejects disabled and suspended versioning", async () => {
  for (const status of [undefined, "Suspended"] as const) {
    const readiness = await checkS3StorageHealth(
      mockedS3Client((command) => {
        if (command instanceof HeadBucketCommand) return Promise.resolve({});
        return Promise.resolve(status === undefined ? {} : { Status: status });
      }),
      "relay-contract",
    );
    assertEquals(readiness, {
      name: "storage",
      status: "error",
      message: "bucket versioning must be enabled",
    });
  }
});

Deno.test("S3 readiness sanitizes bucket and versioning errors", async () => {
  const sensitive = "https://access:secret@private.example.test/bucket";
  for (const name of ["NoSuchBucket", "InvalidAccessKeyId"]) {
    const readiness = await checkS3StorageHealth(
      mockedS3Client(() =>
        Promise.reject(Object.assign(new Error(sensitive), { name }))
      ),
      "relay-contract",
    );
    assertEquals(readiness, {
      name: "storage",
      status: "error",
      message: "bucket is unavailable",
    });
    assertEquals(JSON.stringify(readiness).includes(sensitive), false);
  }

  const versioning = await checkS3StorageHealth(
    mockedS3Client((command) =>
      command instanceof HeadBucketCommand
        ? Promise.resolve({})
        : Promise.reject(new Error(sensitive))
    ),
    "relay-contract",
  );
  assertEquals(versioning, {
    name: "storage",
    status: "error",
    message: "unable to verify bucket versioning",
  });
  assertEquals(JSON.stringify(versioning).includes(sensitive), false);
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
          sizeBytes: 5,
          contentType: "image/png",
          contentMd5: "XUFAKrxLKna5cZ2REBfFkg==",
          sha256Hex:
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          expiresInSeconds: 30,
        }),
      TypeError,
      "Relay upload ID",
    );
    await assertRejects(
      () =>
        storage.createUploadUrl({
          key,
          uploadId: "upl_0123456789abcdef0123456789abcdef",
          sizeBytes: -1,
          contentType: "image/png",
          contentMd5: "XUFAKrxLKna5cZ2REBfFkg==",
          sha256Hex:
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          expiresInSeconds: 30,
        }),
      RangeError,
      "sizeBytes",
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

  assertThrows(
    () =>
      createS3ObjectStorage({
        bucket: "relay-contract",
        region: "us-east-1",
        credentials,
        forcePathStyle: true,
        bucketVersioning: "enabled",
        requestTimeoutMs: 0,
      }),
    RangeError,
    "requestTimeoutMs",
  );
});
