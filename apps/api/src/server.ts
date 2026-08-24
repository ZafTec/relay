import type { ApplicationServices } from "@relay/application";
import type { RuntimeConfig } from "@relay/config";
import { loadAuthConfig, loadRuntimeConfig } from "@relay/config";
import {
  checkDatabaseHealth,
  checkMigrationLedgerHealth,
  createDatabasePool,
  MIGRATIONS,
} from "@relay/database";
import { createAuth } from "@relay/auth";
import {
  createJsonLogger,
  createRelayTelemetry,
  type JsonLogger,
  type RelayTelemetry,
} from "@relay/observability";
import { createApp, createRelayMcpHttpHandler } from "./app.ts";
import { createAuthSessionIdentityResolver } from "./routes/mod.ts";

export interface ApiRuntimeOptions {
  readonly logger?: JsonLogger;
  readonly telemetry?: RelayTelemetry;
  /** Mounts the v1 and MCP adapters when the composition root supplies them. */
  readonly applicationServices?: ApplicationServices;
}

export function startApi(
  config: RuntimeConfig = loadRuntimeConfig(),
  runtimeOptions: ApiRuntimeOptions = {},
): Deno.HttpServer {
  const telemetry = runtimeOptions.telemetry ?? createRelayTelemetry({
    instrumentationName: "relay-api",
    instrumentationVersion: config.build.version,
  });
  const logger = runtimeOptions.logger ?? createJsonLogger();
  const pool = createDatabasePool(config.database, "relay-api");
  const authConfig = loadAuthConfig();
  const auth = createAuth(pool, authConfig);
  const mcp = runtimeOptions.applicationServices === undefined
    ? undefined
    : createRelayMcpHttpHandler({
      auth,
      services: runtimeOptions.applicationServices,
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
  const app = createApp(config, {
    checkReadiness: async () => [
      await checkDatabaseHealth(pool),
      await checkMigrationLedgerHealth(pool, MIGRATIONS),
    ],
    auth,
    ...(runtimeOptions.applicationServices === undefined ? {} : {
      v1: {
        services: runtimeOptions.applicationServices,
        resolveIdentity: createAuthSessionIdentityResolver(auth, pool),
      },
      mcp,
    }),
    logger,
    telemetry,
  });

  const server = Deno.serve(
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

  const signals: Deno.Signal[] = ["SIGINT"];
  if (Deno.build.os !== "windows") signals.push("SIGTERM");

  const requestShutdown = () => {
    server.shutdown();
  };
  for (const signal of signals) Deno.addSignalListener(signal, requestShutdown);

  server.finished.finally(async () => {
    for (const signal of signals) {
      Deno.removeSignalListener(signal, requestShutdown);
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
  });

  return server;
}
