import type { Worker } from "bullmq";
import type { RuntimeConfig } from "@relay/config";
import { loadRuntimeConfig } from "@relay/config";
import {
  checkDatabaseHealth,
  checkMigrationLedgerHealth,
  createDatabasePool,
  type DatabasePool,
  MIGRATIONS,
} from "@relay/database";
import {
  CapacityCoordinator,
  capacityKeys,
  type ExecutionLease,
  type RateLimitCheck,
} from "@relay/capacity";
import {
  loadSchedulingClassProfiles,
  WeightedFairScheduler,
} from "@relay/scheduler";
import {
  type AcquiredCapacityLease,
  createExecutionWorker,
  createRedisConnection,
  type DurableCapacityLease,
  type ExecutionCapacityController,
  executionOutboxAction,
  ExecutionProcessor,
  ExecutionQueueRegistry,
  ExecutionSchedulerBridge,
  expireQueuedJobs,
  listEnabledCapacityPoolKeys,
  MAX_SCHEDULER_COST_UNITS,
  reconcileQueueCounters,
  reconcileRedisReset,
  recoverExpiredJobLeases,
  type Redis,
  RedisDispatchGate,
  relayOutboxBatch,
} from "@relay/queue";
import type { ReadinessCheck } from "@relay/contracts";
import {
  createJsonLogger,
  createRelayTelemetry,
  type JsonLogger,
  type LogRecord,
  type RelayTelemetry,
} from "@relay/observability";
import {
  createExecutionHandlerRegistry,
  createRegistryBackedExecutionHandler,
  type ExecutionHandlerRegistry,
} from "./handlers.ts";
import type { ArtifactMaintenanceLoop } from "./artifact-maintenance.ts";
import { createWorkerRuntimeMetrics } from "./metrics.ts";

const EXECUTION_OUTBOX_EVENTS = [
  "job.ready",
  "job.started",
  "job.deferred",
  "job.cancel_requested",
  "job.cancelled",
  "job.terminal",
] as const;

export type WorkerReadinessCheck = (
  pool: DatabasePool,
) => Promise<ReadinessCheck>;

export type ArtifactMaintenanceLifecycle = Pick<
  ArtifactMaintenanceLoop,
  "start" | "stop"
>;

export interface WorkerRuntimeOptions {
  readonly handlerRegistry?: ExecutionHandlerRegistry;
  /** Injected pools remain caller-owned; otherwise startWorker owns its pool. */
  readonly pool?: DatabasePool;
  readonly artifactMaintenance?: ArtifactMaintenanceLifecycle;
  readonly additionalReadinessChecks?: readonly WorkerReadinessCheck[];
  readonly signal?: AbortSignal;
  readonly installSignalHandlers?: boolean;
  readonly instanceId?: string;
  readonly environment?: string;
  readonly queuePrefix?: string;
  readonly concurrency?: number;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly relayPollIntervalMs?: number;
  readonly maintenanceIntervalMs?: number;
  readonly coordinationRetryMs?: number;
  readonly maxDeferralJitterMs?: number;
  readonly maxExecutionAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly retryJitterRatio?: number;
  readonly maxRetryWaitMs?: number;
  readonly shutdownDeadlineMs?: number;
  readonly reconciliationLockMs?: number;
  readonly redisResetCooldownMs?: number;
  readonly schedulerPollIntervalMs?: number;
  readonly schedulerDispatchLeaseMs?: number;
  readonly schedulerDispatchBatchSize?: number;
  readonly schedulerMaxCostUnits?: number;
  readonly schedulerDeficitCapUnits?: number;
  readonly bullmqWaitingLimitPerPool?: number;
  readonly schedulerBufferRetryMs?: number;
  readonly logger?: JsonLogger;
  readonly telemetry?: RelayTelemetry;
  /** Receives the same sanitized fixed-schema records as JsonLogger. */
  readonly log?: (record: LogRecord) => void;
}

interface ResolvedWorkerOptions {
  readonly handlerRegistry: ExecutionHandlerRegistry;
  readonly artifactMaintenance?: ArtifactMaintenanceLifecycle;
  readonly additionalReadinessChecks: readonly WorkerReadinessCheck[];
  readonly signal?: AbortSignal;
  readonly installSignalHandlers: boolean;
  readonly instanceId: string;
  readonly environment: string;
  readonly queuePrefix: string;
  readonly concurrency: number;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly relayPollIntervalMs: number;
  readonly maintenanceIntervalMs: number;
  readonly coordinationRetryMs: number;
  readonly maxDeferralJitterMs: number;
  readonly maxExecutionAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly retryJitterRatio: number;
  readonly maxRetryWaitMs: number;
  readonly shutdownDeadlineMs: number;
  readonly reconciliationLockMs: number;
  readonly redisResetCooldownMs: number;
  readonly schedulerPollIntervalMs: number;
  readonly schedulerDispatchLeaseMs: number;
  readonly schedulerDispatchBatchSize: number;
  readonly schedulerMaxCostUnits: number;
  readonly schedulerDeficitCapUnits: number;
  readonly bullmqWaitingLimitPerPool: number;
  readonly schedulerBufferRetryMs: number;
  readonly logger: JsonLogger;
  readonly telemetry: RelayTelemetry;
}

