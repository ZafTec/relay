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

export type ConfigEnvironment = "development" | "test" | "production";

type ConfigEnv = Record<string, string | undefined>;

export interface RuntimeConfig {
  readonly appName: string;
  readonly port: number;
  /** Present on loaded runtime config; optional for injected test configurations. */
  readonly deploymentEnvironment?: string;
  readonly build: BuildInfo;
  readonly database: DatabaseConfig;
  readonly redis: RedisConfig;
}

/** Validates native OTel settings only when the Deno provider is enabled. */
export function loadEnabledObservabilityConfig(
  env?: ConfigEnv,
): ObservabilityConfig | null {
  if (env !== undefined) {
    return env.OTEL_DENO === "true" ? loadObservabilityConfig(env) : null;
  }

  return Deno.env.get("OTEL_DENO") === "true"
    ? loadObservabilityConfig()
    : null;
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
const DEPLOYMENT_ENVIRONMENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;

const AUTH_ENVIRONMENT_VARIABLES = [
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "AUTH_TRUSTED_ORIGINS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const;
const BUILD_ENVIRONMENT_VARIABLES = ["APP_VERSION", "GIT_SHA"] as const;
const DATABASE_ENVIRONMENT_VARIABLES = [
  "DATABASE_URL",
  "DATABASE_POOL_MAX",
  "DATABASE_CONNECT_TIMEOUT_MS",
  "DATABASE_STATEMENT_TIMEOUT_MS",
] as const;
const RUNTIME_ENVIRONMENT_VARIABLES = [
  "APP_NAME",
  "PORT",
  "APP_ENV",
  "DEPLOYMENT_ENVIRONMENT_NAME",
  ...BUILD_ENVIRONMENT_VARIABLES,
  ...DATABASE_ENVIRONMENT_VARIABLES,
  "REDIS_URL",
  "REDIS_CONNECT_TIMEOUT_MS",
] as const;

function readProcessEnvironment(names: readonly string[]): ConfigEnv {
  const env: ConfigEnv = {};
  for (const name of names) env[name] = Deno.env.get(name);
  return env;
}

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
  env: ConfigEnv = readProcessEnvironment(AUTH_ENVIRONMENT_VARIABLES),
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
  env: ConfigEnv = readProcessEnvironment(BUILD_ENVIRONMENT_VARIABLES),
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
  env: ConfigEnv = readProcessEnvironment(DATABASE_ENVIRONMENT_VARIABLES),
): DatabaseConfig {
  return readDatabaseConfig(env);
}

export function loadRuntimeConfig(
  env: ConfigEnv = readProcessEnvironment(RUNTIME_ENVIRONMENT_VARIABLES),
): RuntimeConfig {
  return {
    appName: env.APP_NAME?.trim() || "Relay",
    port: readPort(env.PORT),
    deploymentEnvironment: readDeploymentEnvironment(env),
    build: loadBuildInfo(env),
    database: loadDatabaseConfig(env),
    redis: readRedisConfig(env),
  };
}

export type S3ConfigScope = "api" | "worker";

export interface S3ConfigLoaderOptions {
  readonly environment?: ConfigEnvironment;
  readonly scope?: S3ConfigScope;
}

export interface S3Config {
  readonly bucket: string;
  readonly region: string;
  readonly credentials: Readonly<{
    accessKeyId: string;
    secretAccessKey: string;
  }>;
  readonly internalEndpoint: URL;
  readonly publicSigningEndpoint?: URL;
  readonly forcePathStyle: true;
  readonly bucketVersioning: "enabled";
  readonly requestTimeoutMs: number;
}

export interface ApiS3Config extends S3Config {
  readonly publicSigningEndpoint: URL;
}

export interface ArtifactLifecycleConfig {
  readonly workspaceMaxBytes: number;
  readonly maxUploadBytes: number;
  readonly uploadTtlSeconds: number;
  readonly downloadTtlSeconds: number;
  readonly purgeDelaySeconds: number;
  readonly cleanupLeaseSeconds: number;
  readonly maintenanceIntervalMs: number;
  readonly maintenanceBatchSize: number;
}

export interface ShareTokenSigningKeyConfig {
  readonly version: number;
  readonly secret: Uint8Array;
}

export interface ShareTokenKeyringConfig {
  readonly activeVersion: number;
  readonly keys: readonly ShareTokenSigningKeyConfig[];
}

export interface AzureProviderConfig {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxBase64Bytes: number;
}

const DEFAULT_S3_REGION = "us-east-1";
const DEFAULT_S3_REQUEST_TIMEOUT_MS = 30_000;
const MAX_S3_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_ARTIFACT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_ARTIFACT_UPLOAD_TTL_SECONDS = 15 * 60;
const DEFAULT_ARTIFACT_DOWNLOAD_TTL_SECONDS = 5 * 60;
const MAX_ARTIFACT_SIGNING_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_ARTIFACT_PURGE_DELAY_SECONDS = 7 * 24 * 60 * 60;
const MAX_ARTIFACT_PURGE_DELAY_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_ARTIFACT_CLEANUP_LEASE_SECONDS = 60;
const MAX_ARTIFACT_CLEANUP_LEASE_SECONDS = 24 * 60 * 60;
const DEFAULT_ARTIFACT_MAINTENANCE_INTERVAL_MS = 30_000;
const MAX_ARTIFACT_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_ARTIFACT_MAINTENANCE_BATCH_SIZE = 100;
const MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE = 100;
const MAX_SHARE_TOKEN_KEY_VERSION = 2_147_483_647;
const MIN_SHARE_TOKEN_SECRET_BYTES = 32;
const MAX_SHARE_TOKEN_SECRET_TEXT_LENGTH = 8_192;
const DEFAULT_AZURE_TIMEOUT_MS = 120_000;
const MAX_AZURE_TIMEOUT_MS = 300_000;
const DEFAULT_AZURE_MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
const MAX_AZURE_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const DEFAULT_AZURE_MAX_BASE64_BYTES = 64 * 1024 * 1024;
const MAX_AZURE_MAX_BASE64_BYTES = 64 * 1024 * 1024;

const S3_ENVIRONMENT_VARIABLES = [
  "APP_ENV",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "S3_BUCKET_VERSIONING",
  "S3_REQUEST_TIMEOUT_MS",
] as const;
const API_S3_ENVIRONMENT_VARIABLES = [
  ...S3_ENVIRONMENT_VARIABLES,
  "S3_PUBLIC_ENDPOINT",
] as const;
const ARTIFACT_ENVIRONMENT_VARIABLES = [
  "ARTIFACT_WORKSPACE_MAX_BYTES",
  "ARTIFACT_MAX_UPLOAD_BYTES",
  "ARTIFACT_UPLOAD_TTL_SECONDS",
  "ARTIFACT_DOWNLOAD_TTL_SECONDS",
  "ARTIFACT_PURGE_DELAY_SECONDS",
  "ARTIFACT_CLEANUP_LEASE_SECONDS",
  "ARTIFACT_MAINTENANCE_INTERVAL_MS",
  "ARTIFACT_MAINTENANCE_BATCH_SIZE",
] as const;
const SHARE_TOKEN_ENVIRONMENT_VARIABLES = [
  "SHARE_TOKEN_ACTIVE_VERSION",
  "SHARE_TOKEN_KEYS",
] as const;
const AZURE_ENVIRONMENT_VARIABLES = [
  "AZURE_API_KEY",
  "AZURE_REQUEST_TIMEOUT_MS",
  "AZURE_MAX_RESPONSE_BYTES",
  "AZURE_MAX_OUTPUT_BYTES",
] as const;

function readConfigInteger(
  name: string,
  value: string | undefined,
  options: {
    readonly fallback?: number;
    readonly min: number;
    readonly max: number;
  },
): number {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") {
    if (options.fallback !== undefined) return options.fallback;
    throw new Error(`${name} is required`);
  }

  const parsed = Number(normalized);
  if (
    !Number.isSafeInteger(parsed) || parsed < options.min ||
    parsed > options.max
  ) {
    throw new Error(
      `${name} must be an integer between ${options.min} and ${options.max}`,
    );
  }
  return parsed;
}

