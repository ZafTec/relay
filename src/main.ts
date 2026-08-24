import { startApi } from "../apps/api/src/server.ts";
import { createExecutionHandlerRegistry, startWorker } from "@relay/worker";
import {
  loadBuildInfo,
  loadDatabaseConfig,
  loadEnabledObservabilityConfig,
} from "@relay/config";
import {
  checkDatabaseHealth,
  checkMigrationLedgerHealth,
  createDatabasePool,
  migrateStatus,
  migrateUp,
  MIGRATIONS,
} from "@relay/database";
import { createJsonLogger } from "@relay/observability";

const logger = createJsonLogger();

async function run(): Promise<void> {
  const [service, subcommand] = Deno.args;
  loadEnabledObservabilityConfig();

  switch (service) {
    case "api": {
      const server = startApi(undefined, { logger });
      await server.finished;
      break;
    }
    case "worker": {
      const handlers = createExecutionHandlerRegistry();
      await startWorker(undefined, { handlerRegistry: handlers, logger });
      break;
    }
    case "migrate": {
      if (subcommand !== "up" && subcommand !== "status") {
        logger.warn({
          eventName: "process.usage.invalid",
          message: "Usage: relay migrate <up|status>",
          operation: "migrate",
          outcome: "rejected",
        });
        Deno.exit(64);
      }

      // Database only -- migration never touches Redis, so this must not
      // require REDIS_URL the way loadRuntimeConfig() would (see
      // loadDatabaseConfig's doc comment in packages/config).
      const databaseConfig = loadDatabaseConfig();
      const buildInfo = loadBuildInfo();
      const pool = createDatabasePool(databaseConfig, "relay-migrate");

      try {
        if (subcommand === "up") {
          await migrateUp(
            pool,
            MIGRATIONS,
            buildInfo.version,
            buildInfo.revision,
          );
          logger.info({
            eventName: "migration.completed",
            message: "Migration run complete",
            operation: "migrate",
            outcome: "success",
          });
        } else {
          await migrateStatus(pool, MIGRATIONS);
          logger.info({
            eventName: "migration.status",
            message: "Migration status loaded",
            operation: "migrate",
            outcome: "success",
          });
        }
      } catch (error) {
        logger.error({
          eventName: "migration.failed",
          message: "Migration operation failed",
          operation: "migrate",
          outcome: "failure",
          error,
        });
        await pool.end();
        Deno.exit(1);
      }

      await pool.end();
      break;
    }
    case "healthcheck": {
      // Runs as its own short-lived invocation of this same binary. The Docker
      // healthcheck goes through the launcher so native OTel sees a fresh
      // process instance ID before this module loads.
      const databaseConfig = loadDatabaseConfig();
      const pool = createDatabasePool(databaseConfig, "relay-healthcheck");

      try {
        const checks = [
          await checkDatabaseHealth(pool),
          await checkMigrationLedgerHealth(pool, MIGRATIONS),
        ];
        const healthy = checks.every((check) => check.status === "ok");
        const event = {
          eventName: "healthcheck.completed",
          message: healthy ? "Health check passed" : "Health check failed",
          operation: "healthcheck",
          outcome: healthy ? "success" as const : "failure" as const,
        };
        if (healthy) logger.info(event);
        else logger.error({ ...event, errorType: "dependency" });
        await pool.end();
        Deno.exit(healthy ? 0 : 1);
      } catch (error) {
        logger.error({
          eventName: "healthcheck.failed",
          message: "Health check failed",
          operation: "healthcheck",
          outcome: "failure",
          error,
          errorType: "dependency",
        });
        await pool.end();
        Deno.exit(1);
      }
      break;
    }
    default:
      logger.warn({
        eventName: "process.usage.invalid",
        message: "Usage: relay <api|worker|migrate|healthcheck>",
        operation: "startup",
        outcome: "rejected",
      });
      Deno.exit(64);
  }
}

try {
  await run();
} catch (error) {
  logger.error({
    eventName: "process.failed",
    message: "Relay process failed",
    operation: "process",
    outcome: "failure",
    error,
  });
  Deno.exit(1);
}