export interface WorkerRuntimeDependencies {
  readonly createDatabasePool: typeof createDatabasePool;
  readonly createWorkerRuntimeMetrics: typeof createWorkerRuntimeMetrics;
  readonly createRedisConnection: typeof createRedisConnection;
  readonly createExecutionQueueRegistry: (
    connection: Redis,
    queuePrefix: string,
  ) => ExecutionQueueRegistry;
  readonly createRedisDispatchGate: (
    connection: Redis,
    queuePrefix: string,
  ) => RedisDispatchGate;
  readonly createExecutionWorker: typeof createExecutionWorker;
}

const WORKER_RUNTIME_DEPENDENCIES: WorkerRuntimeDependencies = {
  createDatabasePool,
  createWorkerRuntimeMetrics,
  createRedisConnection,
  createExecutionQueueRegistry: (connection, queuePrefix) =>
    new ExecutionQueueRegistry(connection, queuePrefix),
  createRedisDispatchGate: (connection, queuePrefix) =>
    new RedisDispatchGate(connection, queuePrefix),
  createExecutionWorker,
};

function workerLogger(options: WorkerRuntimeOptions): JsonLogger {
  if (options.logger !== undefined) return options.logger;
  if (options.log === undefined) return createJsonLogger();
  return createJsonLogger({
    sink: {
      write(line) {
        options.log?.(JSON.parse(line) as LogRecord);
      },
    },
  });
}

function resolveOptions(
  options: WorkerRuntimeOptions,
  config: RuntimeConfig,
): ResolvedWorkerOptions {
  const environment = options.environment ?? "development";
  const concurrency = options.concurrency ?? 1;
  const schedulerMaxCostUnits = options.schedulerMaxCostUnits ??
    MAX_SCHEDULER_COST_UNITS;
  return {
    handlerRegistry: options.handlerRegistry ??
      createExecutionHandlerRegistry(),
    artifactMaintenance: options.artifactMaintenance,
    additionalReadinessChecks: options.additionalReadinessChecks ?? [],
    signal: options.signal,
    installSignalHandlers: options.installSignalHandlers ?? true,
    instanceId: options.instanceId ?? `worker-${crypto.randomUUID()}`,
    environment,
    queuePrefix: options.queuePrefix ?? `relay:${environment}:bullmq`,
    concurrency,
    leaseDurationMs: options.leaseDurationMs ?? 30_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
    relayPollIntervalMs: options.relayPollIntervalMs ?? 250,
    maintenanceIntervalMs: options.maintenanceIntervalMs ?? 5_000,
    coordinationRetryMs: options.coordinationRetryMs ?? 1_000,
    maxDeferralJitterMs: options.maxDeferralJitterMs ?? 250,
    maxExecutionAttempts: options.maxExecutionAttempts ?? 3,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 1_000,
    retryMaxDelayMs: options.retryMaxDelayMs ?? 60_000,
    retryJitterRatio: options.retryJitterRatio ?? 0.2,
    maxRetryWaitMs: options.maxRetryWaitMs ?? 5 * 60_000,
    shutdownDeadlineMs: options.shutdownDeadlineMs ?? 90_000,
    reconciliationLockMs: options.reconciliationLockMs ?? 30_000,
    redisResetCooldownMs: options.redisResetCooldownMs ??
      Math.max(options.leaseDurationMs ?? 30_000, 60_000),
    schedulerPollIntervalMs: options.schedulerPollIntervalMs ?? 50,
    schedulerDispatchLeaseMs: options.schedulerDispatchLeaseMs ?? 30_000,
    schedulerDispatchBatchSize: options.schedulerDispatchBatchSize ??
      Math.max(1, concurrency * 2),
    schedulerMaxCostUnits,
    schedulerDeficitCapUnits: options.schedulerDeficitCapUnits ??
      schedulerMaxCostUnits,
    bullmqWaitingLimitPerPool: options.bullmqWaitingLimitPerPool ??
      Math.max(1, concurrency * 2),
    schedulerBufferRetryMs: options.schedulerBufferRetryMs ?? 100,
    logger: workerLogger(options),
    telemetry: options.telemetry ?? createRelayTelemetry({
      instrumentationName: "relay-worker",
      instrumentationVersion: config.build.version,
    }),
  };
}

function toExecutionLease(lease: AcquiredCapacityLease): ExecutionLease {
  return {
    ...lease,
    expiresAt: lease.expiresAt.getTime(),
  };
}

