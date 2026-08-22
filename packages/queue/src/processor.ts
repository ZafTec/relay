import type { Job, Processor } from "bullmq";
import type { DatabasePool } from "@relay/database";
import {
  beginJobAttempt,
  type ClaimedJob,
  claimJobForDispatch,
  completeJobCancellation,
  completeJobSuccessfully,
  deferJob,
  failJob,
  heartbeatJobLease,
  type JobAttempt,
  markAttemptSubmitted,
  markAttemptSubmitting,
  persistCapacityLease,
  retryJob,
} from "./dispatch.ts";
import { type ExecutionTicket, parseExecutionTicket } from "./tickets.ts";
import { jitteredBackoffMs, sanitizeError } from "./safety.ts";

export interface AcquiredCapacityLease {
  readonly leaseId: string;
  readonly scopeKeys: readonly string[];
  readonly expiresAt: Date;
  readonly ownerId: string;
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly units: number;
  readonly jobKey: string;
}

export type CapacityAcquisitionResult =
  | { readonly kind: "acquired"; readonly lease: AcquiredCapacityLease }
  | {
    readonly kind: "deferred";
    readonly reason: string;
    readonly retryAt: Date;
  };

export type SubmissionPermitResult =
  | { readonly kind: "acquired" }
  | {
    readonly kind: "deferred";
    readonly reason: string;
    readonly retryAt: Date;
  };

export interface ExecutionCapacityController {
  acquire(job: ClaimedJob): Promise<CapacityAcquisitionResult>;
  acquireSubmissionPermit(job: ClaimedJob): Promise<SubmissionPermitResult>;
  setProviderCooldown(job: ClaimedJob, expiresAt: Date): Promise<void>;
  renew(
    job: ClaimedJob,
    lease: AcquiredCapacityLease,
  ): Promise<{ readonly ok: boolean; readonly expiresAt?: Date }>;
  release(job: ClaimedJob, lease: AcquiredCapacityLease): Promise<void>;
}

export interface DispatchReadiness {
  isReady(): Promise<boolean>;
  readyToken(): Promise<string | null>;
}

export interface ExecutionHandlerContext {
  readonly job: ClaimedJob;
  readonly attempt: JobAttempt;
  readonly signal: AbortSignal;
  /** Persist the provider operation before polling or returning control. */
  readonly recordProviderOperation: (
    providerOperationId: string,
  ) => Promise<void>;
}

export type RetryClassification =
  | "pre_submission_failure"
  | "submission_confirmed"
  | "submission_ambiguous"
  | "retrieval_failure"
  | "storage_failure"
  | "provider_transient"
  | "provider_rate_limited"
  | "schema_or_policy_failure"
  | "safety_rejection";

type NonRateLimitedRetryClassification = Exclude<
  RetryClassification,
  "provider_rate_limited"
>;

export type ExecutionHandlerResult =
  | { readonly kind: "succeeded" }
  | {
    readonly kind: "failed";
    readonly retryClassification: "provider_rate_limited";
    readonly error: unknown;
    readonly retryAt: Date;
  }
  | {
    readonly kind: "failed";
    readonly retryClassification: NonRateLimitedRetryClassification;
    readonly error: unknown;
    readonly retryAt?: Date;
  }
  | { readonly kind: "cancelled" };

export type ExecutionHandler = (
  context: ExecutionHandlerContext,
) => Promise<ExecutionHandlerResult>;

export interface ExecutionProcessorOptions {
  readonly leaseOwner: string;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly coordinationRetryMs: number;
  readonly maxDeferralJitterMs: number;
  readonly maxExecutionAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly retryJitterRatio?: number;
  readonly maxRetryWaitMs?: number;
  readonly random?: () => number;
}

export type ExecutionDisposition =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "deferred" }
  | { readonly kind: "retry_scheduled" }
  | { readonly kind: "no_op" }
  | { readonly kind: "lost_lease" }
  | { readonly kind: "shutdown" };

const SHUTDOWN_REASON = "worker_shutdown";
const LOST_LEASE_REASON = "lost_lease";
const CANCELLATION_REASON = "cancellation_requested";
const DEADLINE_REASON = "deadline_exceeded";

