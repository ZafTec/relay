import {
  type ApiS3Config,
  type DatabaseConfig,
  loadApiS3Config,
  loadRuntimeConfig,
  loadWorkerS3Config,
  type RedisConfig,
  type RuntimeConfig,
  type S3Config,
} from "@relay/config";
import type { ReadinessCheck } from "@relay/contracts";
import {
  checkDatabaseHealth,
  checkMigrationLedgerHealth,
  createDatabasePool,
  type DatabasePool,
  type Migration,
  MIGRATIONS,
} from "@relay/database";
import { createRedisConnection } from "@relay/queue";
import { createS3ObjectStorage } from "@relay/storage";

export type RelayProcessRole = "api" | "worker";

export interface HealthcheckDatabasePool {
  end(): Promise<void>;
}

export interface HealthcheckRedisConnection {
  ping(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
}

export interface HealthcheckStorage {
  checkHealth(): Promise<ReadinessCheck>;
  close(): void;
}

export interface ContainerHealthcheckResult {
  readonly role: RelayProcessRole;
  readonly healthy: boolean;
  readonly checks: readonly ReadinessCheck[];
}

export interface ContainerHealthcheckDependencies {
  readonly readProcessRole: () => string | undefined;
  readonly loadRuntimeConfig: () => RuntimeConfig;
  readonly loadApiS3Config: () => ApiS3Config;
  readonly loadWorkerS3Config: () => S3Config;
  readonly createDatabasePool: (
    config: DatabaseConfig,
    processName: "relay-healthcheck",
  ) => HealthcheckDatabasePool;
  readonly createRedisConnection: (
    config: RedisConfig,
    connectionName: string,
  ) => HealthcheckRedisConnection;
  readonly createS3ObjectStorage: (config: S3Config) => HealthcheckStorage;
  readonly checkDatabaseHealth: (
    pool: HealthcheckDatabasePool,
  ) => Promise<ReadinessCheck>;
  readonly checkMigrationLedgerHealth: (
    pool: HealthcheckDatabasePool,
    migrations: readonly Migration[],
  ) => Promise<ReadinessCheck>;
  readonly migrations: readonly Migration[];
}

const CONTAINER_HEALTHCHECK_DEPENDENCIES: ContainerHealthcheckDependencies = {
  readProcessRole: () => Deno.env.get("RELAY_PROCESS_ROLE"),
  loadRuntimeConfig,
  loadApiS3Config,
  loadWorkerS3Config,
  createDatabasePool: (config, processName) =>
    createDatabasePool(config, processName),
  createRedisConnection: (config, connectionName) =>
    createRedisConnection(config, connectionName),
  createS3ObjectStorage: (config) => createS3ObjectStorage(config),
  checkDatabaseHealth: (pool) => checkDatabaseHealth(pool as DatabasePool),
  checkMigrationLedgerHealth: (pool, migrations) =>
    checkMigrationLedgerHealth(pool as DatabasePool, migrations),
  migrations: MIGRATIONS,
};

type ResourceDisposer = () => Promise<void>;

function onceDisposer(
  dispose: () => void | Promise<void>,
): ResourceDisposer {
  let task: Promise<void> | undefined;
  return () => {
    task ??= Promise.resolve().then(dispose);
    return task;
  };
}

async function disposeResources(
  disposers: readonly ResourceDisposer[],
): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  for (const dispose of [...disposers].reverse()) {
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function parseRelayProcessRole(
  value: string | undefined,
): RelayProcessRole {
  if (value !== "api" && value !== "worker") {
    throw new Error(
      "RELAY_PROCESS_ROLE must be explicitly set to api or worker",
    );
  }
  return value;
}

/** Performs one Redis command and never exposes the connection error. */
export async function checkRedisHealth(
  connection: Pick<HealthcheckRedisConnection, "ping">,
): Promise<ReadinessCheck> {
  try {
    await connection.ping();
    return { name: "redis", status: "ok" };
  } catch {
    return { name: "redis", status: "error", message: "unreachable" };
  }
}

async function runDependencyChecks(
  dependencies: ContainerHealthcheckDependencies,
  pool: HealthcheckDatabasePool,
  redis: HealthcheckRedisConnection,
  storage: HealthcheckStorage,
): Promise<readonly ReadinessCheck[]> {
  const settled = await Promise.allSettled([
    dependencies.checkDatabaseHealth(pool),
    dependencies.checkMigrationLedgerHealth(pool, dependencies.migrations),
    checkRedisHealth(redis),
    storage.checkHealth(),
  ]);
  const checks: ReadinessCheck[] = [];
  const errors: unknown[] = [];

  for (const result of settled) {
    if (result.status === "fulfilled") checks.push(result.value);
    else errors.push(result.reason);
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Container health checks failed");
  }
  return checks;
}

/**
 * Runs read-only dependency checks for the explicit container process role.
 * It intentionally loads neither API auth/share-token config nor worker
 * provider config, and it never constructs or invokes a paid provider client.
 */
export async function runContainerHealthcheck(
  dependencyOverrides: Partial<ContainerHealthcheckDependencies> = {},
): Promise<ContainerHealthcheckResult> {
  const dependencies = {
    ...CONTAINER_HEALTHCHECK_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const disposers: ResourceDisposer[] = [];
  let operationFailed = false;
  let operationError: unknown;
  let result: ContainerHealthcheckResult | undefined;

  try {
    const role = parseRelayProcessRole(dependencies.readProcessRole());

    // Parse every required value before opening any temporary connection.
    const runtimeConfig = dependencies.loadRuntimeConfig();
    const s3Config = role === "api"
      ? dependencies.loadApiS3Config()
      : dependencies.loadWorkerS3Config();

    const pool = dependencies.createDatabasePool(
      runtimeConfig.database,
      "relay-healthcheck",
    );
    disposers.push(onceDisposer(() => pool.end()));

    const redis = dependencies.createRedisConnection(
      runtimeConfig.redis,
      `relay-${role}-healthcheck`,
    );
    disposers.push(onceDisposer(() => redis.disconnect(false)));

    const storage = dependencies.createS3ObjectStorage(s3Config);
    disposers.push(onceDisposer(() => storage.close()));

    const checks = await runDependencyChecks(
      dependencies,
      pool,
      redis,
      storage,
    );
    result = {
      role,
      checks,
      healthy: checks.every((check) => check.status === "ok"),
    };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupErrors = await disposeResources(disposers);
  if (operationFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "Container health check failed and resource cleanup failed",
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Container health-check resource cleanup failed",
    );
  }
  if (result === undefined) {
    throw new Error("Container health check did not produce a result");
  }
  return result;
}
