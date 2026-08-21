import type { RuntimeConfig } from "@relay/config";
import { loadRuntimeConfig } from "@relay/config";
import { checkDatabaseHealth, createDatabasePool } from "@relay/database";
import { createApp } from "./app.ts";

export function startApi(
  config: RuntimeConfig = loadRuntimeConfig(),
): Deno.HttpServer {
  const pool = createDatabasePool(config.database, "relay-api");
  const app = createApp(config, {
    checkReadiness: async () => [await checkDatabaseHealth(pool)],
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
