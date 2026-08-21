import { assertEquals, assertThrows } from "@std/assert";
import { loadAuthConfig, loadRuntimeConfig } from "./index.ts";

const validDatabaseEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/relay",
};

const validAuthEnv = {
  BETTER_AUTH_URL: "https://relay.zaftech.co",
  BETTER_AUTH_SECRET: "a".repeat(32),
  AUTH_TRUSTED_ORIGINS: "https://relay.zaftech.co, https://staging.example.com",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GITHUB_CLIENT_ID: "github-id",
  GITHUB_CLIENT_SECRET: "github-secret",
};

Deno.test("loadRuntimeConfig requires DATABASE_URL", () => {
  assertThrows(
    () => loadRuntimeConfig({}),
    Error,
    "DATABASE_URL is required",
  );
});

Deno.test("loadRuntimeConfig rejects a non-postgres DATABASE_URL scheme", () => {
  assertThrows(
    () => loadRuntimeConfig({ DATABASE_URL: "mysql://user:pass@localhost/db" }),
    Error,
    "postgres",
  );
});

Deno.test("loadRuntimeConfig never echoes DATABASE_URL contents in an error", () => {
  try {
    loadRuntimeConfig({ DATABASE_URL: "not a valid url" });
    throw new Error("expected loadRuntimeConfig to throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assertEquals(message.includes("not a valid url"), false);
  }
});

Deno.test("loadRuntimeConfig accepts a valid DATABASE_URL and applies defaults", () => {
  const config = loadRuntimeConfig(validDatabaseEnv);
  assertEquals(config.database.url.toString(), validDatabaseEnv.DATABASE_URL);
  assertEquals(config.database.poolMax, 10);
});

Deno.test("loadRuntimeConfig rejects an out-of-range DATABASE_POOL_MAX", () => {
  assertThrows(
    () => loadRuntimeConfig({ ...validDatabaseEnv, DATABASE_POOL_MAX: "0" }),
    Error,
    "DATABASE_POOL_MAX",
  );
});

Deno.test("loadAuthConfig requires BETTER_AUTH_SECRET to be at least 32 characters", () => {
  assertThrows(
    () => loadAuthConfig({ ...validAuthEnv, BETTER_AUTH_SECRET: "too-short" }),
    Error,
    "32 characters",
  );
});

Deno.test("loadAuthConfig requires every OAuth provider credential", () => {
  const { GOOGLE_CLIENT_SECRET: _drop, ...missingGoogleSecret } = validAuthEnv;
  assertThrows(
    () => loadAuthConfig(missingGoogleSecret),
    Error,
    "GOOGLE_CLIENT_SECRET",
  );
});

Deno.test("loadAuthConfig requires AUTH_TRUSTED_ORIGINS", () => {
  const { AUTH_TRUSTED_ORIGINS: _drop, ...missing } = validAuthEnv;
  assertThrows(
    () => loadAuthConfig(missing),
    Error,
    "AUTH_TRUSTED_ORIGINS",
  );
});

Deno.test("loadAuthConfig splits and trims comma-separated trusted origins", () => {
  const config = loadAuthConfig(validAuthEnv);
  assertEquals(config.trustedOrigins, [
    "https://relay.zaftech.co",
    "https://staging.example.com",
  ]);
});

Deno.test("loadAuthConfig accepts a fully valid environment", () => {
  const config = loadAuthConfig(validAuthEnv);
  assertEquals(config.baseUrl.toString(), "https://relay.zaftech.co/");
  assertEquals(config.google.clientId, "google-id");
  assertEquals(config.github.clientId, "github-id");
});
