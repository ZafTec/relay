import {
  assertAlmostEquals,
  assertEquals,
  assertStrictEquals,
} from "@std/assert";
import { createHonoRouteEnrichment } from "./hono.ts";
import type {
  ActiveSpanEnrichment,
  RelayHistogramMetricName,
  SafeHistogram,
} from "./telemetry.ts";
import type { TelemetryAttributes } from "./attributes.ts";

class FakeTelemetry {
  enrichment: ActiveSpanEnrichment | undefined;
  duration: { value: number; attributes?: TelemetryAttributes } | undefined;

  histogram(_name: RelayHistogramMetricName): SafeHistogram {
    return {
      record: (value, attributes) => {
        this.duration = { value, attributes };
      },
    };
  }

  enrichActiveSpan(enrichment: ActiveSpanEnrichment): void {
    this.enrichment = enrichment;
  }
}

Deno.test("Hono enrichment uses the matched route template", async () => {
  const telemetry = new FakeTelemetry();
  const times = [1_000, 1_250];
  const middleware = createHonoRouteEnrichment(telemetry, {
    clock: () => times.shift() ?? 1_250,
  });

  await middleware({
    req: { method: "get", routePath: "/api/v1/runs/:runId" },
    res: { status: 201 },
  }, () => Promise.resolve());

  assertEquals(telemetry.enrichment?.name, "GET /api/v1/runs/:runId");
  assertEquals(telemetry.enrichment?.attributes, {
    "http.route": "/api/v1/runs/:runId",
    "http.request.method": "GET",
    "http.response.status_class": "2xx",
  });
  assertAlmostEquals(telemetry.duration?.value ?? -1, 0.25);
});

Deno.test("Hono enrichment preserves business errors and sanitizes telemetry", async () => {
  const telemetry = new FakeTelemetry();
  const middleware = createHonoRouteEnrichment(telemetry);
  const businessError = new Error("Bearer private-error-canary");
  let caught: unknown;

  try {
    await middleware({
      req: {
        method: "POST",
        routePath: "/runs/550e8400-e29b-41d4-a716-446655440000",
      },
    }, () => Promise.reject(businessError));
  } catch (error) {
    caught = error;
  }

  assertStrictEquals(caught, businessError);
  assertEquals(telemetry.enrichment?.name, "POST /__unknown__");
  assertEquals(telemetry.enrichment?.markError, true);
  assertEquals(telemetry.enrichment?.errorType, "internal");
});

Deno.test("Hono enrichment marks 5xx without inventing an exception", async () => {
  const telemetry = new FakeTelemetry();
  const middleware = createHonoRouteEnrichment(telemetry);

  await middleware({
    req: { method: "QUERY", routePath: "/api/v1/search" },
    res: { status: 503 },
  }, () => Promise.resolve());

  assertEquals(telemetry.enrichment?.name, "QUERY /api/v1/search");
  assertEquals(telemetry.enrichment?.markError, true);
  assertEquals(telemetry.enrichment?.errorType, "internal");
  assertEquals(
    Object.prototype.hasOwnProperty.call(telemetry.enrichment, "error"),
    false,
  );
});

Deno.test("Hono enrichment uses HTTP for unknown methods", async () => {
  const telemetry = new FakeTelemetry();
  const middleware = createHonoRouteEnrichment(telemetry);

  await middleware({
    req: { method: "CUSTOM", routePath: "/health/live" },
    res: { status: 200 },
  }, () => Promise.resolve());

  assertEquals(telemetry.enrichment?.name, "HTTP /health/live");
  assertEquals(
    telemetry.enrichment?.attributes?.["http.request.method"],
    "_OTHER",
  );
});

Deno.test("Hono telemetry failures do not fail a successful route", async () => {
  const middleware = createHonoRouteEnrichment({
    histogram() {
      return {
        record() {
          throw new Error("metric failure");
        },
      };
    },
    enrichActiveSpan() {
      throw new Error("span failure");
    },
  } as never);
  let completed = false;
  await middleware(
    { req: { method: "GET", routePath: "/health/live" }, res: { status: 200 } },
    () => {
      completed = true;
      return Promise.resolve();
    },
  );
  assertEquals(completed, true);
});
