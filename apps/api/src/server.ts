import type { RuntimeConfig } from "@relay/config";
import { loadRuntimeConfig } from "@relay/config";
import { createApp } from "./app.ts";

export function startApi(
  config: RuntimeConfig = loadRuntimeConfig(),
): Deno.HttpServer {
  const app = createApp(config);

  return Deno.serve(
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
}
