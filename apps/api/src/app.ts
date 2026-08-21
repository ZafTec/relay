import { Hono } from "@hono/hono";
import type { RuntimeConfig } from "@relay/config";
import { loadRuntimeConfig } from "@relay/config";
import type { ReadinessCheck } from "@relay/contracts";

export interface AppDependencies {
  /** Defaults to reporting no checks (always ready) when omitted. */
  readonly checkReadiness?: () => Promise<readonly ReadinessCheck[]>;
}

export function createApp(
  config: RuntimeConfig = loadRuntimeConfig(),
  dependencies: AppDependencies = {},
): Hono {
  const app = new Hono();
  const checkReadiness = dependencies.checkReadiness ??
    (() => Promise.resolve([]));

  app.get("/health/live", (context) => {
    return context.json({
      service: "api",
      status: "ok",
      build: config.build,
    });
  });

  app.get("/health/ready", async (context) => {
    const checks = await checkReadiness();
    const healthy = checks.every((check) => check.status === "ok");

    return context.json(
      {
        service: "api",
        status: healthy ? "ok" : "degraded",
        checks,
        build: config.build,
      },
      healthy ? 200 : 503,
    );
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
