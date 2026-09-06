import { assertEquals } from "@std/assert";
import type { Auth } from "@relay/auth";
import {
  adminChangelogReleasePath,
  errorEnvelopeSchema,
  HTTP_PATHS,
} from "@relay/contracts";
import {
  createJsonLogger,
  type LogRecord,
  type TelemetryAttributes,
} from "@relay/observability";
import {
  AUTH_METADATA_PATHS,
  createApp,
  type RelayMcpHttpHandler,
} from "./app.ts";
import {
  ADMIN_CAPACITY_POLICIES_PATH,
  type AdminCapacityService,
  type AdminChangelogService,
  type PublicChangelogReader,
} from "./routes/mod.ts";
import {
  AUTHENTICATED_IDENTITY,
  createStubServices,
} from "./routes/test_support.ts";

const config = {
  appName: "Relay Test",
  port: 8000,
  build: {
    version: "test",
    revision: "test-revision",
  },
  database: {
    url: new URL("postgres://test:test@localhost:5432/relay_test"),
    poolMax: 10,
    connectTimeoutMs: 5_000,
    statementTimeoutMs: 30_000,
  },
  redis: {
    url: new URL("redis://test:test@localhost:6379"),
    connectTimeoutMs: 5_000,
  },
} as const;

Deno.test("liveness reports build information", async () => {
  const response = await createApp(config).request("/health/live");

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    service: "api",
    status: "ok",
    build: config.build,
  });
});

Deno.test("version endpoint reports the running build", async () => {
  const response = await createApp(config).request("/version");

  assertEquals(response.status, 200);
  assertEquals(await response.json(), config.build);
});

Deno.test("unknown routes return the API error envelope", async () => {
  const response = await createApp(config).request("/missing");

  assertEquals(response.status, 404);
  assertEquals(await response.json(), {
    error: {
      code: "not_found",
      message: "The requested resource was not found.",
    },
  });
});

Deno.test("readiness reports ok with no configured checks", async () => {
  const response = await createApp(config).request("/health/ready");

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    service: "api",
    status: "ok",
    checks: [],
    build: config.build,
  });
});

Deno.test("readiness returns 503 when a dependency check fails", async () => {
  const app = createApp(config, {
    checkReadiness: () =>
      Promise.resolve([{
        name: "database",
        status: "error" as const,
        message: "unreachable",
      }]),
  });
  const response = await app.request("/health/ready");

  assertEquals(response.status, 503);
  assertEquals(await response.json(), {
    service: "api",
    status: "degraded",
    checks: [{ name: "database", status: "error", message: "unreachable" }],
    build: config.build,
  });
});

Deno.test("readiness returns ok when every dependency check passes", async () => {
  const app = createApp(config, {
    checkReadiness: () =>
      Promise.resolve([{ name: "database", status: "ok" as const }]),
  });
  const response = await app.request("/health/ready");

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    service: "api",
    status: "ok",
    checks: [{ name: "database", status: "ok" }],
    build: config.build,
  });
});

Deno.test("request IDs are correlated without becoming metric labels", async () => {
  const requestId = "req_550e8400-e29b-41d4-a716-446655440000";
  let metricAttributes: TelemetryAttributes | undefined;
  let spanAttributes: TelemetryAttributes | undefined;
  const telemetry = {
    histogram() {
      return {
        record(_value: number, attributes?: TelemetryAttributes) {
          metricAttributes = attributes;
        },
      };
    },
    enrichActiveSpan(enrichment: { attributes?: TelemetryAttributes }) {
      spanAttributes = enrichment.attributes;
    },
  };
  const response = await createApp(config, { telemetry }).request(
    "/health/live",
    { headers: { "x-request-id": requestId } },
  );

  assertEquals(response.headers.get("x-request-id"), requestId);
  assertEquals(metricAttributes, {
    "http.route": "/health/live",
    "http.request.method": "GET",
    "http.response.status_class": "2xx",
  });
  assertEquals(spanAttributes, metricAttributes);
  assertEquals(
    "request.id" in (metricAttributes as Record<string, unknown>),
    false,
  );
});

Deno.test("versioned application routes mount into the running app", async () => {
  const response = await createApp(config, {
    v1: {
      services: createStubServices(),
      resolveIdentity: AUTHENTICATED_IDENTITY,
    },
  }).request("/api/v1/tools");

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    kind: "ok",
    items: [],
    nextCursor: null,
  });
});

Deno.test("public changelog routes mount independently of application services", async () => {
  const reader: PublicChangelogReader = {
    list: () => Promise.resolve({ entries: [], nextCursor: null }),
    getBySlug: () => Promise.resolve(null),
  };
  const response = await createApp(config, {
    publicChangelog: { reader },
  }).request("/api/v1/changelog");

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { entries: [], nextCursor: null });
});

