import { assertEquals, assertThrows } from "@std/assert";
import {
  loadApiS3Config,
  loadApiShareTokenKeyringConfig,
  loadArtifactLifecycleConfig,
  loadAuthConfig,
  loadBuildInfo,
  loadDatabaseConfig,
  loadEnabledObservabilityConfig,
  loadRuntimeConfig,
  loadS3Config,
  loadWorkerAzureProviderConfig,
  loadWorkerS3Config,
} from "./index.ts";

const validDatabaseEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/relay",
  REDIS_URL: "redis://:secret@localhost:6379",
};

const validObservabilityEnv = {
  OTEL_DENO: "true",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://alloy:4318",
  OTEL_SERVICE_NAME: "relay-api",
  OTEL_RESOURCE_ATTRIBUTES:
    "service.namespace=relay,deployment.environment.name=production,service.version=1.2.3,relay.build.revision=5a37000,service.instance.id=550e8400-e29b-41d4-a716-446655440000",
  OTEL_PROPAGATORS: "tracecontext",
  OTEL_DENO_CONSOLE: "capture",
  OTEL_METRIC_EXPORT_INTERVAL: "15000",
  OTEL_TRACES_SAMPLER: "always_on",
};

const validAuthEnv = {
  BETTER_AUTH_URL: "https://relay.zaftech.co",
  BETTER_AUTH_SECRET: "a".repeat(32),
  AUTH_TRUSTED_ORIGINS: "https://relay.zaftech.co, https://staging.example.com",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GITHUB_CLIENT_ID: "github-id",
  GITHUB_CLIENT_SECRET: "github-secret",
};

function withStubbedProcessEnvironment<T>(
  environment: Record<string, string | undefined>,
  callback: (reads: readonly string[]) => T,
): T {
  const originalGet = Deno.env.get;
  const originalToObject = Deno.env.toObject;
  const reads: string[] = [];
  Deno.env.get = (name) => {
    reads.push(name);
    return environment[name];
  };
  Deno.env.toObject = () => {
    throw new Error("loaders must not enumerate the process environment");
  };
  try {
    return callback(reads);
  } finally {
    Deno.env.get = originalGet;
    Deno.env.toObject = originalToObject;
  }
}

Deno.test("observability validation is optional when native OTel is disabled", () => {
  assertEquals(loadEnabledObservabilityConfig({}), null);
  assertEquals(loadEnabledObservabilityConfig({ OTEL_DENO: "false" }), null);
});

Deno.test("enabled native OTel configuration is validated at application startup", () => {
  assertEquals(
    loadEnabledObservabilityConfig(validObservabilityEnv)?.serviceName,
    "relay-api",
  );
  assertThrows(
    () =>
      loadEnabledObservabilityConfig({
        ...validObservabilityEnv,
        OTEL_PROPAGATORS: "tracecontext,baggage",
      }),
    Error,
    "tracecontext",
  );
});

Deno.test("loadRuntimeConfig requires DATABASE_URL", () => {
  assertThrows(
    () => loadRuntimeConfig({}),
    Error,
    "DATABASE_URL is required",
  );
});

Deno.test("loadRuntimeConfig rejects a non-postgres DATABASE_URL scheme", () => {
  assertThrows(
    () => loadRuntimeConfig({ DATABASE_URL: "mysql://user:pass@localhost/db" }),
    Error,
    "postgres",
  );
});

