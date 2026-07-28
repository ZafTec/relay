export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface BuildInfo {
  readonly version: string;
  readonly revision: string;
}

export interface ServiceHealth {
  readonly service: string;
  readonly status: "ok" | "degraded";
  readonly build: BuildInfo;
}
