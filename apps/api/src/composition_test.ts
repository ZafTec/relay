import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import type {
  ApiS3Config,
  ArtifactLifecycleConfig,
  RuntimeConfig,
  ShareTokenKeyringConfig,
} from "@relay/config";
import type { DatabasePool } from "@relay/database";
import type { S3CompatibleStorage } from "@relay/storage";
import {
  createGlobalArtifactStorageLimitProvider,
  createMvpApiHandlerRegistry,
  startMvpApi,
} from "./composition.ts";
import type { ApiRuntimeOptions, ApiShutdownCallback } from "./server.ts";

const RUNTIME_CONFIG: RuntimeConfig = {
  appName: "Relay API Test",
  deploymentEnvironment: "test",
  port: 8_000,
  build: { version: "test", revision: "test" },
  database: {
    url: new URL("postgres://relay:test@localhost:5432/relay"),
    poolMax: 2,
    connectTimeoutMs: 100,
    statementTimeoutMs: 100,
  },
  redis: {
    url: new URL("redis://localhost:6379"),
    connectTimeoutMs: 100,
  },
};

const S3_CONFIG: ApiS3Config = {
  bucket: "relay-artifacts",
  region: "us-east-1",
  credentials: {
    accessKeyId: "storage-access",
    secretAccessKey: "storage-secret",
  },
  internalEndpoint: new URL("http://minio.internal:9000"),
  publicSigningEndpoint: new URL("https://objects.relay.test"),
  forcePathStyle: true,
  bucketVersioning: "enabled",
  requestTimeoutMs: 1_000,
};

const LIFECYCLE: ArtifactLifecycleConfig = {
  workspaceMaxBytes: 1_000_000,
  maxUploadBytes: 100_000,
  uploadTtlSeconds: 120,
  downloadTtlSeconds: 60,
  purgeDelaySeconds: 3_600,
  cleanupLeaseSeconds: 30,
  maintenanceIntervalMs: 5_000,
  maintenanceBatchSize: 25,
};

const KEYRING: ShareTokenKeyringConfig = {
  activeVersion: 1,
  keys: [{ version: 1, secret: new Uint8Array(32).fill(7) }],
};

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

function fakeServer(): Deno.HttpServer {
  return {
    finished: Promise.resolve(),
    addr: { transport: "tcp", hostname: "127.0.0.1", port: 8_000 },
    ref() {},
    unref() {},
    shutdown: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  } as Deno.HttpServer;
}

Deno.test("MVP API registers exact handlers and never loads Azure config", async () => {
  const calls: string[] = [];
  let forbiddenLoaderCalls = 0;
  const forbiddenDependencies = {
    loadWorkerAzureProviderConfig() {
      forbiddenLoaderCalls += 1;
      throw new Error("API must not load AZURE_API_KEY");
    },
  };
  let storageCloseCount = 0;
  let storageHealthCount = 0;
  let userReadinessCount = 0;
  let capturedOptions: ApiRuntimeOptions | undefined;
  const pool = {} as DatabasePool;
  const storage = {
    checkHealth() {
      storageHealthCount += 1;
      return Promise.resolve({ name: "storage", status: "ok" as const });
    },
    close() {
      storageCloseCount += 1;
    },
  } as unknown as S3CompatibleStorage;
  const server = fakeServer();

  const result = await startMvpApi(
    {
      additionalReadinessChecks: [() => {
        userReadinessCount += 1;
        return Promise.resolve({ name: "custom", status: "ok" });
      }],
    },
    {
      ...forbiddenDependencies,
      loadRuntimeConfig() {
        calls.push("runtime");
        return RUNTIME_CONFIG;
      },
      loadApiS3Config() {
        calls.push("api-s3");
        return S3_CONFIG;
      },
      loadArtifactLifecycleConfig() {
        calls.push("artifact-lifecycle");
        return LIFECYCLE;
      },
      loadApiShareTokenKeyringConfig() {
        calls.push("api-share-keyring");
        return KEYRING;
      },
      createS3ObjectStorage(config) {
        calls.push("api-storage");
        assertStrictEquals(config, S3_CONFIG);
        return storage;
      },
      async startApi(config, options) {
        calls.push("api-runtime");
        assertStrictEquals(config, RUNTIME_CONFIG);
        assertExists(options);
        capturedOptions = options;
        assertExists(options.applicationServicesFactory);
        const services = options.applicationServicesFactory(pool);
        assertExists(services);
        assertEquals(
          await services.artifacts.createUpload(
            { workspaceId: "workspace", actorUserId: "user" },
            {
              target: {
                kind: "new_artifact",
                name: "Oversized artifact",
                mediaKind: "document",
              },
              sizeBytes: LIFECYCLE.maxUploadBytes + 1,
              mimeType: "text/plain",
              sha256:
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
              contentMd5: "XUFAKrxLKna5cZ2REBfFkg==",
            },
            "oversized-upload",
          ),
          { kind: "quota_exceeded" },
        );
        return server;
      },
    },
  );

  assertStrictEquals(result, server);
  assertEquals(forbiddenLoaderCalls, 0);
  assertEquals(calls, [
    "runtime",
    "api-s3",
    "artifact-lifecycle",
    "api-share-keyring",
    "api-storage",
    "api-runtime",
  ]);
  assertEquals([...createMvpApiHandlerRegistry().keys], [
    "image.edit.azure-openai.gpt-image-2.v1",
    "image.edit.azure-flux.flux-2-pro.v1",
    "image.generate.azure-mai.mai-image-2.5.v1",
    "image.edit.azure-mai.mai-image-2.5.v1",
    "image.generate.azure-mai.mai-image-2.5-flash.v1",
    "image.edit.azure-mai.mai-image-2.5-flash.v1",
    "image.generate.azure-openai.gpt-image-2.v1",
    "image.generate.azure-flux.flux-2-pro.v1",
    "document.ocr.azure-mistral.v1",
  ]);

  assertEquals(capturedOptions?.additionalReadinessChecks?.length, 3);
  await capturedOptions?.additionalReadinessChecks?.[0](pool);
  assertEquals(
    await capturedOptions?.additionalReadinessChecks?.[1](pool),
    { name: "storage", status: "ok" },
  );
  assertEquals(userReadinessCount, 1);
  assertEquals(storageHealthCount, 1);

  const closeStorage = capturedOptions?.shutdownCallbacks?.[0];
  assertExists(closeStorage);
  await closeStorage(pool);
  await closeStorage(pool);
  assertEquals(storageCloseCount, 1);
});