export class CoordinatorAdapter implements ExecutionCapacityController {
  constructor(
    private readonly coordinator: CapacityCoordinator,
    private readonly retryMs: number,
    private readonly ownerId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(
    job: Parameters<ExecutionCapacityController["acquire"]>[0],
  ): ReturnType<ExecutionCapacityController["acquire"]> {
    const result = await this.coordinator.acquireExecutionLease(
      {
        toolKey: job.toolKey,
        workspaceId: job.workspaceId,
        poolId: job.capacityPoolId,
      },
      job.capacityLimits,
      {
        ownerId: this.ownerId,
        jobId: job.jobId,
        leaseEpoch: job.leaseEpoch,
        units: job.capacityUnits,
      },
    );
    if (!result.ok) {
      if (result.reason !== "capacity") {
        throw new Error(`Capacity lease ${result.reason}`);
      }
      const reasons = [
        "global_tool_concurrency",
        "provider_concurrency",
        "workspace_concurrency",
        "workspace_tool_concurrency",
      ];
      return {
        kind: "deferred" as const,
        reason: reasons[result.blockedScopeIndex] ?? "capacity_unavailable",
        retryAt: new Date(Date.now() + this.retryMs),
      };
    }
    return {
      kind: "acquired" as const,
      lease: {
        ...result.lease,
        expiresAt: new Date(result.lease.expiresAt),
      },
    };
  }

  async acquireSubmissionPermit(
    job: Parameters<ExecutionCapacityController["acquireSubmissionPermit"]>[0],
  ): ReturnType<ExecutionCapacityController["acquireSubmissionPermit"]> {
    const checks: RateLimitCheck[] = [];
    if (job.submissionRatePolicy.providerPerMinute !== null) {
      checks.push({
        key: this.coordinator.rateKeys.provider(job.providerModelId),
        emissionIntervalMs: 60_000 /
          job.submissionRatePolicy.providerPerMinute,
        burstMs: 0,
        cost: 1,
      });
    }
    if (job.submissionRatePolicy.toolPerMinute !== null) {
      checks.push({
        key: this.coordinator.rateKeys.tool(job.toolKey),
        emissionIntervalMs: 60_000 / job.submissionRatePolicy.toolPerMinute,
        burstMs: 0,
        cost: 1,
      });
    }
    const result = await this.coordinator.acquireSubmissionPermit(
      job.capacityPoolId,
      checks,
    );
    if (result.ok) return { kind: "acquired" as const };
    return {
      kind: "deferred" as const,
      reason: result.blockedReason === "cooldown"
        ? "provider_cooldown"
        : "provider_rate_limit",
      retryAt: new Date(
        Date.now() + Math.max(1, result.retryAfterMs ?? this.retryMs),
      ),
    };
  }

  async setProviderCooldown(
    job: Parameters<ExecutionCapacityController["setProviderCooldown"]>[0],
    expiresAt: Date,
  ): Promise<void> {
    await this.coordinator.setProviderCooldown(
      job.capacityPoolId,
      Math.max(1, expiresAt.getTime() - this.now()),
    );
  }

  async renew(
    _job: Parameters<ExecutionCapacityController["renew"]>[0],
    lease: AcquiredCapacityLease,
  ): Promise<{ readonly ok: boolean; readonly expiresAt?: Date }> {
    const renewed = await this.coordinator.renewExecutionLease(
      toExecutionLease(lease),
    );
    return renewed.ok
      ? { ok: true, expiresAt: new Date(renewed.lease.expiresAt) }
      : { ok: false };
  }

  async release(
    _job: Parameters<ExecutionCapacityController["release"]>[0],
    lease: AcquiredCapacityLease,
  ): Promise<void> {
    await this.coordinator.releaseExecutionLease(toExecutionLease(lease));
  }
}

interface WorkerRecord {
  readonly worker: Worker;
  run?: Promise<void>;
}

export async function acquireReadyConsumer<
  Connection,
  Consumer extends { waitUntilReady(): Promise<unknown> },
  Ownership,
>(
  createConnection: () => Connection,
  ownConnection: (connection: Connection) => void,
  createConsumer: (connection: Connection) => Consumer,
  ownConsumer: (consumer: Consumer) => Ownership,
): Promise<{ readonly consumer: Consumer; readonly ownership: Ownership }> {
  const connection = createConnection();
  ownConnection(connection);
  const consumer = createConsumer(connection);
  const ownership = ownConsumer(consumer);
  await consumer.waitUntilReady();
  return { consumer, ownership };
}

export interface ClosableWorker {
  pause(doNotWaitActive?: boolean): Promise<void>;
  close(force?: boolean): Promise<void>;
}

type CompletionStatus = "fulfilled" | "rejected" | "timeout";

function remainingBudgetMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

function invokeAsync(action: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(action);
}

async function allSuccessful(
  promises: readonly Promise<unknown>[],
): Promise<void> {
  const results = await Promise.allSettled(promises);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "One or more lifecycle operations failed");
  }
}

async function completionBefore(
  promise: Promise<unknown>,
  deadlineAt: number,
): Promise<CompletionStatus> {
  const remaining = remainingBudgetMs(deadlineAt);
  if (remaining === 0) {
    void promise.catch(() => undefined);
    return "timeout";
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race<CompletionStatus>([
    promise.then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    ),
    new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), remaining);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
}

