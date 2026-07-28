import { assertEquals } from "@std/assert";
import { createApp } from "./app.ts";

const config = {
  appName: "Project S Test",
  port: 8000,
  build: {
    version: "test",
    revision: "test-revision",
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
