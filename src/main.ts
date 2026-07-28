import { startApi } from "../apps/api/src/server.ts";
import { startWorker } from "@relay/worker";

const service = Deno.args[0];

switch (service) {
  case "api": {
    const server = startApi();
    await server.finished;
    break;
  }
  case "worker":
    await startWorker();
    break;
  default:
    console.error("Usage: relay <api|worker>");
    Deno.exit(64);
}
