import type {
  ArtifactPurgeLease,
  CleanupExecutionResult,
  ExpiredUpload,
  PurgeExecutionResult,
  UploadCleanupLease,
} from "@relay/artifacts";
import {
  createJsonLogger,
  type JsonLogger,
  type LogRecord,
} from "@relay/observability";

export const DEFAULT_ARTIFACT_MAINTENANCE_INTERVAL_MS = 30_000;
export const DEFAULT_ARTIFACT_MAINTENANCE_BATCH_SIZE = 100;
export const DEFAULT_ARTIFACT_MAINTENANCE_CONCURRENCY = 4;
export const MAX_ARTIFACT_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE = 100;
export const MAX_ARTIFACT_MAINTENANCE_CONCURRENCY = 100;

export type ArtifactMaintenanceOperation =
  | "expire_pending_uploads"
  | "claim_upload_cleanup"
  | "process_upload_cleanup"
  | "claim_artifact_purges"
  | "process_artifact_purge"
  | "iteration";

export type ArtifactMaintenanceOutcome =
  | "success"
  | "failure"
  | CleanupExecutionResult["kind"]
  | PurgeExecutionResult["kind"];

export interface ArtifactMaintenanceMetric {
  readonly operation: ArtifactMaintenanceOperation;
  readonly outcome: ArtifactMaintenanceOutcome;
  readonly value: number;
}

export interface ArtifactMaintenanceService {
  expirePendingUploads(limit: number): Promise<readonly ExpiredUpload[]>;
  claimUploadCleanup(limit: number): Promise<readonly UploadCleanupLease[]>;
  processUploadCleanup(
    lease: UploadCleanupLease,
  ): Promise<CleanupExecutionResult>;
  claimArtifactPurges(limit: number): Promise<readonly ArtifactPurgeLease[]>;
  processArtifactPurge(
    lease: ArtifactPurgeLease,
  ): Promise<PurgeExecutionResult>;
}

export interface ArtifactMaintenanceOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  /** Receives fixed-schema records after error details have been normalized. */
  readonly log?: (record: LogRecord) => void | Promise<void>;
  /** Measurements contain only fixed operation and outcome dimensions. */
  readonly onMetric?: (
    metric: ArtifactMaintenanceMetric,
  ) => void | Promise<void>;
}

export interface ArtifactMaintenanceRunResult {
  readonly expiration: {
    readonly expired: number;
    readonly failed: number;
  };
  readonly uploadCleanup: {
    readonly claimed: number;
    readonly deleted: number;
    readonly retryScheduled: number;
    readonly leaseLost: number;
    readonly failed: number;
  };
  readonly artifactPurge: {
    readonly claimed: number;
    readonly purged: number;
    readonly retryScheduled: number;
    readonly leaseLost: number;
    readonly failed: number;
  };
  readonly aborted: boolean;
}

interface MutableRunResult {
  expiration: {
    expired: number;
    failed: number;
  };
  uploadCleanup: {
    claimed: number;
    deleted: number;
    retryScheduled: number;
    leaseLost: number;
    failed: number;
  };
  artifactPurge: {
    claimed: number;
    purged: number;
    retryScheduled: number;
    leaseLost: number;
    failed: number;
  };
}

const FAILURE_EVENTS: Readonly<
  Record<ArtifactMaintenanceOperation, {
    readonly eventName: string;
    readonly message: string;
  }>
> = {
  expire_pending_uploads: {
    eventName: "worker.artifact_maintenance.expiration_failed",
    message: "Artifact upload expiration failed",
  },
  claim_upload_cleanup: {
    eventName: "worker.artifact_maintenance.cleanup_claim_failed",
    message: "Artifact upload cleanup claim failed",
  },
  process_upload_cleanup: {
    eventName: "worker.artifact_maintenance.cleanup_failed",
    message: "Artifact upload cleanup failed",
  },
  claim_artifact_purges: {
    eventName: "worker.artifact_maintenance.purge_claim_failed",
    message: "Artifact purge claim failed",
  },
  process_artifact_purge: {
    eventName: "worker.artifact_maintenance.purge_failed",
    message: "Artifact purge failed",
  },
  iteration: {
    eventName: "worker.artifact_maintenance.iteration_failed",
    message: "Artifact maintenance iteration failed",
  },
};

function boundedInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(
      `${name} must be an integer from 1 to ${maximum}`,
    );
  }
  return value;
}