function readConfigEnvironment(
  env: ConfigEnv,
  explicit: ConfigEnvironment | undefined,
): ConfigEnvironment {
  const value = (explicit ?? env.APP_ENV?.trim()) || "development";
  if (value !== "development" && value !== "test" && value !== "production") {
    throw new Error(
      `${
        explicit === undefined ? "APP_ENV" : "environment"
      } must be development, test, or production`,
    );
  }
  return value;
}

function readDeploymentEnvironment(env: ConfigEnv): string {
  const appEnvironment = readConfigEnvironment(env, undefined);
  const value = env.DEPLOYMENT_ENVIRONMENT_NAME?.trim();
  if (value === undefined || value === "") {
    if (appEnvironment === "production") {
      throw new Error("DEPLOYMENT_ENVIRONMENT_NAME is required in production");
    }
    return appEnvironment;
  }
  if (!DEPLOYMENT_ENVIRONMENT_NAME_PATTERN.test(value)) {
    throw new Error("DEPLOYMENT_ENVIRONMENT_NAME has an invalid format");
  }
  return value;
}

function isSafeHttpHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    host === "localhost" || host === "::1" || host.endsWith(".localhost") ||
    host.endsWith(".internal") || host.endsWith(".local") ||
    host.endsWith(".svc") || host.endsWith(".cluster.local") ||
    !host.includes(".")
  ) {
    return true;
  }

  const parts = host.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part))) {
    const octets = parts.map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    const [first, second] = octets;
    return first === 10 || first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168);
  }

  return /^(?:fc|fd|fe[89ab])/u.test(host);
}