Deno.test("admin changelog routes mount independently of application services", async () => {
  const auth = {
    api: {
      getSession: () =>
        Promise.resolve({
          session: {
            id: "session-admin-0001",
            userId: "user-admin-0001",
            createdAt: new Date("2026-08-25T10:00:00.000Z"),
          },
          user: {
            id: "user-admin-0001",
            email: "admin@relay.test",
            name: "Relay Admin",
          },
        }),
    },
  } as unknown as Auth;
  const service: AdminChangelogService = {
    list: () => Promise.resolve({ kind: "ok", value: [] }),
    get: () => Promise.resolve({ kind: "not_found" }),
    create: () => Promise.resolve({ kind: "denied", replayed: false }),
    revise: () => Promise.resolve({ kind: "denied", replayed: false }),
    publish: () => Promise.resolve({ kind: "denied", replayed: false }),
    unpublish: () => Promise.resolve({ kind: "denied", replayed: false }),
  };
  const capacityService: AdminCapacityService = {
    list: () => Promise.resolve({ kind: "ok", value: [] }),
    get: () => Promise.resolve({ kind: "not_found" }),
    revise: () => Promise.resolve({ kind: "denied", replayed: false }),
  };
  const app = createApp(config, {
    publicChangelog: {
      reader: {
        list: () => Promise.resolve({ entries: [], nextCursor: null }),
        getBySlug: () => Promise.resolve(null),
      },
    },
    adminChangelog: {
      auth,
      service,
      allowedOrigins: ["https://console.relay.test"],
    },
    adminCapacity: {
      auth,
      service: capacityService,
      allowedOrigins: ["https://console.relay.test"],
    },
    v1: {
      services: createStubServices(),
      resolveIdentity: AUTHENTICATED_IDENTITY,
    },
  });
  const response = await app.request(HTTP_PATHS.adminChangelog);

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { releases: [] });
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(response.headers.has("x-request-id"), true);
  assertEquals((await app.request("/health/live")).status, 200);
  assertEquals((await app.request("/api/v1/changelog")).status, 200);
  assertEquals((await app.request("/api/v1/tools")).status, 200);
  const capacityResponse = await app.request(ADMIN_CAPACITY_POLICIES_PATH);
  assertEquals(capacityResponse.status, 200);
  assertEquals(await capacityResponse.json(), { policies: [] });

  for (
    const request of [
      new Request(`http://localhost${adminChangelogReleasePath("42")}`, {
        method: "DELETE",
      }),
      new Request(
        `http://localhost${adminChangelogReleasePath("42")}/revisions`,
      ),
    ]
  ) {
    const unsupported = await app.request(request);
    assertEquals(unsupported.status, 404);
    assertEquals(
      errorEnvelopeSchema.parse(await unsupported.json()).error.code,
      "not_found",
    );
    assertEquals(unsupported.headers.get("cache-control"), "no-store");
    assertEquals(unsupported.headers.has("x-request-id"), true);
  }
});

Deno.test("exact OAuth metadata aliases are forwarded to Better Auth", async () => {
  const seen: string[] = [];
  const auth = {
    handler(request: Request) {
      seen.push(new URL(request.url).pathname);
      return Response.json({ path: new URL(request.url).pathname });
    },
  } as unknown as Auth;
  const app = createApp(config, { auth, trustedProxyCidrs: [] });

  for (const path of AUTH_METADATA_PATHS) {
    const response = await app.request(path);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { path });
  }
  assertEquals(seen, [...AUTH_METADATA_PATHS]);
});

Deno.test("the exact MCP path delegates every method to its boundary", async () => {
  const seen: string[] = [];
  const mcp: RelayMcpHttpHandler = {
    fetch(request) {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      return Promise.resolve(new Response(null, { status: 202 }));
    },
    close: () => Promise.resolve(),
  };
  const app = createApp(config, { mcp, trustedProxyCidrs: [] });

  assertEquals((await app.request("/mcp", { method: "POST" })).status, 202);
  assertEquals((await app.request("/mcp", { method: "GET" })).status, 202);
  assertEquals((await app.request("/mcp/", { method: "POST" })).status, 404);
  assertEquals(seen, ["POST /mcp", "GET /mcp"]);
});

Deno.test("API failures use redacted JSON logs with request correlation", async () => {
  const lines: string[] = [];
  const requestId = "req_018f47a2-6e6f-7e6e-8e5f-9fbdd378a421";
  const secret = "Bearer request-error-secret-canary";
  const logger = createJsonLogger({
    sink: { write: (line) => lines.push(line) },
    traceContext: () => ({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    }),
  });
  const response = await createApp(config, {
    logger,
    checkReadiness: () => Promise.reject(new Error(secret)),
  }).request("/health/ready", {
    headers: { "x-request-id": requestId },
  });

  assertEquals(response.status, 500);
  assertEquals(response.headers.get("x-request-id"), requestId);
  assertEquals(lines.length, 1);
  const record = JSON.parse(lines[0]) as LogRecord;
  assertEquals(record["event.name"], "http.request.failed");
  assertEquals(record["request.id"], requestId);
  assertEquals(record.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
  assertEquals(lines[0].includes(secret), false);
  assertEquals(lines[0].includes("stack"), false);
});
