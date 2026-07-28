import type { BuildInfo } from "@project-s/contracts";

export interface RuntimeConfig {
  readonly appName: string;
  readonly port: number;
  readonly build: BuildInfo;
}

const DEFAULT_PORT = 8000;

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

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): RuntimeConfig {
  return {
    appName: env.APP_NAME?.trim() || "Project S",
    port: readPort(env.PORT),
    build: {
      version: env.APP_VERSION?.trim() || "development",
      revision: env.GIT_SHA?.trim() || "unknown",
    },
  };
}