const DEFAULT_MAX_EXECUTION_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_RETRY_JITTER_RATIO = 0.2;
const DEFAULT_MAX_RETRY_WAIT_MS = 5 * 60_000;

const RETRYABLE_CLASSIFICATIONS = new Set<RetryClassification>([
  "pre_submission_failure",
  "submission_confirmed",
  "submission_ambiguous",
  "retrieval_failure",
  "storage_failure",
  "provider_transient",
  "provider_rate_limited",
]);

function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): string | undefined {
  return typeof signal.reason === "string" ? signal.reason : undefined;
}

export class ExecutionProcessor {
  readonly processor: Processor<ExecutionTicket>;
  readonly #active = new Map<string, AbortController>();
  readonly #idleWaiters = new Set<() => void>();
  readonly #random: () => number;

  constructor(
    private readonly pool: DatabasePool,
    private readonly capacity: ExecutionCapacityController,
    private readonly readiness: DispatchReadiness,
    private readonly handler: ExecutionHandler,
    private readonly options: ExecutionProcessorOptions,
  ) {
    this.#random = options.random ?? Math.random;
    this.processor = (job) => this.process(job);
  }

  get activeCount(): number {
    return this.#active.size;
  }

  abortActive(reason = SHUTDOWN_REASON): void {
    for (const controller of this.#active.values()) controller.abort(reason);
  }

  abortJob(jobId: string, reason = CANCELLATION_REASON): boolean {
    const controller = this.#active.get(jobId);
    if (controller === undefined) return false;
    controller.abort(reason);
    return true;
  }

  waitForIdle(): Promise<void> {
    if (this.#active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  async process(
    transportJob: Pick<Job<ExecutionTicket>, "data">,
  ): Promise<ExecutionDisposition> {
    const ticket = parseExecutionTicket(transportJob.data);
    // A missing reconciliation marker means Redis may have lost both ticket and
    // capacity state. Never claim PostgreSQL work while that fact is unknown.
    const readinessToken = await this.readiness.readyToken();
    if (readinessToken === null) {
      throw new Error(
        "Dispatch is paused until Redis reconciliation completes",
      );
    }

    const claim = await claimJobForDispatch(
      this.pool,
      ticket,
      this.options.leaseOwner,
      this.options.leaseDurationMs,
    );
    if (claim.kind === "no_op") return { kind: "no_op" };
    const job = claim.job;
    const controller = new AbortController();
    this.#active.set(job.jobId, controller);
    let lease: AcquiredCapacityLease | undefined;
    let attempt: JobAttempt | undefined;
    let heartbeatTask: Promise<void> | undefined;
    let preserveCapacityLease = false;

    try {
      // Check again after the durable claim. If Redis reset in the intervening
      // window, return the job to queued without opening an attempt.
      if ((await this.readiness.readyToken()) !== readinessToken) {
        const deferred = await this.#deferForCoordination(job);
        return deferred ? { kind: "deferred" } : { kind: "lost_lease" };
      }

      let acquisition: CapacityAcquisitionResult;
      try {
        acquisition = await this.capacity.acquire(job);
      } catch (error) {
        const deferred = await this.#deferForCoordination(
          job,
          sanitizeError(error),
        );
        return deferred ? { kind: "deferred" } : { kind: "lost_lease" };
      }
      if (acquisition.kind === "deferred") {
        const eligibleAt = new Date(
          acquisition.retryAt.getTime() + this.#deferralJitter(),
        );
        const deferred = await deferJob(
          this.pool,
          job.jobId,
          job.runId,
          job.leaseEpoch,
          this.options.leaseOwner,
          eligibleAt,
          acquisition.reason,
        );
        return deferred ? { kind: "deferred" } : { kind: "lost_lease" };
      }
      lease = acquisition.lease;

      const durableLeaseId = await persistCapacityLease(
        this.pool,
        job,
        this.options.leaseOwner,
        {
          redisLeaseId: lease.leaseId,
          redisScopeKeys: lease.scopeKeys,
          expiresAt: lease.expiresAt,
          units: lease.units,
        },
      );
      if (durableLeaseId === null) return { kind: "lost_lease" };

      // Re-check after the Redis lease is durably attached. A reset and complete
      // reconciliation changes the token, so a brief reset cannot slip through.
      if ((await this.readiness.readyToken()) !== readinessToken) {
        const deferred = await this.#deferForCoordination(job);
        return deferred ? { kind: "deferred" } : { kind: "lost_lease" };
      }

      let submissionPermit: SubmissionPermitResult;
      try {
        submissionPermit = await this.capacity.acquireSubmissionPermit(job);
      } catch (error) {
        const deferred = await this.#deferForCoordination(
          job,
          sanitizeError(error),
        );
        return deferred ? { kind: "deferred" } : { kind: "lost_lease" };
      }
      if (submissionPermit.kind === "deferred") {
        const deferred = await deferJob(
          this.pool,
          job.jobId,
          job.runId,
          job.leaseEpoch,
          this.options.leaseOwner,
          new Date(
            submissionPermit.retryAt.getTime() + this.#deferralJitter(),
          ),
          submissionPermit.reason,
        );
        return deferred ? { kind: "deferred" } : { kind: "lost_lease" };
      }

      attempt =
        await beginJobAttempt(this.pool, job, this.options.leaseOwner) ??
          undefined;
      if (attempt === undefined) {
        const cancelled = await completeJobCancellation(
          this.pool,
          job.jobId,
          null,
          job.leaseEpoch,
          this.options.leaseOwner,
        );
        return cancelled ? { kind: "cancelled" } : { kind: "lost_lease" };
      }
      if (
        !(await markAttemptSubmitting(
          this.pool,
          job.jobId,
          attempt.attemptId,
          job.leaseEpoch,
          this.options.leaseOwner,
        ))
      ) {
        const cancelled = await completeJobCancellation(
          this.pool,
          job.jobId,
          attempt.attemptId,
          job.leaseEpoch,
          this.options.leaseOwner,
        );
        return cancelled ? { kind: "cancelled" } : { kind: "lost_lease" };
      }

      const initialControl = await heartbeatJobLease(
        this.pool,
        job.jobId,
        job.leaseEpoch,
        this.options.leaseOwner,
        this.options.leaseDurationMs,
        lease.expiresAt,
      );
      if (initialControl.kind === "lost") {
        preserveCapacityLease = true;
        return { kind: "lost_lease" };
      }
      if (initialControl.kind === "deadline_exceeded") {
        return await failJob(
            this.pool,
            job.jobId,
            attempt.attemptId,
            job.leaseEpoch,
            this.options.leaseOwner,
            "deadline_exceeded",
            "Execution run deadline exceeded before provider submission",
          )
          ? { kind: "failed" }
          : { kind: "lost_lease" };
      }
      if (initialControl.cancelRequested) {
        return await completeJobCancellation(
            this.pool,
            job.jobId,
            attempt.attemptId,
            job.leaseEpoch,
            this.options.leaseOwner,
          )
          ? { kind: "cancelled" }
          : { kind: "lost_lease" };
      }

      heartbeatTask = this.#heartbeat(job, lease, controller);
      // From this point provider work may exist. Keep capacity fail-closed until
      // a durable terminal/retry transaction explicitly releases its row.
      preserveCapacityLease = true;
      let result: ExecutionHandlerResult;
      try {
        result = await this.handler({
          job,
          attempt,
          signal: controller.signal,
          recordProviderOperation: async (providerOperationId) => {
            if (
              !(await markAttemptSubmitted(
                this.pool,
                job.jobId,
                attempt!.attemptId,
                job.leaseEpoch,
                this.options.leaseOwner,
                providerOperationId,
              ))
            ) {
              throw new Error(
                "Lost job lease while recording provider operation",
              );
            }
          },
        });
      } catch (error) {
        const reason = abortReason(controller.signal);
        if (reason === SHUTDOWN_REASON) {
          preserveCapacityLease = true;
          return { kind: "shutdown" };
        }
        if (reason === LOST_LEASE_REASON) {
          preserveCapacityLease = true;
          return { kind: "lost_lease" };
        }
        if (reason === DEADLINE_REASON) {
          const failed = await failJob(
            this.pool,
            job.jobId,
            attempt.attemptId,
            job.leaseEpoch,
            this.options.leaseOwner,
            "deadline_exceeded",
            "Execution run deadline exceeded",
          );
          if (failed) {
            preserveCapacityLease = false;
            return { kind: "failed" };
          }
          return { kind: "lost_lease" };
        }
        if (reason === CANCELLATION_REASON) {
          const cancelled = await completeJobCancellation(
            this.pool,
            job.jobId,
            attempt.attemptId,
            job.leaseEpoch,
            this.options.leaseOwner,
          );
          if (cancelled) {
            preserveCapacityLease = false;
            return { kind: "cancelled" };
          }
          return { kind: "lost_lease" };
        }
        result = {
          kind: "failed",
          retryClassification: "provider_transient",
          error,
        };
      }

      const completedAbortReason = abortReason(controller.signal);
      if (completedAbortReason === LOST_LEASE_REASON) {
        preserveCapacityLease = true;
        return { kind: "lost_lease" };
      }
      if (completedAbortReason === DEADLINE_REASON) {
        const failed = await failJob(
          this.pool,
          job.jobId,
          attempt.attemptId,
          job.leaseEpoch,
          this.options.leaseOwner,
          "deadline_exceeded",
          "Execution run deadline exceeded",
        );
        if (failed) {
          preserveCapacityLease = false;
          return { kind: "failed" };
        }
        return { kind: "lost_lease" };
      }
      if (
        completedAbortReason === SHUTDOWN_REASON && result.kind !== "succeeded"
      ) {
        preserveCapacityLease = true;
        return { kind: "shutdown" };
      }
      if (
        completedAbortReason === CANCELLATION_REASON &&
        result.kind !== "succeeded"
      ) {
        const cancelled = await completeJobCancellation(
          this.pool,
          job.jobId,
          attempt.attemptId,
          job.leaseEpoch,
          this.options.leaseOwner,
        );
        if (cancelled) {
          preserveCapacityLease = false;
          return { kind: "cancelled" };
        }
        return { kind: "lost_lease" };
      }

      if (result.kind === "succeeded") {
        const completed = await completeJobSuccessfully(
          this.pool,
          job.jobId,
          attempt.attemptId,
          job.leaseEpoch,
          this.options.leaseOwner,
        );
        if (completed) {
          preserveCapacityLease = false;
          return { kind: "succeeded" };
        }
        return { kind: "lost_lease" };
      }
      if (result.kind === "cancelled") {
        const cancelled = await completeJobCancellation(
          this.pool,
          job.jobId,
          attempt.attemptId,
          job.leaseEpoch,
          this.options.leaseOwner,
        );
        if (cancelled) {
          preserveCapacityLease = false;
          return { kind: "cancelled" };
        }
        const failed = await failJob(
          this.pool,
          job.jobId,
          attempt.attemptId,
          job.leaseEpoch,
          this.options.leaseOwner,
          "handler_cancelled_without_request",
          "Execution handler returned cancelled without a durable cancellation request",
        );
        if (failed) {
          preserveCapacityLease = false;
          return { kind: "failed" };
        }
        return { kind: "lost_lease" };
      }

      const maxAttempts = this.options.maxExecutionAttempts ??
        DEFAULT_MAX_EXECUTION_ATTEMPTS;
      if (
        RETRYABLE_CLASSIFICATIONS.has(result.retryClassification) &&
        attempt.attemptNumber < maxAttempts
      ) {
        const now = Date.now();
        const backoffMs = jitteredBackoffMs(
          attempt.attemptNumber,
          {
            baseDelayMs: this.options.retryBaseDelayMs ??
              DEFAULT_RETRY_BASE_DELAY_MS,
            maxDelayMs: this.options.retryMaxDelayMs ??
              DEFAULT_RETRY_MAX_DELAY_MS,
            jitterRatio: this.options.retryJitterRatio ??
              DEFAULT_RETRY_JITTER_RATIO,
          },
          this.#random,
        );
        const eligibleAt = new Date(Math.max(
          now + backoffMs,
          result.retryAt?.getTime() ?? 0,
        ));
        const attemptDeadlineAt = new Date(
          now + (this.options.maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS),
        );

        if (result.retryClassification === "provider_rate_limited") {
          try {
            await this.capacity.setProviderCooldown(job, eligibleAt);
          } catch {
            preserveCapacityLease = true;
            return { kind: "lost_lease" };
          }
        }

        if (eligibleAt < attemptDeadlineAt) {
          const retried = await retryJob(
            this.pool,
            job.jobId,
            job.runId,
            attempt.attemptId,
            job.leaseEpoch,
            this.options.leaseOwner,
            eligibleAt,
            attemptDeadlineAt,
            result.retryClassification,
            result.error,
          );
          if (retried) {
            preserveCapacityLease = false;
            return { kind: "retry_scheduled" };
          }
        }
      }

      const failed = await failJob(
        this.pool,
        job.jobId,
        attempt.attemptId,
        job.leaseEpoch,
        this.options.leaseOwner,
        result.retryClassification,
        result.error,
      );
      if (failed) {
        preserveCapacityLease = false;
        return { kind: "failed" };
      }
      const cancelled = await completeJobCancellation(
        this.pool,
        job.jobId,
        attempt.attemptId,
        job.leaseEpoch,
        this.options.leaseOwner,
      );
      if (cancelled) {
        preserveCapacityLease = false;
        return { kind: "cancelled" };
      }
      return { kind: "lost_lease" };
    } finally {
      controller.abort("processor_finished");
      if (heartbeatTask !== undefined) await heartbeatTask;
      if (this.#active.get(job.jobId) === controller) {
        this.#active.delete(job.jobId);
      }
      if (this.#active.size === 0) {
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
      }
      if (lease !== undefined && !preserveCapacityLease) {
        try {
          await this.capacity.release(job, lease);
        } catch {
          // The durable transition already released ownership. Redis expiry is
          // the bounded fallback when best-effort physical release fails.
        }
      }
    }
  }

