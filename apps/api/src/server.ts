import { createPostgresSuperadminAccessService } from "./routes/admin_access.ts";
import { createPostgresWorkspaceManagementService } from "./routes/workspaces.ts";
import type { ApplicationServices } from "@relay/application";
import {
  getCapacityPolicy,
  listCapacityPolicies,
  reviseCapacityPolicy,
} from "@relay/catalog";
import {
  createChangelogDraft,
  getAdminChangelogRelease,
  getPublishedChangelogBySlug,
  listAdminChangelog,
  listPublishedChangelog,
  publishChangelogRelease,
  reviseChangelogDraft,
  unpublishChangelogRelease,
} from "@relay/changelog";
import type { RuntimeConfig } from "@relay/config";
import { loadAuthConfig, loadRuntimeConfig } from "@relay/config";
import type { ReadinessCheck } from "@relay/contracts";
import {
  checkDatabaseHealth,
  checkMigrationLedgerHealth,
  createDatabasePool,
  type DatabasePool,
  MIGRATIONS,
} from "@relay/database";
import { createAuth } from "@relay/auth";
import { createMcpAdminServices } from "./http/mcp-admin-services.ts";
import {
  createJsonLogger,
  createRelayTelemetry,
  type JsonLogger,
  type RelayTelemetry,
} from "@relay/observability";
import { createApp, createRelayMcpHttpHandler } from "./app.ts";
import {
  type AdminCapacityService,
  type AdminChangelogService,
  createAuthSessionIdentityResolver,
  type PublicChangelogReader,
} from "./routes/mod.ts";

export function createPostgresPublicChangelogReader(
  pool: DatabasePool,
): PublicChangelogReader {
  return {
    list: (options) => listPublishedChangelog(pool, options),
    getBySlug: (slug) => getPublishedChangelogBySlug(pool, slug),
  };
}

