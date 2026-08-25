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
 * Runs and execution jobs share the same persisted state values. The public
 * type intentionally says `Run`: `job` is an internal queue noun.
 */
export const RUN_STATUSES = JOB_STATUSES;
export type RunStatus = JobStatus;

/** @deprecated Use `RUN_STATUSES`; retained for existing domain consumers. */
export const TOOL_RUN_STATUSES = RUN_STATUSES;
/** @deprecated Use `RunStatus`; retained for existing domain consumers. */
export type ToolRunStatus = RunStatus;

export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const RUN_RESULT_COMPLETENESS = [
  "pending",
  "complete",
  "partial",
  "failed",
] as const;

export type RunResultCompleteness = (typeof RUN_RESULT_COMPLETENESS)[number];