function readS3Endpoint(
  name: "S3_ENDPOINT" | "S3_PUBLIC_ENDPOINT",
  value: string | undefined,
  environment: ConfigEnvironment,
  publicSigningEndpoint: boolean,
): URL {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (
    endpoint.username !== "" || endpoint.password !== "" ||
    endpoint.search !== "" || endpoint.hash !== ""
  ) {
    throw new Error(`${name} must not contain credentials, query, or fragment`);
  }
  if (
    publicSigningEndpoint && environment === "production" &&
    endpoint.protocol !== "https:"
  ) {
    throw new Error(`${name} must use HTTPS in production`);
  }
  if (endpoint.protocol === "http:" && !isSafeHttpHostname(endpoint.hostname)) {
    throw new Error(
      `${name} may use HTTP only for a loopback or internal host`,
    );
  }
  return endpoint;
}

function readFixedConfigValue(
  name: string,
  value: string | undefined,
  expected: string,
): void {
  const normalized = value?.trim();
  if (
    normalized !== undefined && normalized !== "" && normalized !== expected
  ) {
    throw new Error(`${name} must be ${expected}`);
  }
}

/**
 * Loads S3-compatible storage independently from generic runtime configuration.
 * API scope requires the browser-facing signing endpoint; worker scope does not.
 */
export function loadS3Config(
  env: ConfigEnv | undefined = undefined,
  options: S3ConfigLoaderOptions | ConfigEnvironment = {},
): S3Config {
  const normalizedOptions: S3ConfigLoaderOptions = typeof options === "string"
    ? { environment: options }
    : options;
  const scope = normalizedOptions.scope ?? "api";
  if (scope !== "api" && scope !== "worker") {
    throw new Error("scope must be api or worker");
  }
  const source = env ?? readProcessEnvironment(
    scope === "api" ? API_S3_ENVIRONMENT_VARIABLES : S3_ENVIRONMENT_VARIABLES,
  );
  const environment = readConfigEnvironment(
    source,
    normalizedOptions.environment,
  );
  const internalEndpoint = readS3Endpoint(
    "S3_ENDPOINT",
    source.S3_ENDPOINT,
    environment,
    false,
  );
  const publicSigningEndpoint = scope === "api"
    ? readS3Endpoint(
      "S3_PUBLIC_ENDPOINT",
      source.S3_PUBLIC_ENDPOINT,
      environment,
      true,
    )
    : undefined;

  readFixedConfigValue(
    "S3_FORCE_PATH_STYLE",
    source.S3_FORCE_PATH_STYLE,
    "true",
  );
  readFixedConfigValue(
    "S3_BUCKET_VERSIONING",
    source.S3_BUCKET_VERSIONING,
    "enabled",
  );

  const bucket = readNonEmpty("S3_BUCKET", source.S3_BUCKET).trim();
  const accessKeyId = readNonEmpty(
    "S3_ACCESS_KEY_ID",
    source.S3_ACCESS_KEY_ID,
  );
  const secretAccessKey = readNonEmpty(
    "S3_SECRET_ACCESS_KEY",
    source.S3_SECRET_ACCESS_KEY,
  );
  const config: S3Config = {
    bucket,
    region: source.S3_REGION?.trim() || DEFAULT_S3_REGION,
    credentials: Object.freeze({ accessKeyId, secretAccessKey }),
    internalEndpoint,
    forcePathStyle: true,
    bucketVersioning: "enabled",
    requestTimeoutMs: readConfigInteger(
      "S3_REQUEST_TIMEOUT_MS",
      source.S3_REQUEST_TIMEOUT_MS,
      {
        fallback: DEFAULT_S3_REQUEST_TIMEOUT_MS,
        min: 1,
        max: MAX_S3_REQUEST_TIMEOUT_MS,
      },
    ),
  };
  return Object.freeze(
    publicSigningEndpoint === undefined
      ? config
      : { ...config, publicSigningEndpoint },
  );
}

