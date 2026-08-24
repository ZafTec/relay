import { assertEquals } from "@std/assert";
import {
  createJsonLogger,
  type LogRecord,
  type TelemetryAttributes,
} from "@relay/observability";
import { createApp } from "./app.ts";

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
