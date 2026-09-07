import {
  createSuperadminAccessRoutes,
  type SuperadminAccessRouteDependencies,
} from "./routes/admin_access.ts";
import { type Context, Hono } from "@hono/hono";
import { type Auth, parseTrustedProxyCidrs } from "@relay/auth";
import { loadRuntimeConfig, type RuntimeConfig } from "@relay/config";
import type { ReadinessCheck } from "@relay/contracts";
import {
  createHonoRouteEnrichment,
  createJsonLogger,
  createRelayTelemetry,
  type JsonLogger,
  type RelayTelemetry,
} from "@relay/observability";
import type { RelayMcpHttpHandler } from "./http/mcp.ts";
import {
  type AdminAllowanceRouteDependencies,
  type AdminCapacityRouteDependencies,
  type AdminChangelogRouteDependencies,
  createAdminAllowanceRoutes,
  createAdminCapacityRoutes,
  createAdminChangelogRoutes,
  createPublicChangelogRoutes,
  createV1Routes,
  type PublicChangelogRouteDependencies,
  type V1RouteDependencies,
} from "./routes/mod.ts";

export {
  createRelayMcpHttpHandler,
  DEFAULT_MAX_MCP_BODY_BYTES,
} from "./http/mcp.ts";
export type {
  McpHttpAuth,
  RelayMcpHttpHandler,
  RelayMcpHttpHandlerOptions,
} from "./http/mcp.ts";

type ApiEnvironment = {
  Variables: {
    requestId: string;
  };
};

export interface AppDependencies {
  /** Defaults to reporting no checks (always ready) when omitted. */
  readonly checkReadiness?: () => Promise<readonly ReadinessCheck[]>;
  /** Omitted in tests that don't need auth; mounts auth and OAuth metadata. */
  readonly auth?: Auth;
  /** Public, published-only changelog reads. */
  readonly publicChangelog?: PublicChangelogRouteDependencies;
  /** Cookie-authenticated superadmin changelog management. */
  readonly adminChangelog?: AdminChangelogRouteDependencies;
  /** Cookie-authenticated superadmin capacity-policy management. */
  readonly adminCapacity?: AdminCapacityRouteDependencies;
  readonly adminAllowances?: AdminAllowanceRouteDependencies;
  readonly adminAccess?: SuperadminAccessRouteDependencies;
  /** Versioned HTTP resources and workspace event streaming. */
  readonly v1?: V1RouteDependencies;
  /** OAuth-protected MCP Streamable HTTP boundary. */
  readonly mcp?: RelayMcpHttpHandler;
  /** Overrides AUTH_TRUSTED_PROXY_CIDRS, primarily for focused tests. */
  readonly trustedProxyCidrs?: readonly string[];
  readonly telemetry?: Pick<RelayTelemetry, "enrichActiveSpan" | "histogram">;
  readonly logger?: JsonLogger;
  /** Deterministic request-ID seam for focused tests. */
  readonly createRequestId?: () => string;
}

const REQUEST_ID_PATTERN =
  /^req_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const AUTH_METADATA_PATHS: readonly string[] = Object.freeze(
  [
    "/.well-known/oauth-authorization-server/api/auth",
    "/.well-known/openid-configuration/api/auth",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ] as const,
);

function requestId(
  candidate: string | undefined,
  create: () => string,
): string {
  if (candidate !== undefined && REQUEST_ID_PATTERN.test(candidate)) {
    return candidate.toLowerCase();
  }
  try {
    const generated = create();
    if (REQUEST_ID_PATTERN.test(generated)) return generated.toLowerCase();
    if (UUID_PATTERN.test(generated)) return `req_${generated.toLowerCase()}`;
  } catch {
    // Request correlation is best effort and must not reject an HTTP request.
  }
  return `req_${crypto.randomUUID()}`;
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
): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  const checkReadiness = dependencies.checkReadiness ??
    (() => Promise.resolve([]));
  const telemetry = dependencies.telemetry ?? createRelayTelemetry({
    instrumentationName: "relay-api",
    instrumentationVersion: config.build.version,
  });
  const logger = dependencies.logger ?? createJsonLogger();
  const createRequestId = dependencies.createRequestId ??
    (() => crypto.randomUUID());

  app.use("*", async (context, next) => {
    const id = requestId(context.req.header("x-request-id"), createRequestId);
    context.set("requestId", id);
    context.header("x-request-id", id);
    await next();
  });
  app.use("*", createHonoRouteEnrichment(telemetry));

  // Mounted before every application route per
  // docs/implementation-handoff/03-auth-workspaces.md "Server
  // configuration" -- Better Auth validates the HTTP method itself, so
  // this can't shadow a legitimate non-auth route under /api/auth/*.
  if (dependencies.auth) {
    const auth = dependencies.auth;
    const trustedProxyCidrs = dependencies.trustedProxyCidrs ??
      parseTrustedProxyCidrs(Deno.env.get("AUTH_TRUSTED_PROXY_CIDRS"));
    const handleAuth = (context: Context<ApiEnvironment>) =>
      auth.handler(context.req.raw, {
        remoteAddress: remoteAddressFromEnvironment(context.env),
        trustedProxyCidrs,
      });

    app.all("/api/auth/*", handleAuth);
    for (const path of AUTH_METADATA_PATHS) app.all(path, handleAuth);
  }

  if (dependencies.publicChangelog) {
    app.route("/", createPublicChangelogRoutes(dependencies.publicChangelog));
  }

  if (dependencies.adminChangelog) {
    app.route("/", createAdminChangelogRoutes(dependencies.adminChangelog));
  }

  if (dependencies.adminAccess) {
    app.route("/", createSuperadminAccessRoutes(dependencies.adminAccess));
  }
  if (dependencies.adminAllowances) {
    app.route("/", createAdminAllowanceRoutes(dependencies.adminAllowances));
  }
  if (dependencies.adminCapacity) {
    app.route("/", createAdminCapacityRoutes(dependencies.adminCapacity));
  }

  if (dependencies.v1) {
    app.route("/", createV1Routes(dependencies.v1));
  }

  if (dependencies.mcp) {
    const mcp = dependencies.mcp;
    const trustedProxyCidrs = dependencies.trustedProxyCidrs ??
      parseTrustedProxyCidrs(Deno.env.get("AUTH_TRUSTED_PROXY_CIDRS"));
    app.all("/mcp", (context) =>
      mcp.fetch(context.req.raw, {
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
    logger.error({
      eventName: "http.request.failed",
      message: "HTTP request failed",
      operation: "request",
      outcome: "failure",
      error,
      httpRoute: context.req.routePath,
      requestId: context.get("requestId"),
    });
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
