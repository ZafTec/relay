export { createRedisConnection } from "./redis.ts";
export type { Redis } from "./redis.ts";

export {
  dispatchDeduplicationKey,
  MAX_SCHEDULER_COST_UNITS,
  parseExecutionOutboxPayload,
  parseExecutionTicket,
  ticketFromOutboxPayload,
  ticketId,
} from "./tickets.ts";
export type { ExecutionOutboxPayload, ExecutionTicket } from "./tickets.ts";

export {
  capacityPoolQueueName,
  createExecutionQueue,
  createExecutionWorker,
  executionOutboxAction,
  ExecutionQueueRegistry,
} from "./bullmq.ts";
export type { ExecutionOutboxAction } from "./bullmq.ts";

export {
  claimOutboxBatch,
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  DEFAULT_RELAY_OUTBOX_OPTIONS,
  finalizeExpiredOutboxAttempts,
  markOutboxFailed,
  markOutboxPublished,
  relayOutboxBatch,
} from "./outbox-relay.ts";
export type {
  MarkOutboxFailedOptions,
  OutboxEventRow,
  OutboxFinalizationResult,
  Queryable,
  RelayOutboxBatchResult,
  RelayOutboxOptions,
} from "./outbox-relay.ts";

export { admitToolRun } from "./admission.ts";
export type {
  AdmissionUsageFailure,
  AdmissionUsageMeasureRange,
  AdmissionUsageMeasures,
  AdmissionUsagePort,
  AdmissionUsageQuote,
  AdmissionUsageQuoteResult,
  AdmissionUsageRequest,
  AdmissionUsageReservationResult,
  AdmissionUsageUnavailableReason,
  AdmitRunDependencies,
  AdmitRunInput,
  AdmitRunResult,
} from "./admission.ts";

export {
  armSchedulerTicket,
  beginJobAttempt,
  claimJobForDispatch,
  completeJobCancellation,
  completeJobSuccessfully,
  deferJob,
  expireQueuedJobs,
  failJob,
  heartbeatJob,
  heartbeatJobLease,
  markAttemptSubmitted,
  markAttemptSubmitting,
  parseSubmissionRatePolicy,
  persistCapacityLease,
  rearmQueuedJobDispatch,
  reconcileQueueCounters,
  recoverExpiredJobLeases,
  requestJobCancellation,
  retryJob,
} from "./dispatch.ts";
export type {
  CancellationRequestResult,
  ClaimedJob,
  ClaimResult,
  DurableCapacityLease,
  ExecutionCapacityLimits,
  ExpiredQueuedJobsResult,
  JobAttempt,
  JobHeartbeatResult,
  PersistCapacityLeaseInput,
  StalledRecoveryResult,
  SubmissionRatePolicy,
} from "./dispatch.ts";

export { ExecutionProcessor, withExecutionConsumerSpan } from "./processor.ts";
export type {
  AcquiredCapacityLease,
  CapacityAcquisitionResult,
  DispatchReadiness,
  ExecutionCapacityController,
  ExecutionDisposition,
  ExecutionHandler,
  ExecutionHandlerContext,
  ExecutionHandlerResult,
  ExecutionProcessorOptions,
  RetryClassification,
  SubmissionPermitResult,
} from "./processor.ts";

export {
  ExecutionSchedulerBridge,
  loadScheduledExecution,
} from "./scheduler-bridge.ts";
export type {
  ExecutionTransport,
  ScheduledExecution,
  SchedulerBridgeOptions,
  SchedulerDispatchResult,
  SchedulerReconciliationResult,
} from "./scheduler-bridge.ts";

export {
  listEnabledCapacityPoolKeys,
  loadCapacityRehydrationPlan,
  reconcileLostTickets,
  reconcileRedisReset,
  RedisDispatchGate,
} from "./reconciliation.ts";
export type {
  CapacityRehydrationPlan,
  LostTicketReconciliationResult,
  RedisResetReconciliationDependencies,
  RedisResetReconciliationOptions,
  RedisResetReconciliationResult,
} from "./reconciliation.ts";

export {
  DEFAULT_OUTBOX_BACKOFF,
  jitteredBackoffMs,
  MAX_SANITIZED_ERROR_LENGTH,
  sanitizeError,
} from "./safety.ts";
export type { BackoffOptions } from "./safety.ts";
