import type { BuildInfo } from "@relay/contracts";

export interface DatabaseConfig {
  readonly url: URL;
  readonly poolMax: number;
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface RuntimeConfig {
  readonly appName: string;
  readonly port: number;
  readonly build: BuildInfo;
  readonly database: DatabaseConfig;
}

const DEFAULT_PORT = 8000;
const DEFAULT_DATABASE_POOL_MAX = 10;
const DEFAULT_DATABASE_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS = 30_000;

function readPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `PORT must be an integer between 1 and 65535; received ${value}`,
    );
  }

  return port;
}

function readBoundedInt(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}; received ${value}`,
    );
  }

  return parsed;
}

function readDatabaseUrl(value: string | undefined): URL {
  if (value === undefined || value.trim() === "") {
    throw new Error("DATABASE_URL is required");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid URL");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      `DATABASE_URL must use the postgres:// or postgresql:// scheme; received ${url.protocol}`,
    );
  }

  return url;
}

function readDatabaseConfig(
  env: Record<string, string | undefined>,
): DatabaseConfig {
  return {
    url: readDatabaseUrl(env.DATABASE_URL),
    poolMax: readBoundedInt(
      "DATABASE_POOL_MAX",
      env.DATABASE_POOL_MAX,
      DEFAULT_DATABASE_POOL_MAX,
      1,
      100,
    ),
    connectTimeoutMs: readBoundedInt(
      "DATABASE_CONNECT_TIMEOUT_MS",
      env.DATABASE_CONNECT_TIMEOUT_MS,
      DEFAULT_DATABASE_CONNECT_TIMEOUT_MS,
      1,
      120_000,
    ),
    statementTimeoutMs: readBoundedInt(
      "DATABASE_STATEMENT_TIMEOUT_MS",
      env.DATABASE_STATEMENT_TIMEOUT_MS,
      DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS,
      1,
      600_000,
    ),
  };
}

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): RuntimeConfig {
  return {
    appName: env.APP_NAME?.trim() || "Relay",
    port: readPort(env.PORT),
    build: {
      version: env.APP_VERSION?.trim() || "development",
      revision: env.GIT_SHA?.trim() || "unknown",
    },
    database: readDatabaseConfig(env),
  };
}
