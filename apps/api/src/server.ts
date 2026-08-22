import type { RuntimeConfig } from "@relay/config";
import { loadAuthConfig, loadRuntimeConfig } from "@relay/config";
import {
  checkDatabaseHealth,
  checkMigrationLedgerHealth,
  createDatabasePool,
  MIGRATIONS,
} from "@relay/database";
import { createAuth } from "@relay/auth";
import { createApp } from "./app.ts";

export function startApi(
  config: RuntimeConfig = loadRuntimeConfig(),
): Deno.HttpServer {
  const pool = createDatabasePool(config.database, "relay-api");
  const auth = createAuth(pool, loadAuthConfig());
  const app = createApp(config, {
    checkReadiness: async () => [
      await checkDatabaseHealth(pool),
      await checkMigrationLedgerHealth(pool, MIGRATIONS),
    ],
    auth,
  });

  const server = Deno.serve(
    {
      port: config.port,
      onListen: ({ hostname, port }) => {
        console.log(JSON.stringify({
          level: "info",
          service: "api",
          message: "API listening",
          hostname,
          port,
          version: config.build.version,
          revision: config.build.revision,
        }));
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
      await pool.end();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        service: "api",
        message: "Error closing database pool",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  return server;
}