Deno.test("loadRuntimeConfig never echoes DATABASE_URL contents in an error", () => {
  try {
    loadRuntimeConfig({ DATABASE_URL: "not a valid url" });
    throw new Error("expected loadRuntimeConfig to throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assertEquals(message.includes("not a valid url"), false);
  }
});

Deno.test("loadRuntimeConfig accepts valid dependencies and applies defaults", () => {
  const config = loadRuntimeConfig(validDatabaseEnv);
  assertEquals(config.appName, "Relay");
  assertEquals(config.port, 8_000);
  assertEquals(config.deploymentEnvironment, "development");
  assertEquals(config.build, { version: "development", revision: "unknown" });
  assertEquals(config.database.url.toString(), validDatabaseEnv.DATABASE_URL);
  assertEquals(config.database.poolMax, 10);
  assertEquals(config.redis.url.toString(), validDatabaseEnv.REDIS_URL);
});

Deno.test("loadRuntimeConfig uses safe deployment environment defaults", () => {
  assertEquals(
    loadRuntimeConfig({ ...validDatabaseEnv, APP_ENV: "development" })
      .deploymentEnvironment,
    "development",
  );
  assertEquals(
    loadRuntimeConfig({ ...validDatabaseEnv, APP_ENV: "test" })
      .deploymentEnvironment,
    "test",
  );
});

Deno.test("loadRuntimeConfig requires a deployment name in production", () => {
  assertThrows(
    () => loadRuntimeConfig({ ...validDatabaseEnv, APP_ENV: "production" }),
    Error,
    "DEPLOYMENT_ENVIRONMENT_NAME is required in production",
  );
  assertEquals(
    loadRuntimeConfig({
      ...validDatabaseEnv,
      APP_ENV: "production",
      DEPLOYMENT_ENVIRONMENT_NAME: "prod_us-east-1",
    }).deploymentEnvironment,
    "prod_us-east-1",
  );
});

Deno.test("loadRuntimeConfig validates deployment environment names", () => {
  for (
    const value of ["Production", "prod.us", "1production", "a".repeat(33)]
  ) {
    assertThrows(
      () =>
        loadRuntimeConfig({
          ...validDatabaseEnv,
          APP_ENV: "test",
          DEPLOYMENT_ENVIRONMENT_NAME: value,
        }),
      Error,
      "DEPLOYMENT_ENVIRONMENT_NAME",
    );
  }
  assertThrows(
    () => loadRuntimeConfig({ ...validDatabaseEnv, APP_ENV: "staging" }),
    Error,
    "APP_ENV",
  );
});

Deno.test("loadRuntimeConfig rejects an out-of-range DATABASE_POOL_MAX", () => {
  assertThrows(
    () => loadRuntimeConfig({ ...validDatabaseEnv, DATABASE_POOL_MAX: "0" }),
    Error,
    "DATABASE_POOL_MAX",
  );
});

Deno.test("loadRuntimeConfig requires REDIS_URL", () => {
  const { REDIS_URL: _drop, ...missing } = validDatabaseEnv;
  assertThrows(
    () => loadRuntimeConfig(missing),
    Error,
    "REDIS_URL is required",
  );
});

Deno.test("loadRuntimeConfig rejects a non-redis REDIS_URL scheme", () => {
  assertThrows(
    () =>
      loadRuntimeConfig({
        ...validDatabaseEnv,
        REDIS_URL: "http://localhost:6379",
      }),
    Error,
    "redis://",
  );
});

Deno.test("loadRuntimeConfig accepts a valid REDIS_URL", () => {
  const config = loadRuntimeConfig(validDatabaseEnv);
  assertEquals(config.redis.url.toString(), validDatabaseEnv.REDIS_URL);
});

Deno.test("loadDatabaseConfig does not require REDIS_URL", () => {
  const { REDIS_URL: _drop, ...databaseOnly } = validDatabaseEnv;
  const config = loadDatabaseConfig(databaseOnly);
  assertEquals(config.url.toString(), validDatabaseEnv.DATABASE_URL);
});

Deno.test("loadDatabaseConfig still requires DATABASE_URL", () => {
  assertThrows(
    () => loadDatabaseConfig({}),
    Error,
    "DATABASE_URL is required",
  );
});

Deno.test("loadBuildInfo defaults version/revision when unset", () => {
  const info = loadBuildInfo({});
  assertEquals(info.version, "development");
  assertEquals(info.revision, "unknown");
});

Deno.test("loadBuildInfo reads APP_VERSION/GIT_SHA when set", () => {
  const info = loadBuildInfo({ APP_VERSION: "1.2.3", GIT_SHA: "abc123" });
  assertEquals(info.version, "1.2.3");
  assertEquals(info.revision, "abc123");
});

Deno.test("loadAuthConfig requires BETTER_AUTH_SECRET to be at least 32 characters", () => {
  assertThrows(
    () => loadAuthConfig({ ...validAuthEnv, BETTER_AUTH_SECRET: "too-short" }),
    Error,
    "32 characters",
  );
});

Deno.test("loadAuthConfig requires every OAuth provider credential", () => {
  const { GOOGLE_CLIENT_SECRET: _drop, ...missingGoogleSecret } = validAuthEnv;
  assertThrows(
    () => loadAuthConfig(missingGoogleSecret),
    Error,
    "GOOGLE_CLIENT_SECRET",
  );
});

Deno.test("loadAuthConfig requires AUTH_TRUSTED_ORIGINS", () => {
  const { AUTH_TRUSTED_ORIGINS: _drop, ...missing } = validAuthEnv;
  assertThrows(
    () => loadAuthConfig(missing),
    Error,
    "AUTH_TRUSTED_ORIGINS",
  );
});

Deno.test("loadAuthConfig splits and trims comma-separated trusted origins", () => {
  const config = loadAuthConfig(validAuthEnv);
  assertEquals(config.trustedOrigins, [
    "https://relay.zaftech.co",
    "https://staging.example.com",
  ]);
});

Deno.test("loadAuthConfig accepts a fully valid environment", () => {
  const config = loadAuthConfig(validAuthEnv);
  assertEquals(config.baseUrl.toString(), "https://relay.zaftech.co/");
  assertEquals(config.google.clientId, "google-id");
  assertEquals(config.github.clientId, "github-id");
});

const validS3Env = {
  S3_ENDPOINT: "http://minio.internal:9000",
  S3_PUBLIC_ENDPOINT: "https://objects.example.test",
  S3_BUCKET: "relay-artifacts",
  S3_ACCESS_KEY_ID: "storage-access-key",
  S3_SECRET_ACCESS_KEY: "storage-secret-key",
};

function thrownMessage(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected callback to throw");
}

function encodeBase64(bytes: Uint8Array, urlSafe = false): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  return urlSafe
    ? encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
    : encoded;
}