export function loadApiS3Config(
  env?: ConfigEnv,
  environment?: ConfigEnvironment,
): ApiS3Config {
  return loadS3Config(env, { environment, scope: "api" }) as ApiS3Config;
}

export function loadWorkerS3Config(
  env?: ConfigEnv,
  environment?: ConfigEnvironment,
): S3Config {
  return loadS3Config(env, { environment, scope: "worker" });
}

/** Loads byte, TTL, purge, and maintenance limits used by artifact processes. */
export function loadArtifactLifecycleConfig(
  env: ConfigEnv = readProcessEnvironment(ARTIFACT_ENVIRONMENT_VARIABLES),
): ArtifactLifecycleConfig {
  const workspaceMaxBytes = readConfigInteger(
    "ARTIFACT_WORKSPACE_MAX_BYTES",
    env.ARTIFACT_WORKSPACE_MAX_BYTES,
    { min: 1, max: Number.MAX_SAFE_INTEGER },
  );
  const maxUploadBytes = readConfigInteger(
    "ARTIFACT_MAX_UPLOAD_BYTES",
    env.ARTIFACT_MAX_UPLOAD_BYTES,
    {
      fallback: Math.min(workspaceMaxBytes, DEFAULT_ARTIFACT_MAX_UPLOAD_BYTES),
      min: 1,
      max: Math.min(workspaceMaxBytes, MAX_ARTIFACT_UPLOAD_BYTES),
    },
  );

  return Object.freeze({
    workspaceMaxBytes,
    maxUploadBytes,
    uploadTtlSeconds: readConfigInteger(
      "ARTIFACT_UPLOAD_TTL_SECONDS",
      env.ARTIFACT_UPLOAD_TTL_SECONDS,
      {
        fallback: DEFAULT_ARTIFACT_UPLOAD_TTL_SECONDS,
        min: 1,
        max: MAX_ARTIFACT_SIGNING_TTL_SECONDS,
      },
    ),
    downloadTtlSeconds: readConfigInteger(
      "ARTIFACT_DOWNLOAD_TTL_SECONDS",
      env.ARTIFACT_DOWNLOAD_TTL_SECONDS,
      {
        fallback: DEFAULT_ARTIFACT_DOWNLOAD_TTL_SECONDS,
        min: 1,
        max: MAX_ARTIFACT_SIGNING_TTL_SECONDS,
      },
    ),
    purgeDelaySeconds: readConfigInteger(
      "ARTIFACT_PURGE_DELAY_SECONDS",
      env.ARTIFACT_PURGE_DELAY_SECONDS,
      {
        fallback: DEFAULT_ARTIFACT_PURGE_DELAY_SECONDS,
        min: 1,
        max: MAX_ARTIFACT_PURGE_DELAY_SECONDS,
      },
    ),
    cleanupLeaseSeconds: readConfigInteger(
      "ARTIFACT_CLEANUP_LEASE_SECONDS",
      env.ARTIFACT_CLEANUP_LEASE_SECONDS,
      {
        fallback: DEFAULT_ARTIFACT_CLEANUP_LEASE_SECONDS,
        min: 1,
        max: MAX_ARTIFACT_CLEANUP_LEASE_SECONDS,
      },
    ),
    maintenanceIntervalMs: readConfigInteger(
      "ARTIFACT_MAINTENANCE_INTERVAL_MS",
      env.ARTIFACT_MAINTENANCE_INTERVAL_MS,
      {
        fallback: DEFAULT_ARTIFACT_MAINTENANCE_INTERVAL_MS,
        min: 1,
        max: MAX_ARTIFACT_MAINTENANCE_INTERVAL_MS,
      },
    ),
    maintenanceBatchSize: readConfigInteger(
      "ARTIFACT_MAINTENANCE_BATCH_SIZE",
      env.ARTIFACT_MAINTENANCE_BATCH_SIZE,
      {
        fallback: DEFAULT_ARTIFACT_MAINTENANCE_BATCH_SIZE,
        min: 1,
        max: MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE,
      },
    ),
  });
}

function base64WithoutPadding(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/u, "");
}

