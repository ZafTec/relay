export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * relay.tool_runs and relay.execution_jobs share these six canonical
 * states per docs/implementation-handoff/04-queue-capacity-scheduling.md
 * "Suggested durable fields" -- same values as JobStatus, named
 * separately so callers reading tool-run status don't have to reason
 * about "job" terminology that's really about the transport layer.
 */
export const TOOL_RUN_STATUSES = JOB_STATUSES;
export type ToolRunStatus = JobStatus;

export { generatePublicId, ID_PREFIXES } from "./ids.ts";
export type { IdPrefix } from "./ids.ts";

export interface BuildInfo {
  readonly version: string;
  readonly revision: string;
}

export interface ServiceHealth {
  readonly service: string;
  readonly status: "ok" | "degraded";
  readonly build: BuildInfo;
}

export interface ReadinessCheck {
  readonly name: string;
  readonly status: "ok" | "error";
  /** Sanitized detail only -- never a connection string, credential, or raw driver error. */
  readonly message?: string;
}
