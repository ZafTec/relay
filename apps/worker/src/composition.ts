import {
  ArtifactService,
  type ArtifactStorageLimitProvider,
  PostgresArtifactQuota,
} from "@relay/artifacts";
import { checkCatalogReadiness } from "@relay/catalog";
import {
  type ArtifactLifecycleConfig,
  type AzureProviderConfig,
  loadArtifactLifecycleConfig,
  loadRuntimeConfig,
  loadWorkerAzureProviderConfig,
  loadWorkerS3Config,
  type RuntimeConfig,
  type S3Config,
} from "@relay/config";
import { createDatabasePool } from "@relay/database";
import {
  createJsonLogger,
  type JsonLogger,
  type LogRecord,
} from "@relay/observability";
import {
  createAzureFlux2ProClient,
  createAzureGptImage2Client,
  createAzureMistralOcrClient,
} from "@relay/providers";
import { createS3ObjectStorage } from "@relay/storage";
import {
  createArtifactMaintenanceLoop,
  DEFAULT_ARTIFACT_MAINTENANCE_CONCURRENCY,
} from "./artifact-maintenance.ts";
import {
  createExecutionHandlerRegistry,
  startWorker,
  type WorkerRuntimeOptions,
} from "./worker.ts";
import { createMvpExecutionHandlers } from "./mvp-handlers.ts";

export type MvpWorkerRuntimeOptions =
  & Omit<
    WorkerRuntimeOptions,
    "pool" | "artifactMaintenance"
  >
  & {
    readonly artifactMaintenanceConcurrency?: number;
  };

export interface MvpWorkerCompositionDependencies {
  readonly loadRuntimeConfig: () => RuntimeConfig;
  readonly loadWorkerS3Config: () => S3Config;
  readonly loadArtifactLifecycleConfig: () => ArtifactLifecycleConfig;
  readonly loadWorkerAzureProviderConfig: () => AzureProviderConfig;
  readonly createDatabasePool: typeof createDatabasePool;
  readonly createS3ObjectStorage: typeof createS3ObjectStorage;
  readonly createAzureGptImage2Client: typeof createAzureGptImage2Client;
  readonly createAzureFlux2ProClient: typeof createAzureFlux2ProClient;
  readonly createAzureMistralOcrClient: typeof createAzureMistralOcrClient;
  readonly createArtifactMaintenanceLoop: typeof createArtifactMaintenanceLoop;
  readonly startWorker: typeof startWorker;
}

const MVP_WORKER_DEPENDENCIES: MvpWorkerCompositionDependencies = {
  loadRuntimeConfig,
  loadWorkerS3Config,
  loadArtifactLifecycleConfig,
  loadWorkerAzureProviderConfig,
  createDatabasePool,
  createS3ObjectStorage,
  createAzureGptImage2Client,
  createAzureFlux2ProClient,
  createAzureMistralOcrClient,
  createArtifactMaintenanceLoop,
  startWorker,
};

export function createWorkerArtifactStorageLimitProvider(
  workspaceMaxBytes: number,
): ArtifactStorageLimitProvider {
  const maxBytes = String(workspaceMaxBytes);
  return {
    getLimit: () => Promise.resolve({ kind: "limited", maxBytes }),
  };
}

function workerLogger(options: MvpWorkerRuntimeOptions): JsonLogger {
  if (options.logger !== undefined) return options.logger;
  if (options.log === undefined) return createJsonLogger();
  return createJsonLogger({
    sink: {
      write(line) {
        options.log?.(JSON.parse(line) as LogRecord);
      },
    },
  });
}

function forwardSanitizedRecord(logger: JsonLogger, record: LogRecord): void {
  logger.log({
    eventName: record["event.name"],
    severity: record.severity,
    message: record.message,
    operation: record.operation ?? undefined,
    outcome: record.outcome ?? undefined,
    errorType: record["error.type"] ?? undefined,
    httpRoute: record["http.route"] ?? undefined,
    toolKey: record["tool.key"] ?? undefined,
    toolVersion: record["tool.version"] ?? undefined,
    provider: record.provider ?? undefined,
    model: record.model ?? undefined,
    attemptNumber: record["attempt.number"] ?? undefined,
    queueReason: record["queue.reason"] ?? undefined,
    requestId: record["request.id"] ?? undefined,
  });
}

