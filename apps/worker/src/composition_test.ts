import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import type { ArtifactService } from "@relay/artifacts";
import type {
  ArtifactLifecycleConfig,
  AzureProviderConfig,
  RuntimeConfig,
  S3Config,
} from "@relay/config";
import type { DatabasePool } from "@relay/database";
import type { S3CompatibleStorage } from "@relay/storage";
import type { AzureProviderClientOptions } from "@relay/providers";
import type { ArtifactMaintenanceOptions } from "./artifact-maintenance.ts";
import {
  type MvpWorkerCompositionDependencies,
  startMvpWorker,
} from "./composition.ts";
import {
  FLUX_2_PRO_HANDLER_KEY,
  GPT_IMAGE_2_HANDLER_KEY,
  MISTRAL_OCR_HANDLER_KEY,
} from "./mvp-handlers.ts";
import type { WorkerRuntimeOptions } from "./worker.ts";

const RUNTIME_CONFIG: RuntimeConfig = {
  appName: "Relay Worker Test",
  port: 8_000,
  deploymentEnvironment: "worker-test",
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

const S3_CONFIG: S3Config = {
  bucket: "relay-artifacts",
  region: "us-east-1",
  credentials: {
    accessKeyId: "storage-access",
    secretAccessKey: "storage-secret",
  },
  internalEndpoint: new URL("http://minio.internal:9000"),
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

const AZURE_CONFIG: AzureProviderConfig = {
  gptImage2: {
    baseUrl: "https://images-resource.services.ai.azure.com",
    apiKey: "image-test-secret",
  },
  flux2Pro: {
    baseUrl: "https://flux-resource.services.ai.azure.com",
    apiKey: "flux-test-secret",
  },
  mistralOcr: {
    baseUrl: "https://ocr-resource.services.ai.azure.com",
    apiKey: "ocr-test-secret",
  },
  timeoutMs: 1_000,
  maxResponseBytes: 2_000_000,
  maxBase64Bytes: 1_000_000,
};

async function captureComposedWorkerEnvironment(
  runtimeOptions: Parameters<typeof startMvpWorker>[0],
  resources = new Map<string, AzureProviderClientOptions>(),
): Promise<string | undefined> {
  const pool = {
    end: () => Promise.resolve(),
  } as unknown as DatabasePool;
  const storage = {
    close() {},
  } as unknown as S3CompatibleStorage;
  const createProviderClient =
    (() => ({})) as unknown as MvpWorkerCompositionDependencies[
      "createAzureGptImage2Client"
    ];
  const createMaintenanceLoop = (() => ({
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  })) as unknown as MvpWorkerCompositionDependencies[
    "createArtifactMaintenanceLoop"
  ];
  let environment: string | undefined;

  await startMvpWorker(runtimeOptions, {
    loadRuntimeConfig: () => RUNTIME_CONFIG,
    loadWorkerS3Config: () => S3_CONFIG,
    loadArtifactLifecycleConfig: () => LIFECYCLE,
    loadWorkerAzureProviderConfig: () => AZURE_CONFIG,
    createDatabasePool: () => pool,
    createS3ObjectStorage: () => storage,
    createAzureGptImage2Client(options) {
      resources.set("gptImage2", options);
      return createProviderClient(options);
    },
    createAzureFlux2ProClient: ((options: AzureProviderClientOptions) => {
      resources.set("flux2Pro", options);
      return createProviderClient(options);
    }) as unknown as MvpWorkerCompositionDependencies[
      "createAzureFlux2ProClient"
    ],
    createAzureMistralOcrClient: ((options: AzureProviderClientOptions) => {
      resources.set("mistralOcr", options);
      return createProviderClient(options);
    }) as unknown as MvpWorkerCompositionDependencies[
      "createAzureMistralOcrClient"
    ],
    createArtifactMaintenanceLoop: createMaintenanceLoop,
    startWorker(_config, options) {
      environment = options?.environment;
      return Promise.resolve();
    },
  });

  return environment;
}

Deno.test("MVP worker forwards its deployment environment unless overridden", async () => {
  assertEquals(await captureComposedWorkerEnvironment({}), "worker-test");
  assertEquals(
    await captureComposedWorkerEnvironment({ environment: "runtime-override" }),
    "runtime-override",
  );
});

Deno.test("MVP worker wires each model to its own resource and credential pair", async () => {
  const resources = new Map<string, AzureProviderClientOptions>();
  await captureComposedWorkerEnvironment({}, resources);
  for (const name of ["gptImage2", "flux2Pro", "mistralOcr"] as const) {
    const options = resources.get(name);
    assertExists(options);
    assertEquals(options.baseUrl, AZURE_CONFIG[name].baseUrl);
    assertEquals(options.apiKey, AZURE_CONFIG[name].apiKey);
    assertEquals(options.timeoutMs, AZURE_CONFIG.timeoutMs);
  }
});

Deno.test("MVP worker composes without loading API-only secrets", async () => {
  const calls: string[] = [];
  let forbiddenLoaderCalls = 0;
  const forbiddenDependencies = {
    loadAuthConfig() {
      forbiddenLoaderCalls += 1;
      throw new Error("Worker must not load OAuth secrets");
    },
    loadApiShareTokenKeyringConfig() {
      forbiddenLoaderCalls += 1;
      throw new Error("Worker must not load share-token secrets");
    },
  };
  let poolCloseCount = 0;
  let storageCloseCount = 0;
  let storageHealthCount = 0;
  let providerCanaryCount = 0;
  let maintenanceStartCount = 0;
  let maintenanceStopCount = 0;
  let maintenanceOptions: ArtifactMaintenanceOptions | undefined;
  let capturedArtifactService: ArtifactService | undefined;
  let capturedWorkerOptions: WorkerRuntimeOptions | undefined;
  const pool = {
    end() {
      poolCloseCount += 1;
      return Promise.resolve();
    },
  } as unknown as DatabasePool;
  const storage = {
    checkHealth() {
      storageHealthCount += 1;
      return Promise.resolve({ name: "storage", status: "ok" as const });
    },
    close() {
      storageCloseCount += 1;
    },
  } as unknown as S3CompatibleStorage;
  const maintenance = {
    start() {
      maintenanceStartCount += 1;
      return Promise.resolve();
    },
    stop() {
      maintenanceStopCount += 1;
      return Promise.resolve();
    },
  };
  const createGpt = (() => ({
    generate() {
      providerCanaryCount += 1;
      return Promise.reject(new Error("provider canary must not run"));
    },
  })) as unknown as MvpWorkerCompositionDependencies[
    "createAzureGptImage2Client"
  ];
  const createFlux = (() => ({
    generate() {
      providerCanaryCount += 1;
      return Promise.reject(new Error("provider canary must not run"));
    },
  })) as unknown as MvpWorkerCompositionDependencies[
    "createAzureFlux2ProClient"
  ];
  const createOcr = (() => ({
    process() {
      providerCanaryCount += 1;
      return Promise.reject(new Error("provider canary must not run"));
    },
  })) as unknown as MvpWorkerCompositionDependencies[
    "createAzureMistralOcrClient"
  ];

  await startMvpWorker(
    { artifactMaintenanceConcurrency: 7 },
    {
      ...forbiddenDependencies,
      loadRuntimeConfig() {
        calls.push("runtime");
        return RUNTIME_CONFIG;
      },
      loadWorkerS3Config() {
        calls.push("worker-s3");
        return S3_CONFIG;
      },
      loadArtifactLifecycleConfig() {
        calls.push("artifact-lifecycle");
        return LIFECYCLE;
      },
      loadWorkerAzureProviderConfig() {
        calls.push("worker-azure");
        return AZURE_CONFIG;
      },
      createDatabasePool(config, processName) {
        calls.push("worker-pool");
        assertStrictEquals(config, RUNTIME_CONFIG.database);
        assertEquals(processName, "relay-worker");
        return pool;
      },
      createS3ObjectStorage(config) {
        calls.push("worker-storage");
        assertStrictEquals(config, S3_CONFIG);
        return storage;
      },
      createAzureGptImage2Client: createGpt,
      createAzureFlux2ProClient: createFlux,
      createAzureMistralOcrClient: createOcr,
      createArtifactMaintenanceLoop(service, options) {
        calls.push("artifact-maintenance");
        capturedArtifactService = service as ArtifactService;
        maintenanceOptions = options;
        return maintenance as never;
      },
      async startWorker(config, options) {
        calls.push("worker-runtime");
        assertStrictEquals(config, RUNTIME_CONFIG);
        assertExists(options);
        assertStrictEquals(options.pool, pool);
        capturedWorkerOptions = options;
        assertExists(capturedArtifactService);
        assertEquals(
          await capturedArtifactService.beginDirectUpload({
            workspaceId: "workspace",
            actorUserId: "user",
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
          }),
          { kind: "quota_exceeded" },
        );
        assertEquals([...options.handlerRegistry!.keys], [
          GPT_IMAGE_2_HANDLER_KEY,
          FLUX_2_PRO_HANDLER_KEY,
          MISTRAL_OCR_HANDLER_KEY,
          "image.edit.azure-flux.flux-2-pro.v1",
          "image.generate.azure-mai.mai-image-2.5.v1",
          "image.edit.azure-mai.mai-image-2.5.v1",
          "image.generate.azure-mai.mai-image-2.5-flash.v1",
          "image.edit.azure-mai.mai-image-2.5-flash.v1",
        ]);
        assertExists(options.artifactMaintenance);
        await options.artifactMaintenance.start();
        await options.artifactMaintenance.stop();
        assertEquals(
          await options.additionalReadinessChecks?.[0](pool),
          { name: "storage", status: "ok" },
        );
      },
    },
  );

  assertEquals(forbiddenLoaderCalls, 0);
  assertEquals(calls, [
    "runtime",
    "worker-s3",
    "artifact-lifecycle",
    "worker-azure",
    "worker-pool",
    "worker-storage",
    "artifact-maintenance",
    "worker-runtime",
  ]);
  assertEquals(capturedWorkerOptions?.additionalReadinessChecks?.length, 2);
  assertEquals(maintenanceOptions?.intervalMs, 5_000);
  assertEquals(maintenanceOptions?.batchSize, 25);
  assertEquals(maintenanceOptions?.concurrency, 7);
  assertExists(maintenanceOptions?.log);
  assertEquals(maintenanceStartCount, 1);
  assertEquals(maintenanceStopCount, 1);
  assertEquals(storageHealthCount, 1);
  assertEquals(providerCanaryCount, 0);
  assertEquals(storageCloseCount, 1);
  assertEquals(poolCloseCount, 1);
});

Deno.test("MVP worker fails before resources when worker-only config is missing", async () => {
  let poolCreated = false;
  let storageCreated = false;

  await assertRejects(
    () =>
      startMvpWorker({}, {
        loadRuntimeConfig: () => RUNTIME_CONFIG,
        loadWorkerS3Config: () => S3_CONFIG,
        loadArtifactLifecycleConfig: () => LIFECYCLE,
        loadWorkerAzureProviderConfig() {
          throw new Error("AZURE_IMAGE_API_KEY is required");
        },
        createDatabasePool() {
          poolCreated = true;
          return {} as DatabasePool;
        },
        createS3ObjectStorage() {
          storageCreated = true;
          return {} as S3CompatibleStorage;
        },
      }),
    Error,
    "AZURE_IMAGE_API_KEY",
  );
  assertEquals(poolCreated, false);
  assertEquals(storageCreated, false);
});

Deno.test("MVP worker closes its pool when storage construction fails", async () => {
  let poolCloseCount = 0;
  const pool = {
    end() {
      poolCloseCount += 1;
      return Promise.resolve();
    },
  } as unknown as DatabasePool;

  await assertRejects(
    () =>
      startMvpWorker({}, {
        loadRuntimeConfig: () => RUNTIME_CONFIG,
        loadWorkerS3Config: () => S3_CONFIG,
        loadArtifactLifecycleConfig: () => LIFECYCLE,
        loadWorkerAzureProviderConfig: () => AZURE_CONFIG,
        createDatabasePool: () => pool,
        createS3ObjectStorage() {
          throw new Error("injected storage construction failure");
        },
      }),
    Error,
    "injected storage construction failure",
  );

  assertEquals(poolCloseCount, 1);
});

Deno.test("MVP worker continues cleanup after a disposer fails", async () => {
  let storageCloseCount = 0;
  let poolCloseCount = 0;
  const pool = {
    end() {
      poolCloseCount += 1;
      return Promise.resolve();
    },
  } as unknown as DatabasePool;
  const storage = {
    close() {
      storageCloseCount += 1;
      throw new Error("injected storage close failure");
    },
  } as unknown as S3CompatibleStorage;

  await assertRejects(
    () =>
      startMvpWorker({}, {
        loadRuntimeConfig: () => RUNTIME_CONFIG,
        loadWorkerS3Config: () => S3_CONFIG,
        loadArtifactLifecycleConfig: () => LIFECYCLE,
        loadWorkerAzureProviderConfig: () => AZURE_CONFIG,
        createDatabasePool: () => pool,
        createS3ObjectStorage: () => storage,
        createAzureGptImage2Client() {
          throw new Error("injected provider construction failure");
        },
      }),
    AggregateError,
    "MVP worker failed and resource cleanup failed",
  );

  assertEquals(storageCloseCount, 1);
  assertEquals(poolCloseCount, 1);
});
