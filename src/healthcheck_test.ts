import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { ApiS3Config, RuntimeConfig, S3Config } from "@relay/config";

import {
  type ContainerHealthcheckDependencies,
  type HealthcheckDatabasePool,
  type HealthcheckRedisConnection,
  type HealthcheckStorage,
  parseRelayProcessRole,
  runContainerHealthcheck,
} from "./healthcheck.ts";

const RUNTIME_CONFIG: RuntimeConfig = {
  appName: "Relay",
  port: 8000,
  deploymentEnvironment: "production",
  build: { version: "1.2.3", revision: "abc123" },
  database: {
    url: new URL("postgres://relay:test@postgres:5432/relay"),
    poolMax: 2,
    connectTimeoutMs: 1_000,
    statementTimeoutMs: 5_000,
  },
  redis: {
    url: new URL("redis://:test@redis:6379"),
    connectTimeoutMs: 1_000,
  },
};

const API_S3_CONFIG: ApiS3Config = {
  bucket: "relay-artifacts",
  region: "us-east-1",
  credentials: {
    accessKeyId: "api-access",
    secretAccessKey: "api-secret",
  },
  internalEndpoint: new URL("http://minio:9000"),
  publicSigningEndpoint: new URL("https://objects.example.test"),
  forcePathStyle: true,
  bucketVersioning: "enabled",
  requestTimeoutMs: 1_000,
};

const WORKER_S3_CONFIG: S3Config = {
  bucket: "relay-artifacts",
  region: "us-east-1",
  credentials: {
    accessKeyId: "worker-access",
    secretAccessKey: "worker-secret",
  },
  internalEndpoint: new URL("http://minio:9000"),
  forcePathStyle: true,
  bucketVersioning: "enabled",
  requestTimeoutMs: 1_000,
};

interface HarnessOptions {
  readonly role: string;
  readonly redisReachable?: boolean;
  readonly databaseCheckError?: Error;
  readonly storageFactoryError?: Error;
  readonly storageCloseError?: Error;
}

function createHarness(options: HarnessOptions): {
  readonly dependencies: ContainerHealthcheckDependencies;
  readonly calls: string[];
  readonly closeCounts: {
    pool: number;
    redis: number;
    storage: number;
  };
  readonly selectedS3Configs: S3Config[];
} {
  const calls: string[] = [];
  const closeCounts = { pool: 0, redis: 0, storage: 0 };
  const selectedS3Configs: S3Config[] = [];

  const pool: HealthcheckDatabasePool = {
    end() {
      calls.push("pool:end");
      closeCounts.pool += 1;
      return Promise.resolve();
    },
  };
  const redis: HealthcheckRedisConnection = {
    ping() {
      calls.push("redis:ping");
      return options.redisReachable === false
        ? Promise.reject(new Error("injected Redis URL with secret"))
        : Promise.resolve("PONG");
    },
    disconnect(reconnect) {
      calls.push("redis:disconnect");
      assertEquals(reconnect, false);
      closeCounts.redis += 1;
    },
  };
  const storage: HealthcheckStorage = {
    checkHealth() {
      calls.push("storage:check");
      return Promise.resolve({ name: "storage", status: "ok" });
    },
    close() {
      calls.push("storage:close");
      closeCounts.storage += 1;
      if (options.storageCloseError !== undefined) {
        throw options.storageCloseError;
      }
    },
  };

  const dependencies: ContainerHealthcheckDependencies = {
    readProcessRole() {
      calls.push("role:read");
      return options.role;
    },
    loadRuntimeConfig() {
      calls.push("runtime:load");
      return RUNTIME_CONFIG;
    },
    loadApiS3Config() {
      calls.push("s3:load:api");
      return API_S3_CONFIG;
    },
    loadWorkerS3Config() {
      calls.push("s3:load:worker");
      return WORKER_S3_CONFIG;
    },
    createDatabasePool(config, processName) {
      calls.push("pool:create");
      assertStrictEquals(config, RUNTIME_CONFIG.database);
      assertEquals(processName, "relay-healthcheck");
      return pool;
    },
    createRedisConnection(config, connectionName) {
      calls.push("redis:create");
      assertStrictEquals(config, RUNTIME_CONFIG.redis);
      assertEquals(connectionName, `relay-${options.role}-healthcheck`);
      return redis;
    },
    createS3ObjectStorage(config) {
      calls.push("storage:create");
      selectedS3Configs.push(config);
      if (options.storageFactoryError !== undefined) {
        throw options.storageFactoryError;
      }
      return storage;
    },
    checkDatabaseHealth(candidate) {
      calls.push("database:check");
      assertStrictEquals(candidate, pool);
      if (options.databaseCheckError !== undefined) {
        return Promise.reject(options.databaseCheckError);
      }
      return Promise.resolve({ name: "database", status: "ok" });
    },
    checkMigrationLedgerHealth(candidate, migrations) {
      calls.push("migrations:check");
      assertStrictEquals(candidate, pool);
      assertEquals(migrations, []);
      return Promise.resolve({ name: "migrations", status: "ok" });
    },
    migrations: [],
  };

  return { dependencies, calls, closeCounts, selectedS3Configs };
}