interface OwnedRedisConnection {
  readonly connection: Redis;
  readonly close: () => Promise<void>;
  readonly forceDisconnect: () => void;
}

function ownRedisConnection(connection: Redis): OwnedRedisConnection {
  let disposed = connection.status === "end";
  let closeTask: Promise<void> | undefined;
  const forceDisconnect = () => {
    if (disposed || connection.status === "end") {
      disposed = true;
      return;
    }
    disposed = true;
    connection.disconnect(false);
  };
  const close = () => {
    closeTask ??= (async () => {
      if (disposed || connection.status === "end") {
        disposed = true;
        return;
      }
      try {
        await connection.quit();
        disposed = true;
      } catch {
        forceDisconnect();
      }
    })();
    return closeTask;
  };
  return { connection, close, forceDisconnect };
}

/** Owns one maintenance start/stop pair and exposes its full termination. */
export class ArtifactMaintenanceOwner {
  readonly #stopOnce: () => Promise<void>;
  #startTask: Promise<void> | undefined;
  #terminationTask: Promise<void> | undefined;
  #stopping = false;
  #terminated = false;

  constructor(
    private readonly lifecycle: ArtifactMaintenanceLifecycle,
    private readonly onUnexpectedStop: (error?: unknown) => void,
  ) {
    let stopTask: Promise<void> | undefined;
    this.#stopOnce = () => {
      stopTask ??= invokeAsync(() => this.lifecycle.stop());
      return stopTask;
    };
  }

  get terminated(): boolean {
    return this.#terminated;
  }

  start(): Promise<void> {
    this.#startTask ??= (async () => {
      try {
        await this.lifecycle.start();
        if (!this.#stopping) this.reportUnexpectedStop();
      } catch (error) {
        if (!this.#stopping) this.reportUnexpectedStop(error);
      }
    })();
    return this.#startTask;
  }

  terminate(): Promise<void> {
    this.#stopping = true;
    if (this.#startTask === undefined) return Promise.resolve();
    this.#terminationTask ??= allSuccessful([
      this.#startTask,
      this.#stopOnce(),
    ]);
    void this.#terminationTask.then(
      () => {
        this.#terminated = true;
      },
      () => {
        this.#terminated = true;
      },
    );
    return this.#terminationTask;
  }

  private reportUnexpectedStop(error?: unknown): void {
    try {
      this.onUnexpectedStop(error);
    } catch {
      // Lifecycle ownership must not be defeated by an observer failure.
    }
  }
}