export function createPostgresAdminChangelogService(
  pool: DatabasePool,
): AdminChangelogService {
  return {
    list: (session, request) => listAdminChangelog(pool, session, request),
    get: (session, releaseId) =>
      getAdminChangelogRelease(pool, session, releaseId),
    create: (context, input) => createChangelogDraft(pool, context, input),
    revise: (context, releaseId, expectedRevision, input) =>
      reviseChangelogDraft(
        pool,
        context,
        releaseId,
        expectedRevision,
        input,
      ),
    publish: (context, releaseId, expectedRevision) =>
      publishChangelogRelease(pool, context, releaseId, expectedRevision),
    unpublish: (context, releaseId, expectedPublishedRevision) =>
      unpublishChangelogRelease(
        pool,
        context,
        releaseId,
        expectedPublishedRevision,
      ),
  };
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function capacityAuthorizationFailure(
  error: unknown,
): "denied" | "reauthentication_required" | undefined {
  const code = databaseErrorCode(error);
  if (code === "42501") return "denied";
  if (code === "28000" || code === "55000") {
    return "reauthentication_required";
  }
  return undefined;
}

export function createPostgresAdminCapacityService(
  pool: DatabasePool,
): AdminCapacityService {
  return {
    async list(session, options) {
      try {
        return await listCapacityPolicies(
          pool,
          { sessionId: session.sessionId },
          options,
        );
      } catch (error) {
        const kind = capacityAuthorizationFailure(error);
        if (kind !== undefined) return { kind };
        throw error;
      }
    },
    async get(session, input) {
      try {
        return await getCapacityPolicy(
          pool,
          { sessionId: session.sessionId },
          input,
        );
      } catch (error) {
        const kind = capacityAuthorizationFailure(error);
        if (kind !== undefined) return { kind };
        throw error;
      }
    },
    async revise(session, input) {
      try {
        return await reviseCapacityPolicy(
          pool,
          { sessionId: session.sessionId },
          input,
        );
      } catch (error) {
        const kind = capacityAuthorizationFailure(error);
        if (kind !== undefined) return { kind, replayed: false };
        throw error;
      }
    },
  };
}

export type ApiApplicationServicesFactory = (
  pool: DatabasePool,
) => ApplicationServices;

export type ApiReadinessCheck = (
  pool: DatabasePool,
) => Promise<ReadinessCheck>;

export type ApiShutdownCallback = (
  pool: DatabasePool,
) => void | Promise<void>;

export interface ApiRuntimeOptions {
  readonly logger?: JsonLogger;
  readonly telemetry?: RelayTelemetry;
  /** Mounts the v1 and MCP adapters when the composition root supplies them. */
  readonly applicationServices?:
    | ApplicationServices
    | ApiApplicationServicesFactory;
  /** Explicit factory form for composition roots that need the owned pool. */
  readonly applicationServicesFactory?: ApiApplicationServicesFactory;
  readonly additionalReadinessChecks?: readonly ApiReadinessCheck[];
  readonly shutdownCallbacks?: readonly ApiShutdownCallback[];
  readonly installSignalHandlers?: boolean;
}

export interface ApiRuntimeDependencies {
  readonly loadAuthConfig: typeof loadAuthConfig;
  readonly createDatabasePool: typeof createDatabasePool;
  readonly createAuth: typeof createAuth;
  readonly createApp: typeof createApp;
  readonly createMcpHttpHandler: typeof createRelayMcpHttpHandler;
  readonly checkDatabaseHealth: typeof checkDatabaseHealth;
  readonly checkMigrationLedgerHealth: typeof checkMigrationLedgerHealth;
  readonly serve: typeof Deno.serve;
  readonly signals: readonly Deno.Signal[];
  readonly addSignalListener: typeof Deno.addSignalListener;
  readonly removeSignalListener: typeof Deno.removeSignalListener;
}

const API_RUNTIME_DEPENDENCIES: ApiRuntimeDependencies = {
  loadAuthConfig,
  createDatabasePool,
  createAuth,
  createApp,
  createMcpHttpHandler: createRelayMcpHttpHandler,
  checkDatabaseHealth,
  checkMigrationLedgerHealth,
  serve: Deno.serve,
  signals: Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"],
  addSignalListener: Deno.addSignalListener,
  removeSignalListener: Deno.removeSignalListener,
};

function applicationServicesFor(
  options: ApiRuntimeOptions,
  pool: DatabasePool,
): ApplicationServices | undefined {
  if (
    options.applicationServices !== undefined &&
    options.applicationServicesFactory !== undefined
  ) {
    throw new TypeError(
      "applicationServices and applicationServicesFactory are mutually exclusive",
    );
  }

  if (options.applicationServicesFactory !== undefined) {
    return options.applicationServicesFactory(pool);
  }
  return typeof options.applicationServices === "function"
    ? options.applicationServices(pool)
    : options.applicationServices;
}

function serverWithObservableCleanup(
  server: Deno.HttpServer,
  finished: Promise<void>,
): Deno.HttpServer {
  return new Proxy(server, {
    get(target, property) {
      if (property === "finished") return finished;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function startApi(
  config: RuntimeConfig = loadRuntimeConfig(),
  runtimeOptions: ApiRuntimeOptions = {},
  dependencyOverrides: Partial<ApiRuntimeDependencies> = {},
): Promise<Deno.HttpServer> {
  const dependencies = {
    ...API_RUNTIME_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const telemetry = runtimeOptions.telemetry ?? createRelayTelemetry({
    instrumentationName: "relay-api",
    instrumentationVersion: config.build.version,
  });
  const logger = runtimeOptions.logger ?? createJsonLogger();
  const installedSignals: Deno.Signal[] = [];

  let pool: DatabasePool | undefined;
  let mcp: ReturnType<typeof createRelayMcpHttpHandler> | undefined;
  let server: Deno.HttpServer | undefined;
  let serverShutdownPromise: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const shutdownServer = (): Promise<void> => {
    if (server === undefined) return Promise.resolve();
    const activeServer = server;
    serverShutdownPromise ??= Promise.resolve().then(() =>
      activeServer.shutdown()
    );
    return serverShutdownPromise;
  };
  const requestShutdown = () => {
    void shutdownServer().catch((error) =>
      logger.error({
        eventName: "api.server.shutdown_failed",
        message: "API server shutdown failed",
        operation: "shutdown",
        outcome: "failure",
        error,
      })
    );
  };
  const cleanup = (): Promise<void> => {
    if (cleanupPromise !== undefined) return cleanupPromise;
    cleanupPromise = Promise.resolve().then(async () => {
      for (const signal of installedSignals.splice(0).reverse()) {
        try {
          dependencies.removeSignalListener(signal, requestShutdown);
        } catch (error) {
          logger.error({
            eventName: "api.signal_handler.remove_failed",
            message: "API signal handler removal failed",
            operation: "shutdown",
            outcome: "failure",
            error,
          });
        }
      }

      try {
        await mcp?.close();
      } catch (error) {
        logger.error({
          eventName: "api.mcp.close_failed",
          message: "MCP handler close failed",
          operation: "shutdown",
          outcome: "failure",
          error,
        });
      }

      if (pool !== undefined) {
        for (const callback of runtimeOptions.shutdownCallbacks ?? []) {
          try {
            await callback(pool);
          } catch (error) {
            logger.error({
              eventName: "api.shutdown_callback.failed",
              message: "API shutdown callback failed",
              operation: "shutdown",
              outcome: "failure",
              error,
            });
          }
        }

        try {
          await pool.end();
        } catch (error) {
          logger.error({
            eventName: "api.database.close_failed",
            message: "Database pool close failed",
            operation: "shutdown",
            outcome: "failure",
            error,
          });
        }
      }
    });
    return cleanupPromise;
  };

  try {
    const authConfig = dependencies.loadAuthConfig();
    const databasePool = dependencies.createDatabasePool(
      config.database,
      "relay-api",
    );
    pool = databasePool;
    const applicationServices = applicationServicesFor(
      runtimeOptions,
      databasePool,
    );
    const auth = dependencies.createAuth(databasePool, authConfig);
    mcp = applicationServices === undefined
      ? undefined
      : dependencies.createMcpHttpHandler({
        auth,
        services: applicationServices,
        adminServices: createMcpAdminServices({
          pool: databasePool,
          publicOrigin: authConfig.baseUrl.origin,
          allowances: createPostgresAdminAllowanceService(databasePool),
          capacity: createPostgresAdminCapacityService(databasePool),
          changelog: createPostgresAdminChangelogService(databasePool),
          superadmins: createPostgresSuperadminAccessService(databasePool),
          oauth: auth.manageMcpOAuthClient,
        }),
        allowedHostnames: [authConfig.baseUrl.hostname],
        allowedOrigins: authConfig.trustedOrigins,
        serverInfo: { name: "relay", version: config.build.version },
        onerror: (error) =>
          logger.error({
            eventName: "mcp.request.failed",
            message: "MCP request failed",
            operation: "mcp.request",
            outcome: "failure",
            error,
          }),
      });
    const additionalReadinessChecks =
      runtimeOptions.additionalReadinessChecks ?? [];
    const app = dependencies.createApp(config, {
      checkReadiness: () =>
        Promise.all([
          dependencies.checkDatabaseHealth(databasePool),
          dependencies.checkMigrationLedgerHealth(databasePool, MIGRATIONS),
          ...additionalReadinessChecks.map((check) => check(databasePool)),
        ]),
      auth,
      publicChangelog: {
        reader: createPostgresPublicChangelogReader(databasePool),
      },
      adminChangelog: {
        auth,
        service: createPostgresAdminChangelogService(databasePool),
        allowedOrigins: [
          authConfig.baseUrl.origin,
          ...authConfig.trustedOrigins,
        ],
        onUnexpectedError: (error, requestId, httpRoute) =>
          logger.error({
            eventName: "admin.changelog.request_failed",
            message: "Admin changelog request failed",
            operation: "admin.changelog",
            outcome: "failure",
            error,
            httpRoute,
            requestId,
          }),
      },
      adminAccess: {
        auth,
        service: createPostgresSuperadminAccessService(databasePool),
        allowedOrigins: [
          authConfig.baseUrl.origin,
          ...authConfig.trustedOrigins,
        ],
      },
      workspaces: {
        auth,
        service: createPostgresWorkspaceManagementService(databasePool),
        allowedOrigins: [
          authConfig.baseUrl.origin,
          ...authConfig.trustedOrigins,
        ],
      },
      adminAllowances: {
        auth,
        service: createPostgresAdminAllowanceService(databasePool),
        allowedOrigins: [
          authConfig.baseUrl.origin,
          ...authConfig.trustedOrigins,
        ],
        onUnexpectedError: (error, requestId, httpRoute) =>
          logger.error({
            eventName: "admin.allowances.request_failed",
            message: "Admin allowance request failed",
            operation: "admin.allowances",
            outcome: "failure",
            error,
            requestId,
            httpRoute,
          }),
      },
      adminCapacity: {
        auth,
        service: createPostgresAdminCapacityService(databasePool),
        allowedOrigins: [
          authConfig.baseUrl.origin,
          ...authConfig.trustedOrigins,
        ],
        onUnexpectedError: (error, requestId, httpRoute) =>
          logger.error({
            eventName: "admin.capacity.request_failed",
            message: "Admin capacity request failed",
            operation: "admin.capacity",
            outcome: "failure",
            error,
            httpRoute,
            requestId,
          }),
      },
      ...(applicationServices === undefined ? {} : {
        v1: {
          services: applicationServices,
          allowedOrigins: [
            authConfig.baseUrl.origin,
            ...authConfig.trustedOrigins,
          ],
          resolveIdentity: createAuthSessionIdentityResolver(
            auth,
            databasePool,
          ),
        },
        mcp,
      }),
      logger,
      telemetry,
    });

    server = dependencies.serve(
      {
        port: config.port,
        onListen: () => {
          logger.info({
            eventName: "api.started",
            message: "API listening",
            operation: "startup",
            outcome: "success",
          });
        },
      },
      app.fetch,
    );

    if (runtimeOptions.installSignalHandlers ?? true) {
      for (const signal of dependencies.signals) {
        dependencies.addSignalListener(signal, requestShutdown);
        installedSignals.push(signal);
      }
    }

    const finished = server.finished.finally(cleanup);
    return serverWithObservableCleanup(server, finished);
  } catch (error) {
    if (server !== undefined) {
      try {
        await shutdownServer();
      } catch (shutdownError) {
        logger.error({
          eventName: "api.server.shutdown_failed",
          message: "API server shutdown failed during startup rollback",
          operation: "startup",
          outcome: "failure",
          error: shutdownError,
        });
      }
    }
    await cleanup();
    throw error;
  }
}
import { createPostgresAdminAllowanceService } from "./routes/admin_allowances.ts";