Deno.test("container healthcheck requires an explicit API or worker role", async () => {
  for (const value of [undefined, "", "API", "migrate"]) {
    assertThrows(
      () => parseRelayProcessRole(value),
      Error,
      "RELAY_PROCESS_ROLE must be explicitly set to api or worker",
    );
  }

  let runtimeLoaded = false;
  await assertRejects(
    () =>
      runContainerHealthcheck({
        readProcessRole: () => undefined,
        loadRuntimeConfig: () => {
          runtimeLoaded = true;
          return RUNTIME_CONFIG;
        },
      }),
    Error,
    "RELAY_PROCESS_ROLE must be explicitly set to api or worker",
  );
  assertEquals(runtimeLoaded, false);
});

Deno.test("API healthcheck uses API S3 config and closes every resource once", async () => {
  const harness = createHarness({ role: "api" });

  const result = await runContainerHealthcheck(harness.dependencies);

  assertEquals(result, {
    role: "api",
    healthy: true,
    checks: [
      { name: "database", status: "ok" },
      { name: "migrations", status: "ok" },
      { name: "redis", status: "ok" },
      { name: "storage", status: "ok" },
    ],
  });
  assertEquals(harness.selectedS3Configs, [API_S3_CONFIG]);
  assertEquals(harness.closeCounts, { pool: 1, redis: 1, storage: 1 });
  assertEquals(harness.calls, [
    "role:read",
    "runtime:load",
    "s3:load:api",
    "pool:create",
    "redis:create",
    "storage:create",
    "database:check",
    "migrations:check",
    "redis:ping",
    "storage:check",
    "storage:close",
    "redis:disconnect",
    "pool:end",
  ]);
});

Deno.test("worker healthcheck uses worker S3 config and reports Redis failure", async () => {
  const harness = createHarness({ role: "worker", redisReachable: false });

  const result = await runContainerHealthcheck(harness.dependencies);

  assertEquals(result, {
    role: "worker",
    healthy: false,
    checks: [
      { name: "database", status: "ok" },
      { name: "migrations", status: "ok" },
      { name: "redis", status: "error", message: "unreachable" },
      { name: "storage", status: "ok" },
    ],
  });
  assertEquals(harness.selectedS3Configs, [WORKER_S3_CONFIG]);
  assertEquals(harness.calls.includes("s3:load:api"), false);
  assertEquals(harness.closeCounts, { pool: 1, redis: 1, storage: 1 });
});

Deno.test("unexpected check failure waits for every check and closes once", async () => {
  const harness = createHarness({
    role: "api",
    databaseCheckError: new Error("injected database check failure"),
  });

  await assertRejects(
    () => runContainerHealthcheck(harness.dependencies),
    Error,
    "injected database check failure",
  );

  assertEquals(harness.calls.includes("migrations:check"), true);
  assertEquals(harness.calls.includes("redis:ping"), true);
  assertEquals(harness.calls.includes("storage:check"), true);
  assertEquals(harness.closeCounts, { pool: 1, redis: 1, storage: 1 });
});

Deno.test("partial setup failure closes only resources that were created", async () => {
  const harness = createHarness({
    role: "worker",
    storageFactoryError: new Error("injected storage construction failure"),
  });

  await assertRejects(
    () => runContainerHealthcheck(harness.dependencies),
    Error,
    "injected storage construction failure",
  );

  assertEquals(harness.closeCounts, { pool: 1, redis: 1, storage: 0 });
  assertEquals(harness.calls.includes("database:check"), false);
  assertEquals(harness.calls.includes("redis:ping"), false);
});

Deno.test("cleanup failure does not skip remaining resource disposal", async () => {
  const harness = createHarness({
    role: "api",
    storageCloseError: new Error("injected storage close failure"),
  });

  await assertRejects(
    () => runContainerHealthcheck(harness.dependencies),
    AggregateError,
    "Container health-check resource cleanup failed",
  );
  assertEquals(harness.closeCounts, { pool: 1, redis: 1, storage: 1 });
});
