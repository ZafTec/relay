import { Hono } from "@hono/hono";
import type { RuntimeConfig } from "@relay/config";
import { loadRuntimeConfig } from "@relay/config";
import type { ReadinessCheck } from "@relay/contracts";
import { parseTrustedProxyCidrs } from "@relay/auth";
import type { Auth } from "@relay/auth";

export interface AppDependencies {
  /** Defaults to reporting no checks (always ready) when omitted. */
  readonly checkReadiness?: () => Promise<readonly ReadinessCheck[]>;
  /** Omitted in tests that don't need auth; mounts /api/auth/* when present. */
  readonly auth?: Auth;
  /** Overrides AUTH_TRUSTED_PROXY_CIDRS, primarily for focused tests. */
  readonly trustedProxyCidrs?: readonly string[];
}

function remoteAddressFromEnvironment(
  environment: unknown,
): string | undefined {
  if (typeof environment !== "object" || environment === null) return undefined;
  const remoteAddr = (environment as { remoteAddr?: unknown }).remoteAddr;
  if (typeof remoteAddr !== "object" || remoteAddr === null) return undefined;
  const hostname = (remoteAddr as { hostname?: unknown }).hostname;
  return typeof hostname === "string" ? hostname : undefined;
}

export function createApp(
  config: RuntimeConfig = loadRuntimeConfig(),
  dependencies: AppDependencies = {},
): Hono {
  const app = new Hono();
  const checkReadiness = dependencies.checkReadiness ??
    (() => Promise.resolve([]));

  // Mounted before every other route per
  // docs/implementation-handoff/03-auth-workspaces.md "Server
  // configuration" -- Better Auth validates the HTTP method itself, so
  // this can't shadow a legitimate non-auth route under /api/auth/*.
  if (dependencies.auth) {
    const auth = dependencies.auth;
    const trustedProxyCidrs = dependencies.trustedProxyCidrs ??
      parseTrustedProxyCidrs(Deno.env.get("AUTH_TRUSTED_PROXY_CIDRS"));
    app.all("/api/auth/*", (context) =>
      auth.handler(context.req.raw, {
        remoteAddress: remoteAddressFromEnvironment(context.env),
        trustedProxyCidrs,
      }));
  }

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
