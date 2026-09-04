import {
  loadBuildInfo,
  loadDatabaseConfig,
  loadEnabledObservabilityConfig,
} from "@relay/config";
import {
  createDatabasePool,
  migrateStatus,
  migrateUp,
  MIGRATIONS,
} from "@relay/database";
import { createJsonLogger } from "@relay/observability";
import {
  BOOTSTRAP_SUPERADMIN_USAGE,
  BootstrapSuperadminCommandError,
  type BootstrapSuperadminCommandOptions,
  bootstrapSuperadminFailureMessage,
  loadBootstrapSuperadminOptions,
  runBootstrapSuperadminCommand,
} from "./commands/bootstrap-superadmin.ts";

const logger = createJsonLogger();

async function run(): Promise<void> {
  const [service, subcommand, ...subcommandArguments] = Deno.args;
  loadEnabledObservabilityConfig();

  switch (service) {
    case "api": {
      const { startMvpApi } = await import("@relay/api/composition");
      const server = await startMvpApi({ logger });
      await server.finished;
      break;
    }
    case "worker": {
      const { startMvpWorker } = await import("@relay/worker/composition");
      await startMvpWorker({ logger });
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
    case "admin": {
      if (
        subcommand !== "bootstrap-superadmin" ||
        subcommandArguments.length !== 0
      ) {
        logger.warn({
          eventName: "process.usage.invalid",
          message: BOOTSTRAP_SUPERADMIN_USAGE,
          operation: "admin.bootstrap_superadmin",
          outcome: "rejected",
        });
        Deno.exit(64);
      }

      let options: BootstrapSuperadminCommandOptions;
      try {
        options = loadBootstrapSuperadminOptions();
      } catch {
        logger.warn({
          eventName: "process.usage.invalid",
          message: BOOTSTRAP_SUPERADMIN_USAGE,
          operation: "admin.bootstrap_superadmin",
          outcome: "rejected",
        });
        Deno.exit(64);
      }

      try {
        const result = await runBootstrapSuperadminCommand(
          loadDatabaseConfig(),
          options,
        );
        logger.info({
          eventName: "admin.bootstrap_superadmin.completed",
          message: result.kind === "changed"
            ? "Initial superadmin grant completed"
            : "Initial superadmin grant replay confirmed",
          operation: "admin.bootstrap_superadmin",
          outcome: "success",
        });
      } catch (error) {
        if (error instanceof BootstrapSuperadminCommandError) {
          logger.error({
            eventName: `admin.bootstrap_superadmin.${error.reason}`,
            message: bootstrapSuperadminFailureMessage(error.reason),
            operation: "admin.bootstrap_superadmin",
            outcome: "failure",
          });
        } else {
          logger.error({
            eventName: "admin.bootstrap_superadmin.failed",
            message: "Initial superadmin grant failed",
            operation: "admin.bootstrap_superadmin",
            outcome: "failure",
            error,
          });
        }
        Deno.exit(1);
      }
      break;
    }
    case "healthcheck": {
      // Dynamically loaded so migrate remains a database-only command and does
      // not initialize the Redis/S3 health-check dependency graph.
      const { runContainerHealthcheck } = await import("./healthcheck.ts");
      try {
        const result = await runContainerHealthcheck();
        const event = {
          eventName: "healthcheck.completed",
          message: result.healthy
            ? "Health check passed"
            : "Health check failed",
          operation: "healthcheck",
          outcome: result.healthy ? "success" as const : "failure" as const,
        };
        if (result.healthy) logger.info(event);
        else logger.error({ ...event, errorType: "dependency" });
        Deno.exit(result.healthy ? 0 : 1);
      } catch (error) {
        logger.error({
          eventName: "healthcheck.failed",
          message: "Health check failed",
          operation: "healthcheck",
          outcome: "failure",
          error,
          errorType: "dependency",
        });
        Deno.exit(1);
      }
      break;
    }
    default:
      logger.warn({
        eventName: "process.usage.invalid",
        message: "Usage: relay <api|worker|migrate|admin|healthcheck>",
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
