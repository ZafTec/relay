import type { RuntimeConfig } from "@project-s/config";
import { loadRuntimeConfig } from "@project-s/config";

export async function startWorker(
  config: RuntimeConfig = loadRuntimeConfig(),
): Promise<void> {
  const abortController = new AbortController();
  const signals: Deno.Signal[] = ["SIGINT"];

  if (Deno.build.os !== "windows") signals.push("SIGTERM");

  const stop = () => abortController.abort();
  for (const signal of signals) Deno.addSignalListener(signal, stop);

  console.log(JSON.stringify({
    level: "info",
    service: "worker",
    message: "Worker started",
    version: config.build.version,
    revision: config.build.revision,
  }));

  try {
    await new Promise<void>((resolve) => {
      abortController.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  } finally {
    for (const signal of signals) Deno.removeSignalListener(signal, stop);

    console.log(JSON.stringify({
      level: "info",
      service: "worker",
      message: "Worker stopped",
    }));
  }
}
