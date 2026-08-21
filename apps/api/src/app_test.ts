import { assertEquals } from "@std/assert";
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
