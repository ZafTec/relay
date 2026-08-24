import type { BuildInfo } from "@relay/contracts";
import {
  loadObservabilityConfig,
  type ObservabilityConfig,
} from "@relay/observability";

export interface DatabaseConfig {
  readonly url: URL;
  readonly poolMax: number;
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface RedisConfig {
  readonly url: URL;
  readonly connectTimeoutMs: number;
}

export interface RuntimeConfig {
  readonly appName: string;
  readonly port: number;
  readonly build: BuildInfo;
  readonly database: DatabaseConfig;
  readonly redis: RedisConfig;
}

/** Validates native OTel settings only when the Deno provider is enabled. */
export function loadEnabledObservabilityConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): ObservabilityConfig | null {
  return env.OTEL_DENO === "true" ? loadObservabilityConfig(env) : null;
}

export interface OAuthProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface AuthConfig {
  readonly baseUrl: URL;
  readonly secret: string;
  readonly trustedOrigins: readonly string[];
  readonly google: OAuthProviderConfig;
  readonly github: OAuthProviderConfig;
}

const DEFAULT_PORT = 8000;
const DEFAULT_DATABASE_POOL_MAX = 10;
const DEFAULT_DATABASE_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS = 30_000;
/** Better Auth recommends at least 32 characters for `secret`. */
const MIN_AUTH_SECRET_LENGTH = 32;

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

function readRedisConfig(
  env: Record<string, string | undefined>,
): RedisConfig {
  const value = env.REDIS_URL;
  if (value === undefined || value.trim() === "") {
    throw new Error("REDIS_URL is required");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("REDIS_URL must be a valid URL");
  }

  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(
      `REDIS_URL must use the redis:// or rediss:// scheme; received ${url.protocol}`,
    );
  }

  return {
    url,
    connectTimeoutMs: readBoundedInt(
      "REDIS_CONNECT_TIMEOUT_MS",
      env.REDIS_CONNECT_TIMEOUT_MS,
      DEFAULT_DATABASE_CONNECT_TIMEOUT_MS,
      1,
      120_000,
    ),
  };
}

function readUrl(name: string, value: string | undefined): URL {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }

  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function readNonEmpty(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }

  return value;
}

function readOAuthProviderConfig(
  clientIdEnv: string,
  clientSecretEnv: string,
  env: Record<string, string | undefined>,
): OAuthProviderConfig {
  return {
    clientId: readNonEmpty(clientIdEnv, env[clientIdEnv]),
    clientSecret: readNonEmpty(clientSecretEnv, env[clientSecretEnv]),
  };
}

function readTrustedOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") {
    throw new Error("AUTH_TRUSTED_ORIGINS is required");
  }

  return value.split(",").map((origin) => origin.trim()).filter(Boolean);
}

/**
 * Auth is only meaningful to the API process, unlike DatabaseConfig -- worker
 * and migrate never need Google/GitHub secrets configured, so this is a
 * separate loader rather than a required field on RuntimeConfig.
 */
export function loadAuthConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): AuthConfig {
  const secret = readNonEmpty("BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET);
  if (secret.length < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters`,
    );
  }

  return {
    baseUrl: readUrl("BETTER_AUTH_URL", env.BETTER_AUTH_URL),
    secret,
    trustedOrigins: readTrustedOrigins(env.AUTH_TRUSTED_ORIGINS),
    google: readOAuthProviderConfig(
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      env,
    ),
    github: readOAuthProviderConfig(
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      env,
    ),
  };
}

export function loadBuildInfo(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): BuildInfo {
  return {
    version: env.APP_VERSION?.trim() || "development",
    revision: env.GIT_SHA?.trim() || "unknown",
  };
}

/**
 * Split out from `loadRuntimeConfig` for the same reason `loadAuthConfig`
 * is its own function: not every process needs every dependency
 * configured. `migrate up`/`migrate status` only ever touch PostgreSQL --
 * requiring REDIS_URL for them (as `loadRuntimeConfig` alone would) fails
 * a migration run in any environment that hasn't provisioned Redis yet,
 * for a dependency migration never uses.
 */
export function loadDatabaseConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): DatabaseConfig {
  return readDatabaseConfig(env);
}

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): RuntimeConfig {
  return {
    appName: env.APP_NAME?.trim() || "Relay",
    port: readPort(env.PORT),
    build: loadBuildInfo(env),
    database: loadDatabaseConfig(env),
    redis: readRedisConfig(env),
  };
}
