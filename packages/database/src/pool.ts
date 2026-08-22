import pg from "pg";
import type { DatabaseConfig } from "@relay/config";

export type DatabasePool = InstanceType<typeof pg.Pool>;

export type ProcessName =
  | "relay-api"
  | "relay-worker"
  | "relay-migrate"
  | "relay-healthcheck";

/**
 * One pool per process. Pool lifetime belongs to process bootstrap;
 * feature packages never call `pool.end()` themselves.
 */
export function createDatabasePool(
  config: DatabaseConfig,
  processName: ProcessName,
): DatabasePool {
  return new pg.Pool({
    connectionString: config.url.toString(),
    max: config.poolMax,
    connectionTimeoutMillis: config.connectTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    application_name: processName,
  });
}