/** Stops intake, drains, aborts, and closes under one absolute time budget. */
export async function gracefullyCloseWorkers(
  workers: readonly ClosableWorker[],
  waitForIdle: () => Promise<void>,
  abortActive: () => void,
  deadlineMs: number,
): Promise<{ readonly forced: boolean }> {
  const deadlineAt = Date.now() + Math.max(0, deadlineMs);
  let forced = (await completionBefore(
    allSuccessful(
      workers.map((worker) => invokeAsync(() => worker.pause(true))),
    ),
    deadlineAt,
  )) !== "fulfilled";

  if (!forced) {
    forced = (await completionBefore(invokeAsync(waitForIdle), deadlineAt)) !==
      "fulfilled";
  }
  if (forced) {
    try {
      abortActive();
    } catch {
      // Continue force-closing every worker even if active abortion fails.
    }
  }

  const closed = await completionBefore(
    allSuccessful(
      workers.map((worker) => invokeAsync(() => worker.close(forced))),
    ),
    deadlineAt,
  );
  if (closed !== "fulfilled") forced = true;
  return { forced };
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

async function releaseDurableRedisLease(
  coordinator: CapacityCoordinator,
  environment: string,
  lease: DurableCapacityLease,
): Promise<void> {
  await coordinator.releaseExecutionLease({
    leaseId: lease.redisLeaseId,
    ownerId: lease.ownerId,
    jobId: lease.jobId,
    leaseEpoch: lease.leaseEpoch,
    units: lease.units,
    expiresAt: lease.expiresAt.getTime(),
    jobKey: capacityKeys.executionLeaseJobKey(environment, lease.jobId),
    scopeKeys: lease.redisScopeKeys,
  });
}

const RESTORE_CAPACITY_LEASE_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local expires_at = tonumber(ARGV[2])
if expires_at <= now then return 0 end

for i = 2, #KEYS do
  local scope_key = KEYS[i]
  local metadata_key = scope_key .. ':leases'
  redis.call('ZADD', scope_key, expires_at, ARGV[1])
  redis.call('HSET', metadata_key, ARGV[1], ARGV[3])
  local latest = redis.call('ZREVRANGE', scope_key, 0, 0, 'WITHSCORES')
  local scope_expires_at = math.ceil(tonumber(latest[2]))
  redis.call('PEXPIREAT', scope_key, scope_expires_at)
  redis.call('PEXPIREAT', metadata_key, scope_expires_at)
end
redis.call('SET', KEYS[1], ARGV[4], 'PXAT', expires_at)
return 1
`.trim();

export async function restoreDurableRedisLease(
  redis: Redis,
  environment: string,
  lease: DurableCapacityLease,
): Promise<void> {
  const expiresAt = lease.expiresAt.getTime();
  const jobKey = capacityKeys.executionLeaseJobKey(environment, lease.jobId);
  const scopeMetadata = JSON.stringify({
    units: lease.units,
    ownerId: lease.ownerId,
    jobId: lease.jobId,
    leaseEpoch: lease.leaseEpoch,
  });
  const fence = JSON.stringify({
    leaseId: lease.redisLeaseId,
    ownerId: lease.ownerId,
    jobId: lease.jobId,
    leaseEpoch: lease.leaseEpoch,
    units: lease.units,
    expiresAt,
    scopeKeys: lease.redisScopeKeys,
  });
  await redis.eval(
    RESTORE_CAPACITY_LEASE_SCRIPT,
    lease.redisScopeKeys.length + 1,
    jobKey,
    ...lease.redisScopeKeys,
    lease.redisLeaseId,
    expiresAt,
    scopeMetadata,
    fence,
  );
}

async function checkRedisHealth(
  connections: readonly Pick<Redis, "ping">[],
): Promise<ReadinessCheck> {
  try {
    await Promise.all(connections.map((connection) => connection.ping()));
    return { name: "redis", status: "ok" };
  } catch {
    return { name: "redis", status: "error", message: "unreachable" };
  }
}

export async function checkWorkerReadiness(
  pool: DatabasePool,
  redisConnections: readonly Pick<Redis, "ping">[],
  additionalChecks: readonly WorkerReadinessCheck[] = [],
): Promise<readonly ReadinessCheck[]> {
  return await Promise.all([
    checkDatabaseHealth(pool),
    checkMigrationLedgerHealth(pool, MIGRATIONS),
    checkRedisHealth(redisConnections),
    ...additionalChecks.map((check) => check(pool)),
  ]);
}

/**
 * Starts the real relay/consumer process and resolves only after shutdown.
 * Provider behavior is deliberately injected; this package does not pretend a
 * production provider exists before one is implemented.
 */
export async function startWorker(
  config: RuntimeConfig = loadRuntimeConfig(),
  runtimeOptions: WorkerRuntimeOptions = {},
  dependencyOverrides: Partial<WorkerRuntimeDependencies> = {},
): Promise<void> {
  const dependencies = {
    ...WORKER_RUNTIME_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const options = resolveOptions(runtimeOptions, config);
  const lifecycle = new AbortController();
  const stop = () => lifecycle.abort("shutdown_requested");
  const externalAbort = () => stop();
  const signals: Deno.Signal[] = ["SIGINT"];
  if (Deno.build.os !== "windows") signals.push("SIGTERM");

  const installedSignals: Deno.Signal[] = [];
  const redisConnections: OwnedRedisConnection[] = [];
  const workerRecords = new Map<string, WorkerRecord>();
  const loopTasks: Promise<void>[] = [];
  let externalAbortInstalled = false;
  let closeOwnedPool: (() => Promise<void>) | undefined;
  let disposeRuntimeMetrics: (() => Promise<void>) | undefined;
  let closeQueues: (() => Promise<void>) | undefined;
  let processor: ExecutionProcessor | undefined;
  let artifactMaintenanceOwner: ArtifactMaintenanceOwner | undefined;
  let artifactMaintenanceFailure: unknown;

  try {
    if (options.signal !== undefined) {
      options.signal.addEventListener("abort", externalAbort, { once: true });
      externalAbortInstalled = true;
      if (options.signal.aborted) stop();
    }
    if (options.installSignalHandlers) {
      for (const signal of signals) {
        Deno.addSignalListener(signal, stop);
        installedSignals.push(signal);
      }
    }

    const ownsPool = runtimeOptions.pool === undefined;
    const pool = runtimeOptions.pool ??
      dependencies.createDatabasePool(config.database, "relay-worker");
    if (ownsPool) {
      let poolCloseTask: Promise<void> | undefined;
      closeOwnedPool = () => {
        poolCloseTask ??= invokeAsync(() => pool.end());
        return poolCloseTask;
      };
    }

    const runtimeMetrics = dependencies.createWorkerRuntimeMetrics(
      pool,
      options.telemetry,
    );
    let metricsDisposeTask: Promise<void> | undefined;
    disposeRuntimeMetrics = () => {
      metricsDisposeTask ??= invokeAsync(() => runtimeMetrics.dispose());
      return metricsDisposeTask;
    };

    const acquireRedis = (connectionName: string): Redis => {
      const owned = ownRedisConnection(
        dependencies.createRedisConnection(config.redis, connectionName),
      );
      redisConnections.push(owned);
      return owned.connection;
    };
    const producerRedis = acquireRedis(
      `${options.instanceId}-queue-producer`,
    );
    const capacityRedis = acquireRedis(`${options.instanceId}-capacity`);
    const schedulerRedis = acquireRedis(`${options.instanceId}-scheduler`);
    const cancellationRedis = acquireRedis(
      `${options.instanceId}-cancellation-subscriber`,
    );
    const cancellationChannel =
      `${options.queuePrefix}:execution-cancellations`;
    const queues = dependencies.createExecutionQueueRegistry(
      producerRedis,
      options.queuePrefix,
    );
    let queueCloseTask: Promise<void> | undefined;
    closeQueues = () => {
      queueCloseTask ??= invokeAsync(() => queues.close());
      return queueCloseTask;
    };

    const gate = dependencies.createRedisDispatchGate(
      capacityRedis,
      options.queuePrefix,
    );
    const coordinator = new CapacityCoordinator(capacityRedis, {
      env: options.environment,
      leaseDurationMs: options.leaseDurationMs,
    });
    const scheduler = new WeightedFairScheduler(schedulerRedis, {
      env: options.environment,
      dispatchLeaseDurationMs: options.schedulerDispatchLeaseMs,
      maxCostUnits: options.schedulerMaxCostUnits,
      idleDeficitCapUnits: options.schedulerDeficitCapUnits,
    });
    const executionProcessor = new ExecutionProcessor(
      pool,
      new CoordinatorAdapter(
        coordinator,
        options.coordinationRetryMs,
        options.instanceId,
      ),
      gate,
      createRegistryBackedExecutionHandler(pool, options.handlerRegistry),
      {
        leaseOwner: options.instanceId,
        leaseDurationMs: options.leaseDurationMs,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        coordinationRetryMs: options.coordinationRetryMs,
        maxDeferralJitterMs: options.maxDeferralJitterMs,
        maxExecutionAttempts: options.maxExecutionAttempts,
        retryBaseDelayMs: options.retryBaseDelayMs,
        retryMaxDelayMs: options.retryMaxDelayMs,
        retryJitterRatio: options.retryJitterRatio,
        maxRetryWaitMs: options.maxRetryWaitMs,
        telemetry: options.telemetry,
      },
    );
    processor = executionProcessor;
    const schedulerBridge = new ExecutionSchedulerBridge(
      pool,
      schedulerRedis,
      scheduler,
      queues,
      {
        environment: options.environment,
        maxBullmqWaitingPerPool: options.bullmqWaitingLimitPerPool,
        maxDispatchesPerIteration: options.schedulerDispatchBatchSize,
        bufferRetryDelayMs: options.schedulerBufferRetryMs,
        poolBufferLockDurationMs: options.schedulerDispatchLeaseMs,
      },
    );
    cancellationRedis.on("message", (channel, jobId) => {
      if (channel === cancellationChannel) executionProcessor.abortJob(jobId);
    });

    const syncConsumers = async () => {
      if (options.handlerRegistry.keys.size === 0) {
        await Promise.allSettled(
          [...workerRecords.values()].map((record) =>
            record.worker.pause(true)
          ),
        );
        return;
      }
      for (const capacityPoolKey of await listEnabledCapacityPoolKeys(pool)) {
        const existing = workerRecords.get(capacityPoolKey);
        if (existing !== undefined) {
          await existing.worker.resume();
          continue;
        }
        const { consumer: worker, ownership: record } =
          await acquireReadyConsumer(
            () =>
              dependencies.createRedisConnection(
                config.redis,
                `${options.instanceId}-consumer-${capacityPoolKey}`,
              ),
            (connection) => {
              redisConnections.push(ownRedisConnection(connection));
            },
            (connection) =>
              dependencies.createExecutionWorker(
                connection,
                capacityPoolKey,
                options.queuePrefix,
                executionProcessor.processor,
                {
                  concurrency: options.concurrency,
                  lockDuration: options.leaseDurationMs,
                  stalledInterval: Math.max(1_000, options.heartbeatIntervalMs),
                  maxStalledCount: 1,
                },
              ),
            (worker) => {
              const record: WorkerRecord = { worker };
              workerRecords.set(capacityPoolKey, record);
              worker.on("error", (error) =>
                options.logger.error({
                  eventName: "worker.bullmq.error",
                  message: "BullMQ worker error",
                  operation: "consume",
                  outcome: "failure",
                  error,
                }));
              worker.on("failed", (_job, error) =>
                options.logger.error({
                  eventName: "worker.ticket.failed",
                  message: "BullMQ ticket failed",
                  operation: "consume",
                  outcome: "failure",
                  error,
                }));
              return record;
            },
          );
        record.run = worker.run().catch((error) => {
          if (!lifecycle.signal.aborted) {
            options.logger.error({
              eventName: "worker.consumer.stopped",
              message: "BullMQ consumer stopped unexpectedly",
              operation: "consume",
              outcome: "failure",
              error,
            });
            lifecycle.abort("consumer_failed");
          }
        });
      }
    };

    const releaseRecoveredLeases = async (
      leases: readonly DurableCapacityLease[],
    ) => {
      for (const lease of leases) {
        await releaseDurableRedisLease(
          coordinator,
          options.environment,
          lease,
        );
      }
    };

    const maintain = async () => {
      await expireQueuedJobs(pool);
      await scheduler.configureProfiles(
        await loadSchedulingClassProfiles(pool),
      );
      if (!(await gate.isReady())) {
        const reconciliation = await reconcileRedisReset(
          pool,
          gate,
          {
            restoreCapacityLease: (lease) =>
              restoreDurableRedisLease(
                capacityRedis,
                options.environment,
                lease,
              ),
            releaseCapacityLease: (lease) =>
              releaseDurableRedisLease(
                coordinator,
                options.environment,
                lease,
              ),
            rebuildScheduler: () => schedulerBridge.rebuildAll(),
          },
          {
            owner: options.instanceId,
            lockDurationMs: options.reconciliationLockMs,
            conservativeDelayMs: options.redisResetCooldownMs,
            retryWaitMs: options.maxRetryWaitMs,
          },
        );
        if (reconciliation.kind === "reconciled") {
          runtimeMetrics.recordReconciledJobs(reconciliation.recoveredJobs);
        }
      } else {
        const stalled = await recoverExpiredJobLeases(
          pool,
          undefined,
          100,
          options.maxRetryWaitMs,
        );
        runtimeMetrics.recordReconciledJobs(
          stalled.recovered + stalled.cancelled + stalled.failed,
        );
        await releaseRecoveredLeases(stalled.capacityLeasesToRelease);
        await reconcileQueueCounters(pool);
        await schedulerBridge.rebuildAll();
      }
      await syncConsumers();
      void runtimeMetrics.refresh();
      runtimeMetrics.heartbeat();
    };

    const readiness = await checkWorkerReadiness(
      pool,
      [producerRedis, capacityRedis, schedulerRedis, cancellationRedis],
      options.additionalReadinessChecks,
    );
    if (readiness.some((check) => check.status !== "ok")) {
      throw new Error("Worker dependencies are not ready");
    }
    await cancellationRedis.subscribe(cancellationChannel);
    await maintain();

    if (
      !lifecycle.signal.aborted && options.artifactMaintenance !== undefined
    ) {
      const owner = new ArtifactMaintenanceOwner(
        options.artifactMaintenance,
        (error) => {
          artifactMaintenanceFailure = error ?? new Error(
            "Artifact maintenance stopped unexpectedly",
          );
          lifecycle.abort(
            error === undefined
              ? "artifact_maintenance_stopped"
              : "artifact_maintenance_failed",
          );
          try {
            options.logger.error({
              eventName: "worker.artifact_maintenance.stopped",
              message: "Artifact maintenance stopped unexpectedly",
              operation: "artifact_maintenance",
              outcome: "failure",
              error: artifactMaintenanceFailure,
            });
          } catch {
            // The lifecycle failure still owns shutdown if logging fails.
          }
        },
      );
      artifactMaintenanceOwner = owner;
      void owner.start();
    }

    loopTasks.push((async () => {
      while (!lifecycle.signal.aborted) {
        try {
          if (await gate.isReady()) {
            await relayOutboxBatch(
              pool,
              async (event) => {
                const action = executionOutboxAction(event);
                if (action.kind === "cancel") {
                  executionProcessor.abortJob(action.payload.domainJobId);
                  await producerRedis.publish(
                    cancellationChannel,
                    action.payload.domainJobId,
                  );
                }
                await schedulerBridge.handleOutboxEvent(event);
              },
              {
                leaseOwner: options.instanceId,
                leaseDurationMs: 30_000,
                batchSize: 50,
                maxAttempts: 8,
                baseDelayMs: 500,
                maxDelayMs: 60_000,
                jitterRatio: 0.2,
                eventTypes: EXECUTION_OUTBOX_EVENTS,
              },
            );
          }
        } catch (error) {
          options.logger.error({
            eventName: "worker.outbox.failed",
            message: "Outbox relay iteration failed",
            operation: "outbox",
            outcome: "failure",
            error,
          });
        }
        await wait(options.relayPollIntervalMs, lifecycle.signal);
      }
    })());

    loopTasks.push((async () => {
      while (!lifecycle.signal.aborted) {
        try {
          if (
            options.handlerRegistry.keys.size > 0 &&
            await gate.isReady()
          ) {
            const dispatch = await schedulerBridge.dispatchBatch(
              options.instanceId,
            );
            if (dispatch.failed > 0 || dispatch.lostLease > 0) {
              options.logger.warn({
                eventName: "worker.scheduler.degraded",
                message:
                  "Scheduler dispatch completed with recoverable failures",
                operation: "dispatch",
                outcome: "failure",
              });
            }
          }
        } catch (error) {
          options.logger.error({
            eventName: "worker.scheduler.failed",
            message: "Scheduler dispatch iteration failed",
            operation: "dispatch",
            outcome: "failure",
            error,
          });
        }
        await wait(options.schedulerPollIntervalMs, lifecycle.signal);
      }
    })());

    loopTasks.push((async () => {
      while (!lifecycle.signal.aborted) {
        await wait(options.maintenanceIntervalMs, lifecycle.signal);
        if (lifecycle.signal.aborted) break;
        try {
          await maintain();
        } catch (error) {
          options.logger.error({
            eventName: "worker.reconciliation.failed",
            message: "Execution reconciliation failed; dispatch remains closed",
            operation: "reconcile",
            outcome: "failure",
            error,
          });
        }
      }
    })());

    options.logger.info({
      eventName: "worker.started",
      message: "Worker started",
      operation: "startup",
      outcome: "success",
    });

    if (options.signal?.aborted) stop();
    if (!lifecycle.signal.aborted) {
      await new Promise<void>((resolve) =>
        lifecycle.signal.addEventListener("abort", () => resolve(), {
          once: true,
        })
      );
    }
    if (artifactMaintenanceFailure !== undefined) {
      throw new Error("Artifact maintenance lifecycle failed", {
        cause: artifactMaintenanceFailure,
      });
    }
  } finally {
    const shutdownDeadlineAt = Date.now() + options.shutdownDeadlineMs;
    let forced = false;
    lifecycle.abort("shutdown_requested");

    const maintenanceTermination = artifactMaintenanceOwner?.terminate();
    const backgroundTasks = [...loopTasks];
    if (maintenanceTermination !== undefined) {
      backgroundTasks.push(maintenanceTermination);
    }
    const backgroundStatus = await completionBefore(
      allSuccessful(backgroundTasks),
      shutdownDeadlineAt,
    );
    if (backgroundStatus !== "fulfilled") {
      forced = true;
      try {
        processor?.abortActive();
      } catch {
        // Continue through the remaining owned resources.
      }
    }
    if (
      backgroundStatus === "timeout" &&
      artifactMaintenanceOwner !== undefined &&
      !artifactMaintenanceOwner.terminated
    ) {
      try {
        options.logger.error({
          eventName: "worker.artifact_maintenance.shutdown_timeout",
          message:
            "Artifact maintenance exceeded the shutdown deadline; waiting for termination before releasing dependencies",
          operation: "artifact_maintenance",
          outcome: "timeout",
        });
      } catch {
        // Cleanup must continue even if the log sink fails.
      }
    }

    const records = [...workerRecords.values()];
    const shutdown = await gracefullyCloseWorkers(
      records.map((record) => record.worker),
      () => processor?.waitForIdle() ?? Promise.resolve(),
      () => processor?.abortActive(),
      remainingBudgetMs(shutdownDeadlineAt),
    );
    forced ||= shutdown.forced;

    const runTasks = records.flatMap((record) =>
      record.run === undefined ? [] : [record.run]
    );
    if (
      (await completionBefore(
        allSuccessful(runTasks),
        shutdownDeadlineAt,
      )) !== "fulfilled"
    ) forced = true;
    if (
      closeQueues !== undefined &&
      (await completionBefore(closeQueues(), shutdownDeadlineAt)) !==
        "fulfilled"
    ) forced = true;
    if (
      (await completionBefore(
        allSuccessful(redisConnections.map((owned) => owned.close())),
        shutdownDeadlineAt,
      )) !== "fulfilled"
    ) forced = true;

    if (forced) {
      for (const owned of redisConnections) {
        try {
          owned.forceDisconnect();
        } catch {
          // Attempt every owned connection exactly once.
        }
      }
    }

    if (externalAbortInstalled) {
      try {
        options.signal?.removeEventListener("abort", externalAbort);
      } catch {
        forced = true;
      }
      externalAbortInstalled = false;
    }
    for (const signal of installedSignals.splice(0)) {
      try {
        Deno.removeSignalListener(signal, stop);
      } catch {
        forced = true;
      }
    }
    if (
      disposeRuntimeMetrics !== undefined &&
      (await completionBefore(
          disposeRuntimeMetrics(),
          shutdownDeadlineAt,
        )) !== "fulfilled"
    ) forced = true;

    if (maintenanceTermination !== undefined) {
      try {
        await maintenanceTermination;
      } catch {
        forced = true;
      }
    }

    if (
      closeOwnedPool !== undefined &&
      (await completionBefore(closeOwnedPool(), shutdownDeadlineAt)) !==
        "fulfilled"
    ) forced = true;

    try {
      options.logger.info({
        eventName: "worker.stopped",
        message: "Worker stopped",
        operation: "shutdown",
        outcome: forced ? "timeout" : "success",
      });
    } catch {
      // All owned resources have already received their disposal request.
    }
  }
}

export {
  createExecutionHandlerRegistry,
  createRegistryBackedExecutionHandler,
} from "./handlers.ts";
export type {
  ExecutionHandlerRegistry,
  RegisteredExecutionHandler,
} from "./handlers.ts";
export type { DatabasePool };
