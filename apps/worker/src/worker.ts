import type { Worker } from "bullmq";
import type { RuntimeConfig } from "@relay/config";
import { loadRuntimeConfig } from "@relay/config";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import {
  CapacityCoordinator,
  capacityKeys,
  type ExecutionLease,
} from "@relay/capacity";
import {
  type AcquiredCapacityLease,
  createExecutionWorker,
  createRedisConnection,
  type DurableCapacityLease,
  type ExecutionCapacityController,
  type ExecutionHandler,
  executionOutboxAction,
  ExecutionProcessor,
  ExecutionQueueRegistry,
  expireQueuedJobs,
  listEnabledCapacityPoolKeys,
  reconcileLostTickets,
  reconcileQueueCounters,
  reconcileRedisReset,
  recoverExpiredJobLeases,
  type Redis,
  RedisDispatchGate,
  relayOutboxBatch,
} from "@relay/queue";

const EXECUTION_OUTBOX_EVENTS = [
  "job.ready",
  "job.deferred",
  "job.cancel_requested",
  "job.cancelled",
] as const;

export interface WorkerRuntimeOptions {
  /** Required until a real provider adapter is composed by the application. */
  readonly executionHandler?: ExecutionHandler;
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
  readonly log?: (record: Readonly<Record<string, unknown>>) => void;
}

interface ResolvedWorkerOptions {
  readonly executionHandler: ExecutionHandler;
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
  readonly log: (record: Readonly<Record<string, unknown>>) => void;
}

function resolveOptions(options: WorkerRuntimeOptions): ResolvedWorkerOptions {
  if (options.executionHandler === undefined) {
    throw new Error(
      "Worker executionHandler is required; no fake production provider is installed",
    );
  }
  const environment = options.environment ?? "development";
  return {
    executionHandler: options.executionHandler,
    signal: options.signal,
    installSignalHandlers: options.installSignalHandlers ?? true,
    instanceId: options.instanceId ?? `worker-${crypto.randomUUID()}`,
    environment,
    queuePrefix: options.queuePrefix ?? `relay:${environment}:bullmq`,
    concurrency: options.concurrency ?? 1,
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
    log: options.log ?? ((record) => console.log(JSON.stringify(record))),
  };
}

function toExecutionLease(lease: AcquiredCapacityLease): ExecutionLease {
  return {
    ...lease,
    expiresAt: lease.expiresAt.getTime(),
  };
}

class CoordinatorAdapter implements ExecutionCapacityController {
  constructor(
    private readonly coordinator: CapacityCoordinator,
    private readonly retryMs: number,
    private readonly ownerId: string,
  ) {}

  async acquire(job: Parameters<ExecutionCapacityController["acquire"]>[0]) {
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
  ) {
    // Rate-limit checks require provider policy data that is not yet present in
    // ClaimedJob. Passing no GCRA checks still atomically enforces the pool's
    // provider cooldown before any attempt is opened.
    const result = await this.coordinator.acquireSubmissionPermit(
      job.capacityPoolId,
      [],
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
      expiresAt.getTime(),
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
  readonly connection: Redis;
  readonly run: Promise<void>;
}

export interface ClosableWorker {
  pause(doNotWaitActive?: boolean): Promise<void>;
  close(force?: boolean): Promise<void>;
}

function remainingBudgetMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

async function settlesBefore(
  promise: Promise<unknown>,
  deadlineAt: number,
): Promise<boolean> {
  const remaining = remainingBudgetMs(deadlineAt);
  if (remaining === 0) {
    void promise.catch(() => undefined);
    return false;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), remaining);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
}

/** Stops intake, drains, aborts, and closes under one absolute time budget. */
export async function gracefullyCloseWorkers(
  workers: readonly ClosableWorker[],
  waitForIdle: () => Promise<void>,
  abortActive: () => void,
  deadlineMs: number,
): Promise<{ readonly forced: boolean }> {
  const deadlineAt = Date.now() + Math.max(0, deadlineMs);
  let forced = !(await settlesBefore(
    Promise.allSettled(workers.map((worker) => worker.pause(true))),
    deadlineAt,
  ));

  if (!forced) {
    forced = !(await settlesBefore(waitForIdle(), deadlineAt));
  }
  if (forced) abortActive();

  const closed = await settlesBefore(
    Promise.allSettled(workers.map((worker) => worker.close(forced))),
    deadlineAt,
  );
  if (!closed) forced = true;
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

async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === "end") return;
  try {
    await redis.quit();
  } catch {
    redis.disconnect(false);
  }
}