function decodeShareTokenSecret(
  value: unknown,
  variableName: string,
): Uint8Array {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > MAX_SHARE_TOKEN_SECRET_TEXT_LENGTH
  ) {
    throw new Error(`${variableName} must contain base64 or base64url secrets`);
  }

  const standard = /^[A-Za-z0-9+/]+={0,2}$/u.test(value);
  const urlSafe = /^[A-Za-z0-9_-]+={0,2}$/u.test(value);
  if ((!standard && !urlSafe) || value.length % 4 === 1) {
    throw new Error(`${variableName} must contain base64 or base64url secrets`);
  }

  const unpadded = value.replace(/=+$/u, "");
  if (value.includes("=") && value.length % 4 !== 0) {
    throw new Error(`${variableName} must contain base64 or base64url secrets`);
  }
  const normalized = unpadded.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(normalized + padding);
  } catch {
    throw new Error(`${variableName} must contain base64 or base64url secrets`);
  }
  const secret = Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  );
  if (base64WithoutPadding(secret) !== normalized) {
    throw new Error(`${variableName} must contain base64 or base64url secrets`);
  }
  if (secret.byteLength < MIN_SHARE_TOKEN_SECRET_BYTES) {
    throw new Error(
      `${variableName} secrets must decode to at least ${MIN_SHARE_TOKEN_SECRET_BYTES} bytes`,
    );
  }
  return secret;
}

/** Loads API-only HMAC keys in the shape expected by the share-token codec. */
export function loadShareTokenKeyringConfig(
  env: ConfigEnv = readProcessEnvironment(SHARE_TOKEN_ENVIRONMENT_VARIABLES),
): ShareTokenKeyringConfig {
  const activeVersion = readConfigInteger(
    "SHARE_TOKEN_ACTIVE_VERSION",
    env.SHARE_TOKEN_ACTIVE_VERSION,
    { min: 1, max: MAX_SHARE_TOKEN_KEY_VERSION },
  );
  const encoded = readNonEmpty("SHARE_TOKEN_KEYS", env.SHARE_TOKEN_KEYS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("SHARE_TOKEN_KEYS must be a JSON object");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SHARE_TOKEN_KEYS must be a JSON object");
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("SHARE_TOKEN_KEYS must contain at least one key");
  }
  const keys = entries.map(([rawVersion, rawSecret]) => {
    if (!/^[1-9][0-9]*$/u.test(rawVersion)) {
      throw new Error(
        "SHARE_TOKEN_KEYS keys must be positive integer versions",
      );
    }
    const version = readConfigInteger("SHARE_TOKEN_KEYS", rawVersion, {
      min: 1,
      max: MAX_SHARE_TOKEN_KEY_VERSION,
    });
    return Object.freeze({
      version,
      secret: decodeShareTokenSecret(rawSecret, "SHARE_TOKEN_KEYS"),
    });
  }).sort((left, right) => left.version - right.version);

  if (!keys.some((key) => key.version === activeVersion)) {
    throw new Error(
      "SHARE_TOKEN_ACTIVE_VERSION must identify a key in SHARE_TOKEN_KEYS",
    );
  }
  return Object.freeze({ activeVersion, keys: Object.freeze(keys) });
}

export const loadApiShareTokenKeyringConfig = loadShareTokenKeyringConfig;

/** Loads worker-only Azure credentials and limits; provider URLs stay fixed. */
export function loadAzureProviderConfig(
  env: ConfigEnv = readProcessEnvironment(AZURE_ENVIRONMENT_VARIABLES),
): AzureProviderConfig {
  const apiKey = readNonEmpty("AZURE_API_KEY", env.AZURE_API_KEY);
  if (apiKey.length > 4_096 || /[\r\n]/u.test(apiKey)) {
    throw new Error("AZURE_API_KEY has an invalid format");
  }

  return Object.freeze({
    apiKey,
    timeoutMs: readConfigInteger(
      "AZURE_REQUEST_TIMEOUT_MS",
      env.AZURE_REQUEST_TIMEOUT_MS,
      { fallback: DEFAULT_AZURE_TIMEOUT_MS, min: 1, max: MAX_AZURE_TIMEOUT_MS },
    ),
    maxResponseBytes: readConfigInteger(
      "AZURE_MAX_RESPONSE_BYTES",
      env.AZURE_MAX_RESPONSE_BYTES,
      {
        fallback: DEFAULT_AZURE_MAX_RESPONSE_BYTES,
        min: 1,
        max: MAX_AZURE_MAX_RESPONSE_BYTES,
      },
    ),
    maxBase64Bytes: readConfigInteger(
      "AZURE_MAX_OUTPUT_BYTES",
      env.AZURE_MAX_OUTPUT_BYTES,
      {
        fallback: DEFAULT_AZURE_MAX_BASE64_BYTES,
        min: 1,
        max: MAX_AZURE_MAX_BASE64_BYTES,
      },
    ),
  });
}

export const loadWorkerAzureProviderConfig = loadAzureProviderConfig;