Deno.test("API config defaults never read worker-only Azure secrets", () => {
  const secret = encodeBase64(new Uint8Array(32).fill(7));
  withStubbedProcessEnvironment(
    {
      ...validDatabaseEnv,
      ...validAuthEnv,
      ...validS3Env,
      APP_ENV: "test",
      ARTIFACT_WORKSPACE_MAX_BYTES: "1000000",
      SHARE_TOKEN_ACTIVE_VERSION: "1",
      SHARE_TOKEN_KEYS: JSON.stringify({ 1: secret }),
      OTEL_DENO: "false",
      AZURE_API_KEY: "worker-only-canary",
    },
    (reads) => {
      assertEquals(loadRuntimeConfig().deploymentEnvironment, "test");
      loadAuthConfig();
      loadApiS3Config();
      loadArtifactLifecycleConfig();
      loadApiShareTokenKeyringConfig();
      assertEquals(loadEnabledObservabilityConfig(), null);
      assertEquals(reads.includes("AZURE_API_KEY"), false);
    },
  );
});

Deno.test("worker config defaults never read API-only secrets", () => {
  withStubbedProcessEnvironment(
    {
      ...validDatabaseEnv,
      ...validS3Env,
      APP_ENV: "test",
      ARTIFACT_WORKSPACE_MAX_BYTES: "1000000",
      AZURE_API_KEY: "worker-secret",
      ...validAuthEnv,
      SHARE_TOKEN_ACTIVE_VERSION: "api-only-canary",
      SHARE_TOKEN_KEYS: "api-only-canary",
    },
    (reads) => {
      loadRuntimeConfig();
      loadWorkerS3Config();
      loadArtifactLifecycleConfig();
      loadWorkerAzureProviderConfig();
      for (
        const name of [
          ...Object.keys(validAuthEnv),
          "SHARE_TOKEN_ACTIVE_VERSION",
          "SHARE_TOKEN_KEYS",
          "S3_PUBLIC_ENDPOINT",
        ]
      ) {
        assertEquals(reads.includes(name), false, `${name} must not be read`);
      }
    },
  );
});

