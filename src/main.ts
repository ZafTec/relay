import { startApi } from "../apps/api/src/server.ts";
import { createExecutionHandlerRegistry, startWorker } from "@relay/worker";
import { loadBuildInfo, loadDatabaseConfig } from "@relay/config";
import {
  checkDatabaseHealth,
  checkMigrationLedgerHealth,
  createDatabasePool,
  migrateStatus,
  migrateUp,
  MIGRATIONS,
} from "@relay/database";

const [service, subcommand] = Deno.args;

switch (service) {
  case "api": {
    const server = startApi();
    await server.finished;
    break;
  }
  case "worker": {
    const handlers = createExecutionHandlerRegistry();
    await startWorker(undefined, { handlerRegistry: handlers });
    break;
  }
  case "migrate": {
    if (subcommand !== "up" && subcommand !== "status") {
      console.error("Usage: relay migrate <up|status>");
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
        const result = await migrateUp(
          pool,
          MIGRATIONS,
          buildInfo.version,
          buildInfo.revision,
        );
        console.log(JSON.stringify({
          level: "info",
          service: "migrate",
          message: "Migration run complete",
          applied: result.applied,
          alreadyApplied: result.alreadyApplied,
        }));
      } else {
        const result = await migrateStatus(pool, MIGRATIONS);
        console.log(JSON.stringify({
          level: "info",
          service: "migrate",
          message: "Migration status",
          applied: result.applied.map((entry) => entry.id),
          pending: result.pending,
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        service: "migrate",
        message: error instanceof Error ? error.message : String(error),
      }));
      await pool.end();
      Deno.exit(1);
    }

    await pool.end();
    break;
  }
  case "healthcheck": {
    // Runs as its own short-lived invocation of this same binary --
    // Docker's HEALTHCHECK instruction execs `/app/relay healthcheck`
    // directly rather than curling the api process's own /health/ready
    // over the network, per
    // docs/implementation-handoff/09-ci-release-deployment.md ("Compose
    // healthchecks can use the backend command internally") and its
    // "Do not publicly expose readiness unless there is a deliberate
    // operational need." Works the same for the api and worker images --
    // both depend on PostgreSQL being reachable and migrated, and
    // neither dependency needs an HTTP round trip to check.
    const databaseConfig = loadDatabaseConfig();
    const pool = createDatabasePool(databaseConfig, "relay-healthcheck");

    try {
      const checks = [
        await checkDatabaseHealth(pool),
        await checkMigrationLedgerHealth(pool, MIGRATIONS),
      ];
      const healthy = checks.every((check) => check.status === "ok");
      console.log(JSON.stringify({
        level: healthy ? "info" : "error",
        service: "healthcheck",
        message: healthy ? "healthy" : "unhealthy",
        checks,
      }));
      await pool.end();
      Deno.exit(healthy ? 0 : 1);
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        service: "healthcheck",
        message: error instanceof Error ? error.message : String(error),
      }));
      await pool.end();
      Deno.exit(1);
    }
    break;
  }
  default:
    console.error("Usage: relay <api|worker|migrate|healthcheck>");
    Deno.exit(64);
}
