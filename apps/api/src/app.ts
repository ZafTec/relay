import { Hono } from "@hono/hono";
import type { RuntimeConfig } from "@relay/config";
import { loadRuntimeConfig } from "@relay/config";

export function createApp(config: RuntimeConfig = loadRuntimeConfig()): Hono {
  const app = new Hono();

  app.get("/health/live", (context) => {
    return context.json({
      service: "api",
      status: "ok",
      build: config.build,
    });
  });

  app.get("/health/ready", (context) => {
    return context.json({
      service: "api",
      status: "ok",
      checks: [],
      build: config.build,
    });
  });

  app.get("/version", (context) => context.json(config.build));

  app.get("/api/v1", (context) => {
    return context.json({
      name: config.appName,
      status: "ok",
    });
  });

  app.notFound((context) => {
    return context.json(
      {
        error: {
          code: "not_found",
          message: "The requested resource was not found.",
        },
      },
      404,
    );
  });

  app.onError((error, context) => {
    console.error(JSON.stringify({
      level: "error",
      service: "api",
      message: error.message,
      stack: error.stack,
    }));

    return context.json(
      {
        error: {
          code: "internal_error",
          message: "An unexpected error occurred.",
        },
      },
      500,
    );
  });

  return app;
}