Deno.test("loadApiS3Config applies safe storage defaults", () => {
  const config = loadApiS3Config(validS3Env, "production");
  assertEquals(config.bucket, "relay-artifacts");
  assertEquals(config.region, "us-east-1");
  assertEquals(config.credentials, {
    accessKeyId: "storage-access-key",
    secretAccessKey: "storage-secret-key",
  });
  assertEquals(
    config.internalEndpoint.toString(),
    "http://minio.internal:9000/",
  );
  assertEquals(
    config.publicSigningEndpoint.toString(),
    "https://objects.example.test/",
  );
  assertEquals(config.forcePathStyle, true);
  assertEquals(config.bucketVersioning, "enabled");
  assertEquals(config.requestTimeoutMs, 30_000);
});

Deno.test("loadWorkerS3Config does not require a public signing endpoint", () => {
  const { S3_PUBLIC_ENDPOINT: _drop, ...workerEnv } = validS3Env;
  const config = loadWorkerS3Config(workerEnv, "production");
  assertEquals(config.publicSigningEndpoint, undefined);
});

Deno.test("loadApiS3Config requires every API storage setting", () => {
  for (
    const name of [
      "S3_ENDPOINT",
      "S3_PUBLIC_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ] as const
  ) {
    const env: Record<string, string | undefined> = { ...validS3Env };
    delete env[name];
    assertThrows(() => loadApiS3Config(env, "production"), Error, name);
  }
});

Deno.test("S3 public signing endpoints require HTTPS in production", () => {
  assertThrows(
    () =>
      loadS3Config({
        ...validS3Env,
        APP_ENV: "production",
        S3_PUBLIC_ENDPOINT: "http://localhost:8000",
      }),
    Error,
    "S3_PUBLIC_ENDPOINT",
  );

  const endpoint = "http://objects.example.test/sensitive-path";
  const message = thrownMessage(() =>
    loadApiS3Config(
      { ...validS3Env, S3_PUBLIC_ENDPOINT: endpoint },
      "production",
    )
  );
  assertEquals(message.includes("S3_PUBLIC_ENDPOINT"), true);
  assertEquals(message.includes("HTTPS"), true);
  assertEquals(message.includes(endpoint), false);
});

Deno.test("S3 endpoints reject embedded credentials without echoing them", () => {
  const endpoint = "https://user:do-not-echo@objects.example.test";
  const message = thrownMessage(() =>
    loadApiS3Config(
      { ...validS3Env, S3_PUBLIC_ENDPOINT: endpoint },
      "production",
    )
  );
  assertEquals(message.includes("S3_PUBLIC_ENDPOINT"), true);
  assertEquals(message.includes("do-not-echo"), false);
});

Deno.test("S3 endpoints allow safe HTTP in development and test", () => {
  const development = loadApiS3Config({
    ...validS3Env,
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_PUBLIC_ENDPOINT: "http://localhost:8000/storage",
  }, "development");
  assertEquals(
    development.publicSigningEndpoint?.toString(),
    "http://localhost:8000/storage",
  );

  const test = loadApiS3Config({
    ...validS3Env,
    S3_ENDPOINT: "http://minio:9000",
    S3_PUBLIC_ENDPOINT: "http://api.internal:8000/storage",
  }, "test");
  assertEquals(test.internalEndpoint.hostname, "minio");
});

Deno.test("S3 endpoints reject unsafe cleartext hosts", () => {
  assertThrows(
    () =>
      loadApiS3Config({
        ...validS3Env,
        S3_PUBLIC_ENDPOINT: "http://objects.example.test",
      }, "development"),
    Error,
    "S3_PUBLIC_ENDPOINT",
  );
  assertThrows(
    () =>
      loadWorkerS3Config({
        ...validS3Env,
        S3_ENDPOINT: "http://objects.example.test",
      }, "test"),
    Error,
    "S3_ENDPOINT",
  );
});

Deno.test("S3 invariants and request timeout are bounded", () => {
  assertThrows(
    () => loadApiS3Config({ ...validS3Env, S3_FORCE_PATH_STYLE: "false" }),
    Error,
    "S3_FORCE_PATH_STYLE",
  );
  assertThrows(
    () => loadApiS3Config({ ...validS3Env, S3_BUCKET_VERSIONING: "disabled" }),
    Error,
    "S3_BUCKET_VERSIONING",
  );
  for (const timeout of ["0", "120001", "1.5"]) {
    assertThrows(
      () =>
        loadApiS3Config({
          ...validS3Env,
          S3_REQUEST_TIMEOUT_MS: timeout,
        }),
      Error,
      "S3_REQUEST_TIMEOUT_MS",
    );
  }
  assertEquals(
    loadApiS3Config({
      ...validS3Env,
      S3_REQUEST_TIMEOUT_MS: "120000",
    }).requestTimeoutMs,
    120_000,
  );
});

Deno.test("storage errors never echo configured secrets", () => {
  const secret = "storage-secret-that-must-not-leak";
  const message = thrownMessage(() =>
    loadApiS3Config({
      ...validS3Env,
      S3_SECRET_ACCESS_KEY: secret,
      S3_REQUEST_TIMEOUT_MS: "invalid",
    })
  );
  assertEquals(message.includes("S3_REQUEST_TIMEOUT_MS"), true);
  assertEquals(message.includes(secret), false);
});

Deno.test("loadArtifactLifecycleConfig requires a positive workspace limit", () => {
  assertThrows(
    () => loadArtifactLifecycleConfig({}),
    Error,
    "ARTIFACT_WORKSPACE_MAX_BYTES",
  );
  assertThrows(
    () => loadArtifactLifecycleConfig({ ARTIFACT_WORKSPACE_MAX_BYTES: "0" }),
    Error,
    "ARTIFACT_WORKSPACE_MAX_BYTES",
  );
});

Deno.test("loadArtifactLifecycleConfig applies service-aligned defaults", () => {
  const config = loadArtifactLifecycleConfig({
    ARTIFACT_WORKSPACE_MAX_BYTES: String(1024 * 1024 * 1024),
  });
  assertEquals(config, {
    workspaceMaxBytes: 1024 * 1024 * 1024,
    maxUploadBytes: 100 * 1024 * 1024,
    uploadTtlSeconds: 15 * 60,
    downloadTtlSeconds: 5 * 60,
    purgeDelaySeconds: 7 * 24 * 60 * 60,
    cleanupLeaseSeconds: 60,
    maintenanceIntervalMs: 30_000,
    maintenanceBatchSize: 100,
  });
});

Deno.test("loadArtifactLifecycleConfig reads explicit bounded settings", () => {
  assertEquals(
    loadArtifactLifecycleConfig({
      ARTIFACT_WORKSPACE_MAX_BYTES: "1000000",
      ARTIFACT_MAX_UPLOAD_BYTES: "900000",
      ARTIFACT_UPLOAD_TTL_SECONDS: "120",
      ARTIFACT_DOWNLOAD_TTL_SECONDS: "240",
      ARTIFACT_PURGE_DELAY_SECONDS: "3600",
      ARTIFACT_CLEANUP_LEASE_SECONDS: "30",
      ARTIFACT_MAINTENANCE_INTERVAL_MS: "5000",
      ARTIFACT_MAINTENANCE_BATCH_SIZE: "25",
    }),
    {
      workspaceMaxBytes: 1_000_000,
      maxUploadBytes: 900_000,
      uploadTtlSeconds: 120,
      downloadTtlSeconds: 240,
      purgeDelaySeconds: 3_600,
      cleanupLeaseSeconds: 30,
      maintenanceIntervalMs: 5_000,
      maintenanceBatchSize: 25,
    },
  );
});

Deno.test("artifact upload, TTL, purge, and maintenance settings are bounded", () => {
  const base = { ARTIFACT_WORKSPACE_MAX_BYTES: "10000000000" };
  const invalid: Record<string, string> = {
    ARTIFACT_MAX_UPLOAD_BYTES: String(5 * 1024 * 1024 * 1024 + 1),
    ARTIFACT_UPLOAD_TTL_SECONDS: String(7 * 24 * 60 * 60 + 1),
    ARTIFACT_DOWNLOAD_TTL_SECONDS: "0",
    ARTIFACT_PURGE_DELAY_SECONDS: String(365 * 24 * 60 * 60 + 1),
    ARTIFACT_CLEANUP_LEASE_SECONDS: String(24 * 60 * 60 + 1),
    ARTIFACT_MAINTENANCE_INTERVAL_MS: String(24 * 60 * 60 * 1_000 + 1),
    ARTIFACT_MAINTENANCE_BATCH_SIZE: "101",
  };
  for (const [name, value] of Object.entries(invalid)) {
    assertThrows(
      () => loadArtifactLifecycleConfig({ ...base, [name]: value }),
      Error,
      name,
    );
  }
  assertThrows(
    () =>
      loadArtifactLifecycleConfig({
        ARTIFACT_WORKSPACE_MAX_BYTES: "100",
        ARTIFACT_MAX_UPLOAD_BYTES: "101",
      }),
    Error,
    "ARTIFACT_MAX_UPLOAD_BYTES",
  );
});

Deno.test("loadApiShareTokenKeyringConfig decodes and sorts rotating keys", () => {
  const first = encodeBase64(new Uint8Array(32).fill(7));
  const second = encodeBase64(new Uint8Array(48).fill(255), true);
  const config = loadApiShareTokenKeyringConfig({
    SHARE_TOKEN_ACTIVE_VERSION: "2",
    SHARE_TOKEN_KEYS: JSON.stringify({ 2: second, 1: first }),
  });

  assertEquals(config.activeVersion, 2);
  assertEquals(config.keys.map((key) => key.version), [1, 2]);
  assertEquals(config.keys[0].secret.byteLength, 32);
  assertEquals(config.keys[1].secret.byteLength, 48);
});

Deno.test("share-token keyring requires positive configured versions", () => {
  const secret = encodeBase64(new Uint8Array(32).fill(1));
  assertThrows(
    () =>
      loadApiShareTokenKeyringConfig({
        SHARE_TOKEN_ACTIVE_VERSION: "0",
        SHARE_TOKEN_KEYS: JSON.stringify({ 1: secret }),
      }),
    Error,
    "SHARE_TOKEN_ACTIVE_VERSION",
  );
  assertThrows(
    () =>
      loadApiShareTokenKeyringConfig({
        SHARE_TOKEN_ACTIVE_VERSION: "2",
        SHARE_TOKEN_KEYS: JSON.stringify({ 1: secret }),
      }),
    Error,
    "SHARE_TOKEN_ACTIVE_VERSION",
  );
  assertThrows(
    () =>
      loadApiShareTokenKeyringConfig({
        SHARE_TOKEN_ACTIVE_VERSION: "1",
        SHARE_TOKEN_KEYS: JSON.stringify({ 0: secret, 1: secret }),
      }),
    Error,
    "SHARE_TOKEN_KEYS",
  );
  assertThrows(
    () =>
      loadApiShareTokenKeyringConfig({
        SHARE_TOKEN_ACTIVE_VERSION: "1",
        SHARE_TOKEN_KEYS: JSON.stringify({ "01": secret, 1: secret }),
      }),
    Error,
    "SHARE_TOKEN_KEYS",
  );
});

Deno.test("share-token keyring rejects malformed JSON and short keys", () => {
  assertThrows(
    () =>
      loadApiShareTokenKeyringConfig({
        SHARE_TOKEN_ACTIVE_VERSION: "1",
        SHARE_TOKEN_KEYS: "[]",
      }),
    Error,
    "SHARE_TOKEN_KEYS",
  );
  assertThrows(
    () =>
      loadApiShareTokenKeyringConfig({
        SHARE_TOKEN_ACTIVE_VERSION: "1",
        SHARE_TOKEN_KEYS: JSON.stringify({
          1: encodeBase64(new Uint8Array(31)),
        }),
      }),
    Error,
    "SHARE_TOKEN_KEYS",
  );
});

Deno.test("share-token keyring errors never echo key material", () => {
  const secret = "not-base64-key-material-that-must-not-leak***";
  const message = thrownMessage(() =>
    loadApiShareTokenKeyringConfig({
      SHARE_TOKEN_ACTIVE_VERSION: "1",
      SHARE_TOKEN_KEYS: JSON.stringify({ 1: secret }),
    })
  );
  assertEquals(message.includes("SHARE_TOKEN_KEYS"), true);
  assertEquals(message.includes(secret), false);
});

Deno.test("loadWorkerAzureProviderConfig applies provider-aligned defaults", () => {
  const config = loadWorkerAzureProviderConfig({
    AZURE_API_KEY: "azure-secret",
    AZURE_ENDPOINT: "https://ignored.example.test",
  });
  assertEquals(config, {
    apiKey: "azure-secret",
    timeoutMs: 120_000,
    maxResponseBytes: 96 * 1024 * 1024,
    maxBase64Bytes: 64 * 1024 * 1024,
  });
  assertEquals(Object.hasOwn(config, "endpoint"), false);
});

Deno.test("loadWorkerAzureProviderConfig reads bounded worker limits", () => {
  assertEquals(
    loadWorkerAzureProviderConfig({
      AZURE_API_KEY: "azure-secret",
      AZURE_REQUEST_TIMEOUT_MS: "1000",
      AZURE_MAX_RESPONSE_BYTES: "2048",
      AZURE_MAX_OUTPUT_BYTES: "1024",
    }),
    {
      apiKey: "azure-secret",
      timeoutMs: 1_000,
      maxResponseBytes: 2_048,
      maxBase64Bytes: 1_024,
    },
  );
});

Deno.test("Azure provider limits reject zero and oversized values", () => {
  const invalid: Record<string, string> = {
    AZURE_REQUEST_TIMEOUT_MS: "300001",
    AZURE_MAX_RESPONSE_BYTES: String(128 * 1024 * 1024 + 1),
    AZURE_MAX_OUTPUT_BYTES: String(64 * 1024 * 1024 + 1),
  };
  for (const [name, value] of Object.entries(invalid)) {
    assertThrows(
      () =>
        loadWorkerAzureProviderConfig({
          AZURE_API_KEY: "secret",
          [name]: value,
        }),
      Error,
      name,
    );
    assertThrows(
      () =>
        loadWorkerAzureProviderConfig({ AZURE_API_KEY: "secret", [name]: "0" }),
      Error,
      name,
    );
  }
});

Deno.test("Azure provider errors name variables without echoing API keys", () => {
  assertThrows(
    () => loadWorkerAzureProviderConfig({}),
    Error,
    "AZURE_API_KEY",
  );
  const secret = "azure-key-that-must-not-leak";
  const message = thrownMessage(() =>
    loadWorkerAzureProviderConfig({
      AZURE_API_KEY: secret,
      AZURE_REQUEST_TIMEOUT_MS: "invalid",
    })
  );
  assertEquals(message.includes("AZURE_REQUEST_TIMEOUT_MS"), true);
  assertEquals(message.includes(secret), false);
});