Deno.test("MVP API quota uses the explicit global workspace limit", async () => {
  const provider = createGlobalArtifactStorageLimitProvider(987_654);
  assertEquals(
    await provider.getLimit({} as never, { workspaceId: "workspace-1" }),
    { kind: "limited", maxBytes: "987654" },
  );
});

Deno.test("MVP API fails before resources when required config is missing", async () => {
  let storageCreated = false;
  let apiStarted = false;

  await assertRejects(
    () =>
      startMvpApi({}, {
        loadRuntimeConfig: () => RUNTIME_CONFIG,
        loadApiS3Config: () => S3_CONFIG,
        loadArtifactLifecycleConfig: () => LIFECYCLE,
        loadApiShareTokenKeyringConfig() {
          throw new Error("SHARE_TOKEN_KEYS is required");
        },
        createS3ObjectStorage() {
          storageCreated = true;
          return {} as S3CompatibleStorage;
        },
        startApi() {
          apiStarted = true;
          return Promise.resolve(fakeServer());
        },
      }),
    Error,
    "SHARE_TOKEN_KEYS",
  );
  assertEquals(storageCreated, false);
  assertEquals(apiStarted, false);
});

Deno.test("MVP API awaits one storage close when API startup fails", async () => {
  const startupFailure = new Error("API startup failed");
  const storageCloseStarted = deferred();
  const allowStorageClose = deferred();
  const pool = {} as DatabasePool;
  let storageCloseCount = 0;
  let closeStorage: ApiShutdownCallback | undefined;
  const storage = {
    checkHealth: () =>
      Promise.resolve({ name: "storage", status: "ok" as const }),
    close() {
      storageCloseCount += 1;
      storageCloseStarted.resolve();
      return allowStorageClose.promise;
    },
  } as unknown as S3CompatibleStorage;

  const startup = startMvpApi({}, {
    loadRuntimeConfig: () => RUNTIME_CONFIG,
    loadApiS3Config: () => S3_CONFIG,
    loadArtifactLifecycleConfig: () => LIFECYCLE,
    loadApiShareTokenKeyringConfig: () => KEYRING,
    createS3ObjectStorage: () => storage,
    startApi(_config, options) {
      assertExists(options);
      closeStorage = options.shutdownCallbacks?.[0];
      assertExists(closeStorage);
      void closeStorage(pool);
      return Promise.reject(startupFailure);
    },
  });
  let settled = false;
  void startup.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await storageCloseStarted.promise;
  await Promise.resolve();
  assertEquals(settled, false);
  assertEquals(storageCloseCount, 1);

  allowStorageClose.resolve();
  const rejection = await startup.then(
    () => undefined,
    (error) => error,
  );

  assertStrictEquals(rejection, startupFailure);
  assertExists(closeStorage);
  await closeStorage(pool);
  assertEquals(storageCloseCount, 1);
});