/**
 * Starts the real relay/consumer process and resolves only after shutdown.
 * Provider behavior is deliberately injected; this package does not pretend a
 * production provider exists before one is implemented.
 */
export async function startWorker(
  config: RuntimeConfig = loadRuntimeConfig(),
  runtimeOptions: WorkerRuntimeOptions = {},
): Promise<void> {
  const options = resolveOptions(runtimeOptions);
  const lifecycle = new AbortController();
  const stop = () => lifecycle.abort("shutdown_requested");
  const externalAbort = () => stop();
  options.signal?.addEventListener("abort", externalAbort, { once: true });

  const signals: Deno.Signal[] = ["SIGINT"];
  if (Deno.build.os !== "windows") signals.push("SIGTERM");
  if (options.installSignalHandlers) {
    for (const signal of signals) Deno.addSignalListener(signal, stop);
  }

  const pool = createDatabasePool(config.database, "relay-worker");
  const producerRedis = createRedisConnection(
    config.redis,
    `${options.instanceId}-queue-producer`,
  );
  const capacityRedis = createRedisConnection(
    config.redis,
    `${options.instanceId}-capacity`,
  );
  const cancellationRedis = createRedisConnection(
    config.redis,
    `${options.instanceId}-cancellation-subscriber`,
  );
  const cancellationChannel = `${options.queuePrefix}:execution-cancellations`;
  const queues = new ExecutionQueueRegistry(
    producerRedis,
    options.queuePrefix,
  );
  const gate = new RedisDispatchGate(capacityRedis, options.queuePrefix);
  const coordinator = new CapacityCoordinator(capacityRedis, {
    env: options.environment,
    leaseDurationMs: options.leaseDurationMs,
  });
  const processor = new ExecutionProcessor(
    pool,
    new CoordinatorAdapter(
      coordinator,
      options.coordinationRetryMs,
      options.instanceId,
    ),
    gate,
    options.executionHandler,
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
    },
  );
  const workerRecords = new Map<string, WorkerRecord>();
  const loopTasks: Promise<void>[] = [];
  cancellationRedis.on("message", (channel, jobId) => {
    if (channel === cancellationChannel) processor.abortJob(jobId);
  });

  const syncConsumers = async () => {
    for (const capacityPoolKey of await listEnabledCapacityPoolKeys(pool)) {
      if (workerRecords.has(capacityPoolKey)) continue;
      const connection = createRedisConnection(
        config.redis,
        `${options.instanceId}-consumer-${capacityPoolKey}`,
      );
      const worker = createExecutionWorker(
        connection,
        capacityPoolKey,
        options.queuePrefix,
        processor.processor,
        {
          concurrency: options.concurrency,
          lockDuration: options.leaseDurationMs,
          stalledInterval: Math.max(1_000, options.heartbeatIntervalMs),
          maxStalledCount: 1,
        },
      );
      worker.on("error", (error) =>
        options.log({
          level: "error",
          service: "worker",
          message: "BullMQ worker error",
          capacityPoolKey,
          error: error.message,
        }));
      worker.on("failed", (job, error) =>
        options.log({
          level: "error",
          service: "worker",
          message: "BullMQ ticket failed",
          capacityPoolKey,
          ticketId: job?.id,
          error: error.message,
        }));
      await worker.waitUntilReady();
      const run = worker.run().catch((error) => {
        if (!lifecycle.signal.aborted) {
          options.log({
            level: "error",
            service: "worker",
            message: "BullMQ consumer stopped unexpectedly",
            capacityPoolKey,
            error: error instanceof Error ? error.message : String(error),
          });
          lifecycle.abort("consumer_failed");
        }
      });
      workerRecords.set(capacityPoolKey, { worker, connection, run });
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
    if (!(await gate.isReady())) {
      await reconcileRedisReset(
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
          hasRunnableTicket: (payload) => queues.hasRunnableTicket(payload),
        },
        {
          owner: options.instanceId,
          lockDurationMs: options.reconciliationLockMs,
          conservativeDelayMs: options.redisResetCooldownMs,
          retryWaitMs: options.maxRetryWaitMs,
        },
      );
    } else {
      const stalled = await recoverExpiredJobLeases(
        pool,
        undefined,
        100,
        options.maxRetryWaitMs,
      );
      await releaseRecoveredLeases(stalled.capacityLeasesToRelease);
      await reconcileQueueCounters(pool);
      await reconcileLostTickets(
        pool,
        (payload) => queues.hasRunnableTicket(payload),
      );
    }
    await syncConsumers();
  };

  try {
    await Promise.all([
      pool.query("select 1"),
      producerRedis.ping(),
      capacityRedis.ping(),
      cancellationRedis.ping(),
    ]);
    await cancellationRedis.subscribe(cancellationChannel);
    await maintain();

    loopTasks.push((async () => {
      while (!lifecycle.signal.aborted) {
        try {
          if (await gate.isReady()) {
            await relayOutboxBatch(
              pool,
              async (event) => {
                const action = executionOutboxAction(event);
                if (action.kind === "cancel") {
                  processor.abortJob(action.payload.domainJobId);
                  await producerRedis.publish(
                    cancellationChannel,
                    action.payload.domainJobId,
                  );
                }
                await queues.publishOutboxEvent(event);
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
          options.log({
            level: "error",
            service: "worker",
            message: "Outbox relay iteration failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await wait(options.relayPollIntervalMs, lifecycle.signal);
      }
    })());

    loopTasks.push((async () => {
      while (!lifecycle.signal.aborted) {
        await wait(options.maintenanceIntervalMs, lifecycle.signal);
        if (lifecycle.signal.aborted) break;
        try {
          await maintain();
        } catch (error) {
          options.log({
            level: "error",
            service: "worker",
            message: "Execution reconciliation failed; dispatch remains closed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })());

    options.log({
      level: "info",
      service: "worker",
      message: "Worker started",
      instanceId: options.instanceId,
      consumers: workerRecords.size,
      version: config.build.version,
      revision: config.build.revision,
    });

    if (options.signal?.aborted) stop();
    if (!lifecycle.signal.aborted) {
      await new Promise<void>((resolve) =>
        lifecycle.signal.addEventListener("abort", () => resolve(), {
          once: true,
        })
      );
    }
  } finally {
    const shutdownDeadlineAt = Date.now() + options.shutdownDeadlineMs;
    let forced = false;
    lifecycle.abort("shutdown_requested");

    if (
      !(await settlesBefore(Promise.allSettled(loopTasks), shutdownDeadlineAt))
    ) {
      forced = true;
      processor.abortActive();
    }

    const records = [...workerRecords.values()];
    const shutdown = await gracefullyCloseWorkers(
      records.map((record) => record.worker),
      () => processor.waitForIdle(),
      () => processor.abortActive(),
      remainingBudgetMs(shutdownDeadlineAt),
    );
    forced ||= shutdown.forced;

    if (
      !(await settlesBefore(
        Promise.allSettled(records.map((record) => record.run)),
        shutdownDeadlineAt,
      ))
    ) forced = true;
    if (!(await settlesBefore(queues.close(), shutdownDeadlineAt))) {
      forced = true;
    }
    if (
      !(await settlesBefore(
        Promise.allSettled(
          records.map((record) => closeRedis(record.connection)),
        ),
        shutdownDeadlineAt,
      ))
    ) forced = true;
    if (
      !(await settlesBefore(
        Promise.allSettled([
          closeRedis(producerRedis),
          closeRedis(capacityRedis),
          closeRedis(cancellationRedis),
        ]),
        shutdownDeadlineAt,
      ))
    ) forced = true;
    if (!(await settlesBefore(pool.end(), shutdownDeadlineAt))) forced = true;

    if (forced) {
      for (const record of records) record.connection.disconnect(false);
      producerRedis.disconnect(false);
      capacityRedis.disconnect(false);
      cancellationRedis.disconnect(false);
    }

    options.signal?.removeEventListener("abort", externalAbort);
    if (options.installSignalHandlers) {
      for (const signal of signals) Deno.removeSignalListener(signal, stop);
    }
    options.log({
      level: "info",
      service: "worker",
      message: "Worker stopped",
      forced,
    });
  }
}

export type { DatabasePool };