type ResourceDisposer = () => Promise<void>;

function onceAsyncDisposer(
  dispose: () => void | Promise<void>,
): ResourceDisposer {
  let task: Promise<void> | undefined;
  return () => {
    task ??= Promise.resolve().then(dispose);
    return task;
  };
}

async function disposeWorkerResources(
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

/** Composes the production worker without importing or loading API-only secrets. */
export async function startMvpWorker(
  runtimeOptions: MvpWorkerRuntimeOptions = {},
  dependencyOverrides: Partial<MvpWorkerCompositionDependencies> = {},
): Promise<void> {
  const dependencies = {
    ...MVP_WORKER_DEPENDENCIES,
    ...dependencyOverrides,
  };

  // Parse every required value before opening a pool or storage client.
  const config = dependencies.loadRuntimeConfig();
  const s3Config = dependencies.loadWorkerS3Config();
  const lifecycle = dependencies.loadArtifactLifecycleConfig();
  const azure = dependencies.loadWorkerAzureProviderConfig();
  const logger = workerLogger(runtimeOptions);
  const disposers: ResourceDisposer[] = [];
  let operationFailed = false;
  let operationError: unknown;

  try {
    const pool = dependencies.createDatabasePool(
      config.database,
      "relay-worker",
    );
    disposers.push(onceAsyncDisposer(() => pool.end()));
    const objectStorage = dependencies.createS3ObjectStorage(s3Config);
    disposers.push(onceAsyncDisposer(() => objectStorage.close()));
    const quota = new PostgresArtifactQuota({
      limitProvider: createWorkerArtifactStorageLimitProvider(
        lifecycle.workspaceMaxBytes,
      ),
    });
    const artifacts = new ArtifactService({
      pool,
      storage: objectStorage,
      quota,
      maxUploadBytes: lifecycle.maxUploadBytes,
      uploadTtlSeconds: lifecycle.uploadTtlSeconds,
      downloadTtlSeconds: lifecycle.downloadTtlSeconds,
      purgeDelaySeconds: lifecycle.purgeDelaySeconds,
      cleanupLeaseSeconds: lifecycle.cleanupLeaseSeconds,
    });
    const providerOptions = {
      apiKey: azure.apiKey,
      fetch: globalThis.fetch,
      timeoutMs: azure.timeoutMs,
      maxResponseBytes: azure.maxResponseBytes,
      maxBase64Bytes: azure.maxBase64Bytes,
    };
    const handlers = createExecutionHandlerRegistry(
      createMvpExecutionHandlers({
        pool,
        storage: objectStorage,
        artifactService: artifacts,
        gptImage2Client: dependencies.createAzureGptImage2Client(
          providerOptions,
        ),
        flux2ProClient: dependencies.createAzureFlux2ProClient(providerOptions),
        mistralOcrClient: dependencies.createAzureMistralOcrClient(
          providerOptions,
        ),
      }),
    );
    const artifactMaintenance = dependencies.createArtifactMaintenanceLoop(
      artifacts,
      {
        intervalMs: lifecycle.maintenanceIntervalMs,
        batchSize: lifecycle.maintenanceBatchSize,
        concurrency: runtimeOptions.artifactMaintenanceConcurrency ??
          DEFAULT_ARTIFACT_MAINTENANCE_CONCURRENCY,
        log: (record) => forwardSanitizedRecord(logger, record),
      },
    );
    const {
      artifactMaintenanceConcurrency: _artifactMaintenanceConcurrency,
      ...workerOptions
    } = runtimeOptions;

    await dependencies.startWorker(config, {
      ...workerOptions,
      environment: runtimeOptions.environment ?? config.deploymentEnvironment,
      logger,
      pool,
      handlerRegistry: handlers,
      artifactMaintenance,
      additionalReadinessChecks: [
        ...(runtimeOptions.additionalReadinessChecks ?? []),
        () => objectStorage.checkHealth(),
        (databasePool) =>
          checkCatalogReadiness(databasePool, handlers.catalogHandlers),
      ],
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupErrors = await disposeWorkerResources(disposers);
  if (operationFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "MVP worker failed and resource cleanup failed",
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "MVP worker resource cleanup failed",
    );
  }
}
