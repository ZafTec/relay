import {
  type ApplicationServices,
  createPostgresAdmissionUsagePort,
  createPostgresApplicationServices,
} from "@relay/application";
import {
  ArtifactService,
  type ArtifactStorageLimitProvider,
  PostgresArtifactMutationIdempotencyRepository,
  PostgresArtifactQuota,
  ShareTokenCodec,
} from "@relay/artifacts";
import {
  checkCatalogReadiness,
  createHandlerRegistry,
  type HandlerRegistration,
  type HandlerRegistry,
} from "@relay/catalog";
import {
  type ApiS3Config,
  type ArtifactLifecycleConfig,
  loadApiS3Config,
  loadApiShareTokenKeyringConfig,
  loadArtifactLifecycleConfig,
  loadRuntimeConfig,
  type RuntimeConfig,
  type ShareTokenKeyringConfig,
} from "@relay/config";
import type { DatabasePool } from "@relay/database";
import {
  createS3ObjectStorage,
  type S3CompatibleStorage,
} from "@relay/storage";
import { type ApiRuntimeOptions, startApi } from "./server.ts";

export const MVP_ADMISSION_DEADLINE_MS = 60_000;
export const MVP_RUN_DEADLINE_MS = 5 * 60_000;

export const MVP_API_HANDLER_REGISTRATIONS: readonly HandlerRegistration[] =
  Object.freeze([
    ...[
      "image.edit.azure-openai.gpt-image-2.v1",
      "image.edit.azure-flux.flux-2-pro.v1",
      "image.generate.azure-mai.mai-image-2.5.v1",
      "image.edit.azure-mai.mai-image-2.5.v1",
      "image.generate.azure-mai.mai-image-2.5-flash.v1",
      "image.edit.azure-mai.mai-image-2.5-flash.v1",
    ].map((key) =>
      Object.freeze({ key, inputSchemaVersion: 1, handlerVersion: "1" })
    ),
    Object.freeze({
      key: "image.generate.azure-openai.gpt-image-2.v1",
      inputSchemaVersion: 1,
      handlerVersion: "1",
    }),
    Object.freeze({
      key: "image.generate.azure-flux.flux-2-pro.v1",
      inputSchemaVersion: 1,
      handlerVersion: "1",
    }),
    Object.freeze({
      key: "document.ocr.azure-mistral.v1",
      inputSchemaVersion: 1,
      handlerVersion: "1",
    }),
  ]);

export type MvpApiRuntimeOptions = Omit<
  ApiRuntimeOptions,
  "applicationServices" | "applicationServicesFactory"
>;

export interface MvpApiCompositionDependencies {
  readonly loadRuntimeConfig: () => RuntimeConfig;
  readonly loadApiS3Config: () => ApiS3Config;
  readonly loadArtifactLifecycleConfig: () => ArtifactLifecycleConfig;
  readonly loadApiShareTokenKeyringConfig: () => ShareTokenKeyringConfig;
  readonly createS3ObjectStorage: typeof createS3ObjectStorage;
  readonly startApi: typeof startApi;
}

const MVP_API_DEPENDENCIES: MvpApiCompositionDependencies = {
  loadRuntimeConfig,
  loadApiS3Config,
  loadArtifactLifecycleConfig,
  loadApiShareTokenKeyringConfig,
  createS3ObjectStorage,
  startApi,
};

export function createMvpApiHandlerRegistry(): HandlerRegistry {
  return createHandlerRegistry(MVP_API_HANDLER_REGISTRATIONS);
}

export function createGlobalArtifactStorageLimitProvider(
  workspaceMaxBytes: number,
): ArtifactStorageLimitProvider {
  const maxBytes = String(workspaceMaxBytes);
  return {
    getLimit: () => Promise.resolve({ kind: "limited", maxBytes }),
  };
}

import { createNotificationService } from "@relay/notifications";
import { createContentService } from "@relay/application";

export function createMvpApiApplicationServices(
  pool: DatabasePool,
  storage: S3CompatibleStorage,
  lifecycle: ArtifactLifecycleConfig,
  keyring: ShareTokenKeyringConfig,
  handlers: HandlerRegistry = createMvpApiHandlerRegistry(),
): ApplicationServices {
  const quota = new PostgresArtifactQuota({
    limitProvider: createGlobalArtifactStorageLimitProvider(
      lifecycle.workspaceMaxBytes,
    ),
  });
  const artifacts = new ArtifactService({
    pool,
    storage,
    quota,
    idempotencyRepository: new PostgresArtifactMutationIdempotencyRepository(),
    shareTokenCodec: new ShareTokenCodec(keyring),
    maxUploadBytes: lifecycle.maxUploadBytes,
    uploadTtlSeconds: lifecycle.uploadTtlSeconds,
    downloadTtlSeconds: lifecycle.downloadTtlSeconds,
    purgeDelaySeconds: lifecycle.purgeDelaySeconds,
    cleanupLeaseSeconds: lifecycle.cleanupLeaseSeconds,
  });

  const services = createPostgresApplicationServices({
    pool,
    handlers,
    admissionUsage: createPostgresAdmissionUsagePort(),
    artifactCommands: artifacts,
    admissionDeadlineMs: MVP_ADMISSION_DEADLINE_MS,
    runDeadlineMs: MVP_RUN_DEADLINE_MS,
  });
  return {
    ...services,
    content: createContentService(
      artifacts,
      services.artifacts,
      Deno.env.get("BETTER_AUTH_URL") ?? "http://localhost:8000",
    ),
    notifications: createNotificationService(
      pool,
      Boolean(Deno.env.get("SMTP_HOST")),
    ),
  };
}

function onceAsync(
  callback: () => void | Promise<void>,
): () => Promise<void> {
  let promise: Promise<void> | undefined;
  return () => {
    promise ??= Promise.resolve().then(callback);
    return promise;
  };
}

/** Composes the production API without importing or loading provider secrets. */
export async function startMvpApi(
  runtimeOptions: MvpApiRuntimeOptions = {},
  dependencyOverrides: Partial<MvpApiCompositionDependencies> = {},
): Promise<Deno.HttpServer> {
  const dependencies = {
    ...MVP_API_DEPENDENCIES,
    ...dependencyOverrides,
  };

  // Parse every required value before opening a pool or storage client.
  const config = dependencies.loadRuntimeConfig();
  const s3Config = dependencies.loadApiS3Config();
  const lifecycle = dependencies.loadArtifactLifecycleConfig();
  const keyring = dependencies.loadApiShareTokenKeyringConfig();
  const storage = dependencies.createS3ObjectStorage(s3Config);
  const closeStorage = onceAsync(() => storage.close());

  try {
    const handlers = createMvpApiHandlerRegistry();
    return await dependencies.startApi(config, {
      ...runtimeOptions,
      applicationServicesFactory: (pool) =>
        createMvpApiApplicationServices(
          pool,
          storage,
          lifecycle,
          keyring,
          handlers,
        ),
      additionalReadinessChecks: [
        ...(runtimeOptions.additionalReadinessChecks ?? []),
        () => storage.checkHealth(),
        (pool) => checkCatalogReadiness(pool, handlers),
      ],
      shutdownCallbacks: [
        closeStorage,
        ...(runtimeOptions.shutdownCallbacks ?? []),
      ],
    });
  } catch (error) {
    try {
      await closeStorage();
    } catch (closeError) {
      runtimeOptions.logger?.error({
        eventName: "api.storage.close_failed",
        message: "API storage close failed during startup rollback",
        operation: "startup",
        outcome: "failure",
        error: closeError,
      });
    }
    throw error;
  }
}