function emptyRunResult(): MutableRunResult {
  return {
    expiration: { expired: 0, failed: 0 },
    uploadCleanup: {
      claimed: 0,
      deleted: 0,
      retryScheduled: 0,
      leaseLost: 0,
      failed: 0,
    },
    artifactPurge: {
      claimed: 0,
      purged: 0,
      retryScheduled: 0,
      leaseLost: 0,
      failed: 0,
    },
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function settleWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  process: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const settled: PromiseSettledResult<R>[] = [];
  for (let offset = 0; offset < values.length; offset += concurrency) {
    const chunk = values.slice(offset, offset + concurrency);
    settled.push(
      ...await Promise.allSettled(
        chunk.map(async (value) => await process(value)),
      ),
    );
  }
  return settled;
}

function createMaintenanceLogger(
  log: ArtifactMaintenanceOptions["log"],
): JsonLogger {
  if (log === undefined) return createJsonLogger();
  return createJsonLogger({
    sink: {
      write(line) {
        try {
          const pending = log(JSON.parse(line) as LogRecord);
          if (pending !== undefined) {
            void Promise.resolve(pending).catch(() => undefined);
          }
        } catch {
          // Diagnostics must never alter maintenance control flow.
        }
      },
    },
  });
}

/**
 * Runs artifact expiration and fenced cleanup work without overlapping
 * iterations. Stopping is terminal: no new claims begin, while every lease
 * already returned by a claim is processed before the lifecycle resolves.
 */
export class ArtifactMaintenanceLoop {
  readonly #service: ArtifactMaintenanceService;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #concurrency: number;
  readonly #logger: JsonLogger;
  readonly #onMetric: ArtifactMaintenanceOptions["onMetric"];
  readonly #controller = new AbortController();
  readonly #externalSignal: AbortSignal | undefined;
  readonly #externalAbort: () => void;
  #iteration: Promise<ArtifactMaintenanceRunResult> | undefined;
  #loop: Promise<void> | undefined;

  constructor(
    service: ArtifactMaintenanceService,
    options: ArtifactMaintenanceOptions = {},
  ) {
    this.#service = service;
    this.#intervalMs = boundedInteger(
      "intervalMs",
      options.intervalMs ?? DEFAULT_ARTIFACT_MAINTENANCE_INTERVAL_MS,
      MAX_ARTIFACT_MAINTENANCE_INTERVAL_MS,
    );
    this.#batchSize = boundedInteger(
      "batchSize",
      options.batchSize ?? DEFAULT_ARTIFACT_MAINTENANCE_BATCH_SIZE,
      MAX_ARTIFACT_MAINTENANCE_BATCH_SIZE,
    );
    this.#concurrency = boundedInteger(
      "concurrency",
      options.concurrency ?? DEFAULT_ARTIFACT_MAINTENANCE_CONCURRENCY,
      MAX_ARTIFACT_MAINTENANCE_CONCURRENCY,
    );
    this.#logger = createMaintenanceLogger(options.log);
    this.#onMetric = options.onMetric;
    this.#externalSignal = options.signal;
    this.#externalAbort = () => {
      this.#controller.abort(this.#externalSignal?.reason);
    };

    if (this.#externalSignal?.aborted) {
      this.#externalAbort();
    } else {
      this.#externalSignal?.addEventListener("abort", this.#externalAbort, {
        once: true,
      });
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get stopped(): boolean {
    return this.#controller.signal.aborted;
  }

  runOnce(): Promise<ArtifactMaintenanceRunResult> {
    if (this.#iteration !== undefined) return this.#iteration;
    if (this.stopped) {
      return Promise.resolve({
        ...emptyRunResult(),
        aborted: true,
      });
    }

    const iteration = this.#runIteration();
    this.#iteration = iteration;
    void iteration.then(
      () => {
        if (this.#iteration === iteration) this.#iteration = undefined;
      },
      () => {
        if (this.#iteration === iteration) this.#iteration = undefined;
      },
    );
    return iteration;
  }

  start(): Promise<void> {
    if (this.#loop !== undefined) return this.#loop;
    if (this.stopped) {
      this.#removeExternalAbortListener();
      this.#loop = Promise.resolve();
      return this.#loop;
    }

    const loop = this.#runLoop();
    this.#loop = loop;
    void loop.then(
      () => this.#removeExternalAbortListener(),
      () => this.#removeExternalAbortListener(),
    );
    return loop;
  }

  async stop(): Promise<void> {
    this.#controller.abort("artifact_maintenance_stopped");
    const draining = new Set<Promise<unknown>>();
    if (this.#iteration !== undefined) draining.add(this.#iteration);
    if (this.#loop !== undefined) draining.add(this.#loop);
    await Promise.allSettled(draining);
    this.#removeExternalAbortListener();
  }

  async #runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (error) {
        this.#reportFailure("iteration", error);
      }
      if (this.stopped) break;
      await wait(this.#intervalMs, this.signal);
    }
  }

  async #runIteration(): Promise<ArtifactMaintenanceRunResult> {
    const result = emptyRunResult();
    try {
      if (!this.stopped) await this.#expirePendingUploads(result);
      if (!this.stopped) await this.#runUploadCleanup(result);
      if (!this.stopped) await this.#runArtifactPurges(result);
    } catch (error) {
      this.#reportFailure("iteration", error);
    }
    return { ...result, aborted: this.stopped };
  }

  async #expirePendingUploads(result: MutableRunResult): Promise<void> {
    try {
      const expired = await this.#service.expirePendingUploads(this.#batchSize);
      result.expiration.expired = expired.length;
      this.#metric("expire_pending_uploads", "success", expired.length);
    } catch (error) {
      result.expiration.failed += 1;
      this.#reportFailure("expire_pending_uploads", error);
    }
  }

  async #runUploadCleanup(result: MutableRunResult): Promise<void> {
    let leases: readonly UploadCleanupLease[];
    try {
      leases = await this.#service.claimUploadCleanup(this.#batchSize);
      result.uploadCleanup.claimed = leases.length;
      this.#metric("claim_upload_cleanup", "success", leases.length);
    } catch (error) {
      result.uploadCleanup.failed += 1;
      this.#reportFailure("claim_upload_cleanup", error);
      return;
    }

    const outcomes = await settleWithConcurrency(
      leases,
      this.#concurrency,
      (lease) => this.#service.processUploadCleanup(lease),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        result.uploadCleanup.failed += 1;
        this.#reportFailure("process_upload_cleanup", outcome.reason);
        continue;
      }
      switch (outcome.value.kind) {
        case "deleted":
          result.uploadCleanup.deleted += 1;
          break;
        case "retry_scheduled":
          result.uploadCleanup.retryScheduled += 1;
          break;
        case "lease_lost":
          result.uploadCleanup.leaseLost += 1;
          break;
        default:
          result.uploadCleanup.failed += 1;
          this.#reportFailure(
            "process_upload_cleanup",
            new TypeError("Unexpected artifact cleanup result"),
          );
      }
    }
    this.#metric(
      "process_upload_cleanup",
      "deleted",
      result.uploadCleanup.deleted,
    );
    this.#metric(
      "process_upload_cleanup",
      "retry_scheduled",
      result.uploadCleanup.retryScheduled,
    );
    this.#metric(
      "process_upload_cleanup",
      "lease_lost",
      result.uploadCleanup.leaseLost,
    );
  }

  async #runArtifactPurges(result: MutableRunResult): Promise<void> {
    let leases: readonly ArtifactPurgeLease[];
    try {
      leases = await this.#service.claimArtifactPurges(this.#batchSize);
      result.artifactPurge.claimed = leases.length;
      this.#metric("claim_artifact_purges", "success", leases.length);
    } catch (error) {
      result.artifactPurge.failed += 1;
      this.#reportFailure("claim_artifact_purges", error);
      return;
    }

    const outcomes = await settleWithConcurrency(
      leases,
      this.#concurrency,
      (lease) => this.#service.processArtifactPurge(lease),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        result.artifactPurge.failed += 1;
        this.#reportFailure("process_artifact_purge", outcome.reason);
        continue;
      }
      switch (outcome.value.kind) {
        case "purged":
          result.artifactPurge.purged += 1;
          break;
        case "retry_scheduled":
          result.artifactPurge.retryScheduled += 1;
          break;
        case "lease_lost":
          result.artifactPurge.leaseLost += 1;
          break;
        default:
          result.artifactPurge.failed += 1;
          this.#reportFailure(
            "process_artifact_purge",
            new TypeError("Unexpected artifact purge result"),
          );
      }
    }
    this.#metric(
      "process_artifact_purge",
      "purged",
      result.artifactPurge.purged,
    );
    this.#metric(
      "process_artifact_purge",
      "retry_scheduled",
      result.artifactPurge.retryScheduled,
    );
    this.#metric(
      "process_artifact_purge",
      "lease_lost",
      result.artifactPurge.leaseLost,
    );
  }

  #reportFailure(
    operation: ArtifactMaintenanceOperation,
    error: unknown,
  ): void {
    const event = FAILURE_EVENTS[operation];
    try {
      this.#logger.error({
        ...event,
        operation,
        outcome: "failure",
        error,
        errorType: operation === "iteration" ? "internal" : "dependency",
      });
    } catch {
      // A custom logger must not weaken supervision.
    }
    this.#metric(operation, "failure", 1);
  }

  #metric(
    operation: ArtifactMaintenanceOperation,
    outcome: ArtifactMaintenanceOutcome,
    value: number,
  ): void {
    if (this.#onMetric === undefined || value < 1) return;
    try {
      const pending = this.#onMetric({ operation, outcome, value });
      if (pending !== undefined) {
        void Promise.resolve(pending).catch(() => undefined);
      }
    } catch {
      // Metrics are best effort and cannot interrupt lease processing.
    }
  }

  #removeExternalAbortListener(): void {
    this.#externalSignal?.removeEventListener("abort", this.#externalAbort);
  }
}

export function createArtifactMaintenanceLoop(
  service: ArtifactMaintenanceService,
  options: ArtifactMaintenanceOptions = {},
): ArtifactMaintenanceLoop {
  return new ArtifactMaintenanceLoop(service, options);
}
