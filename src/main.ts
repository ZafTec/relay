import { startApi } from "../apps/api/src/server.ts";
import { startWorker } from "@relay/worker";
import { loadRuntimeConfig } from "@relay/config";
import {
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
  case "worker":
    await startWorker();
    break;
  case "migrate": {
    if (subcommand !== "up" && subcommand !== "status") {
      console.error("Usage: relay migrate <up|status>");
      Deno.exit(64);
    }

    const config = loadRuntimeConfig();
    const pool = createDatabasePool(config.database, "relay-migrate");

    try {
      if (subcommand === "up") {
        const result = await migrateUp(
          pool,
          MIGRATIONS,
          config.build.version,
          config.build.revision,
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
  default:
    console.error("Usage: relay <api|worker|migrate>");
    Deno.exit(64);
}