  async #deferForCoordination(
    job: ClaimedJob,
    detail?: string,
  ): Promise<boolean> {
    return await deferJob(
      this.pool,
      job.jobId,
      job.runId,
      job.leaseEpoch,
      this.options.leaseOwner,
      new Date(
        Date.now() + this.options.coordinationRetryMs + this.#deferralJitter(),
      ),
      detail === undefined
        ? "coordination_unavailable"
        : `coordination_unavailable: ${detail}`,
    );
  }

  #deferralJitter(): number {
    return Math.floor(
      Math.min(1, Math.max(0, this.#random())) *
        this.options.maxDeferralJitterMs,
    );
  }

  async #heartbeat(
    job: ClaimedJob,
    lease: AcquiredCapacityLease,
    controller: AbortController,
  ): Promise<void> {
    while (await delay(this.options.heartbeatIntervalMs, controller.signal)) {
      try {
        if (!(await this.readiness.isReady())) {
          controller.abort(LOST_LEASE_REASON);
          return;
        }
        const renewed = await this.capacity.renew(job, lease);
        if (!renewed.ok || renewed.expiresAt === undefined) {
          controller.abort(LOST_LEASE_REASON);
          return;
        }
        const heartbeat = await heartbeatJobLease(
          this.pool,
          job.jobId,
          job.leaseEpoch,
          this.options.leaseOwner,
          this.options.leaseDurationMs,
          renewed.expiresAt,
        );
        if (heartbeat.kind === "lost") {
          controller.abort(LOST_LEASE_REASON);
          return;
        }
        if (heartbeat.kind === "deadline_exceeded") {
          controller.abort(DEADLINE_REASON);
          return;
        }
        if (heartbeat.cancelRequested) {
          controller.abort(CANCELLATION_REASON);
          return;
        }
      } catch {
        controller.abort(LOST_LEASE_REASON);
        return;
      }
    }
  }
}
