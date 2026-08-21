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

export interface ReadinessCheck {
  readonly name: string;
  readonly status: "ok" | "error";
  /** Sanitized detail only -- never a connection string, credential, or raw driver error. */
  readonly message?: string;
}
