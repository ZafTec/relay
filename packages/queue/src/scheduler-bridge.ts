import type { DatabasePool } from "@relay/database";
import {
  type DispatchLease,
  type EnqueueResult,
  isSchedulingClassKey,
  type SchedulerJob,
  schedulerKeys,
  type WeightedFairScheduler,
} from "@relay/scheduler";
import type { Redis } from "./redis.ts";
import { executionOutboxAction } from "./bullmq.ts";
import type { OutboxEventRow } from "./outbox-relay.ts";
import { armSchedulerTicket, rearmQueuedJobDispatch } from "./dispatch.ts";
import {
  type ExecutionOutboxPayload,
  parseExecutionOutboxPayload,
} from "./tickets.ts";

interface ScheduledExecutionRow {
  readonly id: string;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly scheduling_class: string;
  readonly scheduling_policy_version: number;
  readonly estimated_cost_units: string | number;
  readonly fifo_sequence: string | number;
  readonly eligible_at: Date;
  readonly dispatch_generation: number;
  readonly capacity_pool_key: string;
  readonly traceparent: string | null;
  readonly tracestate: string | null;
}

export interface ScheduledExecution {
  readonly schedulerJob: SchedulerJob;
  readonly payload: ExecutionOutboxPayload;
}

function scheduledExecution(row: ScheduledExecutionRow): ScheduledExecution {
  if (!isSchedulingClassKey(row.scheduling_class)) {
    throw new Error(`Unknown scheduling class ${row.scheduling_class}`);
  }
  const costUnits = Number(row.estimated_cost_units);
  const fifoSequence = Number(row.fifo_sequence);
  if (!Number.isFinite(costUnits) || costUnits <= 0) {
    throw new Error("Execution job has invalid scheduler cost");
  }
  if (!Number.isSafeInteger(fifoSequence) || fifoSequence <= 0) {
    throw new Error("Execution job has invalid FIFO sequence");
  }
  const payload = parseExecutionOutboxPayload({
    domainJobId: row.id,
    runId: row.run_id,
    capacityPoolKey: row.capacity_pool_key,
    dispatchGeneration: row.dispatch_generation,
    policyVersion: row.scheduling_policy_version,
    ...(row.traceparent === null ? {} : { traceparent: row.traceparent }),
    ...(row.tracestate === null ? {} : { tracestate: row.tracestate }),
    workspaceId: row.workspace_id,
    classKey: row.scheduling_class,
    costUnits,
    fifoSequence,
    eligibleAtMs: row.eligible_at.getTime(),
  });
  return {
    payload,
    schedulerJob: {
      jobId: row.id,
      dispatchGeneration: row.dispatch_generation,
      policyVersion: row.scheduling_policy_version,
      classKey: row.scheduling_class,
      workspaceId: row.workspace_id,
      costUnits,
      fifoSequence,
      eligibleAtMs: row.eligible_at.getTime(),
    },
  };
}

const RUNNABLE_JOB_PREDICATE = `
  j.status = 'queued'
  and cp.enabled = true
  and t.lifecycle not in ('disabled', 'retired')
  and (j.run_deadline_at is null or j.run_deadline_at > now())
  and (
    (j.attempt_count = 0 and (
      j.admission_deadline_at is null or j.admission_deadline_at > now()
    ))
    or (j.attempt_count > 0 and (
      j.attempt_deadline_at is null or j.attempt_deadline_at > now()
    ))
  )
`;

export async function loadScheduledExecution(
  pool: DatabasePool,
  jobId: string,
  dispatchGeneration: number,
): Promise<ScheduledExecution | null> {
  const { rows } = await pool.query<ScheduledExecutionRow>(
    `select j.id, j.run_id, j.workspace_id, j.scheduling_class,
            j.scheduling_policy_version, j.estimated_cost_units,
            j.fifo_sequence, j.eligible_at, j.dispatch_generation,
            cp.key as capacity_pool_key, trace_context.traceparent,
            trace_context.tracestate
       from relay.execution_jobs j
       join relay.capacity_pools cp on cp.id = j.capacity_pool_id
       join relay.tool_versions tv on tv.id = j.tool_version_id
       join relay.tools t on t.id = tv.tool_id
       left join lateral (
         select oe.payload->>'traceparent' as traceparent,
                oe.payload->>'tracestate' as tracestate
           from relay.outbox_events oe
          where oe.aggregate_type = 'execution_job'
            and oe.aggregate_id = j.id::text
            and jsonb_typeof(oe.payload->'traceparent') = 'string'
          order by oe.id
          limit 1
       ) trace_context on true
      where j.id = $1 and j.dispatch_generation = $2
        and ${RUNNABLE_JOB_PREDICATE}`,
    [jobId, dispatchGeneration],
  );
  return rows.length === 0 ? null : scheduledExecution(rows[0]);
}

interface SchedulerRecord {
  readonly dispatchGeneration: number;
  readonly tombstone?: "dispatched" | "cancelled";
  readonly policyVersion?: number;
  readonly classKey?: string;
  readonly workspaceId?: string;
  readonly costUnits?: number;
  readonly fifoSequence?: number;
}

interface DurableExecutionStateRow {
  readonly status: string;
  readonly dispatch_generation: number;
}

type DurableExecutionState =
  | { readonly kind: "missing" }
  | {
    readonly kind: "queued";
    readonly dispatchGeneration: number;
    readonly execution: ScheduledExecution | null;
  }
  | {
    readonly kind: "transported";
    readonly dispatchGeneration: number;
  }
  | {
    readonly kind: "terminal";
    readonly dispatchGeneration: number;
  };

async function loadDurableExecutionState(
  pool: DatabasePool,
  jobId: string,
): Promise<DurableExecutionState> {
  const { rows } = await pool.query<DurableExecutionStateRow>(
    `select status, dispatch_generation
       from relay.execution_jobs
      where id = $1`,
    [jobId],
  );
  if (rows.length === 0) return { kind: "missing" };

  const row = rows[0];
  if (row.status === "queued") {
    return {
      kind: "queued",
      dispatchGeneration: row.dispatch_generation,
      execution: await loadScheduledExecution(
        pool,
        jobId,
        row.dispatch_generation,
      ),
    };
  }
  if (row.status === "running" || row.status === "cancel_requested") {
    return {
      kind: "transported",
      dispatchGeneration: row.dispatch_generation,
    };
  }
  if (
    row.status === "succeeded" || row.status === "failed" ||
    row.status === "cancelled"
  ) {
    return { kind: "terminal", dispatchGeneration: row.dispatch_generation };
  }
  throw new Error(`Execution job has unknown durable status ${row.status}`);
}

function sameSchedulerRecord(
  existing: SchedulerRecord,
  job: SchedulerJob,
): boolean {
  return existing.dispatchGeneration === job.dispatchGeneration &&
    existing.policyVersion === job.policyVersion &&
    existing.classKey === job.classKey &&
    existing.workspaceId === job.workspaceId &&
    Number(existing.costUnits) === job.costUnits &&
    Number(existing.fifoSequence) === job.fifoSequence;
}

const REPAIR_SCHEDULER_INDEX_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if tonumber(job.dispatchGeneration) ~= tonumber(ARGV[2]) or job.tombstone then
  return 0
end
if redis.call('ZSCORE', KEYS[2], ARGV[1])
  or redis.call('ZSCORE', KEYS[3], ARGV[1])
  or redis.call('ZSCORE', KEYS[4], ARGV[1])
then
  return 2
end
local eligible_at = tonumber(job.eligibleAtMs)
if not eligible_at then return -1 end
redis.call('ZADD', KEYS[2], eligible_at, ARGV[1])
return 1
`.trim();

const CLEAR_INVALID_CANCELLATION_TOMBSTONE_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if tonumber(job.dispatchGeneration) ~= tonumber(ARGV[2])
  or job.tombstone ~= 'cancelled'
then
  return 0
end
redis.call('HDEL', KEYS[1], ARGV[1])
return 1
`.trim();

export interface ExecutionTransport {
  publish(
    payload: ExecutionOutboxPayload,
    schedulerToken: string,
  ): Promise<void>;
  cancel(payload: ExecutionOutboxPayload): Promise<void>;
  waitingCount(capacityPoolKey: string): Promise<number>;
  hasRunnableTicket(payload: ExecutionOutboxPayload): Promise<boolean>;
}

export interface SchedulerBridgeOptions {
  readonly environment: string;
  readonly maxBullmqWaitingPerPool: number;
  readonly maxDispatchesPerIteration: number;
  readonly bufferRetryDelayMs: number;
  readonly poolBufferLockDurationMs: number;
}

export interface SchedulerDispatchResult {
  readonly claimed: number;
  /** Transport publications accepted; an unacknowledged one also increments lostLease. */
  readonly published: number;
  readonly deferredForBuffer: number;
  readonly deferredForState: number;
  readonly discarded: number;
  readonly failed: number;
  readonly lostLease: number;
}

export interface SchedulerReconciliationResult {
  readonly inspected: number;
  readonly enqueued: number;
  readonly rearmed: number;
  readonly repaired: number;
  readonly held: number;
}

function assertBridgeOptions(options: SchedulerBridgeOptions): void {
  for (
    const [name, value] of [
      ["maxBullmqWaitingPerPool", options.maxBullmqWaitingPerPool],
      ["maxDispatchesPerIteration", options.maxDispatchesPerIteration],
      ["bufferRetryDelayMs", options.bufferRetryDelayMs],
      ["poolBufferLockDurationMs", options.poolBufferLockDurationMs],
    ] as const
  ) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
}

function sameLeaseJob(
  lease: DispatchLease,
  execution: ScheduledExecution,
): boolean {
  const job = execution.schedulerJob;
  return lease.jobId === job.jobId &&
    lease.dispatchGeneration === job.dispatchGeneration &&
    lease.policyVersion === job.policyVersion &&
    lease.classKey === job.classKey &&
    lease.workspaceId === job.workspaceId &&
    lease.costUnits === job.costUnits &&
    lease.fifoSequence === job.fifoSequence;
}

interface DispatchHeartbeat {
  readonly lease: () => DispatchLease;
  readonly lost: () => boolean;
  readonly stop: () => Promise<void>;
}

export class ExecutionSchedulerBridge {
  readonly #keys;

  async #redisNowMs(): Promise<number> {
    const [seconds, microseconds] = await this.redis.time();
    return Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
  }

  async #releaseAt(): Promise<number> {
    return await this.#redisNowMs() + this.options.bufferRetryDelayMs;
  }

  async #acquirePoolBufferLock(
    capacityPoolKey: string,
    owner: string,
  ): Promise<string | null> {
    const key = `${this.#keys.base}:buffer-lock:${
      encodeURIComponent(capacityPoolKey)
    }`;
    const acquired = await this.redis.set(
      key,
      owner,
      "PX",
      this.options.poolBufferLockDurationMs,
      "NX",
    );
    return acquired === "OK" ? key : null;
  }

  async #renewPoolBufferLock(key: string, owner: string): Promise<boolean> {
    const renewed = await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
         redis.call('PEXPIRE', KEYS[1], ARGV[2])
         return 1
       end
       return 0`,
      1,
      key,
      owner,
      this.options.poolBufferLockDurationMs,
    );
    return Number(renewed) === 1;
  }

  async #releasePoolBufferLock(key: string, owner: string): Promise<void> {
    await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
         return redis.call('DEL', KEYS[1])
       end
       return 0`,
      1,
      key,
      owner,
    );
  }

  async #startDispatchHeartbeat(
    key: string,
    owner: string,
    initialLease: DispatchLease,
  ): Promise<DispatchHeartbeat> {
    let lease = initialLease;
    let lost = false;
    let stopped = false;
    let wake: (() => void) | undefined;

    const renew = async (): Promise<void> => {
      const [lockRenewed, schedulerRenewed] = await Promise.all([
        this.#renewPoolBufferLock(key, owner),
        this.scheduler.renewDispatchLease(lease),
      ]);
      if (!lockRenewed || !schedulerRenewed.ok) {
        lost = true;
        return;
      }
      lease = schedulerRenewed.lease;
    };

    await renew();
    const now = await this.#redisNowMs();
    const schedulerLeaseMs = Math.max(1, lease.expiresAtMs - now);
    const intervalMs = Math.max(
      1,
      Math.floor(
        Math.min(
          this.options.poolBufferLockDurationMs,
          schedulerLeaseMs,
        ) / 3,
      ),
    );

    const task = (async () => {
      while (!stopped && !lost) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            wake = undefined;
            resolve();
          }, intervalMs);
          wake = () => {
            clearTimeout(timeout);
            wake = undefined;
            resolve();
          };
        });
        if (stopped || lost) break;
        try {
          await renew();
        } catch {
          lost = true;
        }
      }
    })();

    return {
      lease: () => lease,
      lost: () => lost,
      stop: async () => {
        stopped = true;
        wake?.();
        await task;
      },
    };
  }

  async #repairMissingIndexes(job: SchedulerJob): Promise<boolean> {
    const readyKey =
      `${this.#keys.base}:ready:${job.classKey}:${job.workspaceId}`;
    const result = await this.redis.eval(
      REPAIR_SCHEDULER_INDEX_SCRIPT,
      4,
      this.#keys.jobs,
      this.#keys.due,
      this.#keys.dispatch,
      readyKey,
      job.jobId,
      job.dispatchGeneration,
    );
    if (Number(result) === -1) {
      throw new Error("Scheduler job has invalid delayed eligibility");
    }
    return Number(result) === 1;
  }

  async #clearInvalidCancellationTombstone(
    jobId: string,
    dispatchGeneration: number,
  ): Promise<boolean> {
    return Number(
      await this.redis.eval(
        CLEAR_INVALID_CANCELLATION_TOMBSTONE_SCRIPT,
        1,
        this.#keys.jobs,
        jobId,
        dispatchGeneration,
      ),
    ) === 1;
  }

  constructor(
    private readonly pool: DatabasePool,
    private readonly redis: Redis,
    private readonly scheduler: Pick<
      WeightedFairScheduler,
      | "enqueue"
      | "claimNext"
      | "acknowledgeDispatch"
      | "renewDispatchLease"
      | "releaseDispatchLease"
      | "removeJob"
    >,
    private readonly queues: ExecutionTransport,
    private readonly options: SchedulerBridgeOptions,
  ) {
    assertBridgeOptions(options);
    this.#keys = schedulerKeys(options.environment);
  }

  async enqueue(
    payload: ExecutionOutboxPayload,
  ): Promise<EnqueueResult | null> {
    const execution = await loadScheduledExecution(
      this.pool,
      payload.domainJobId,
      payload.dispatchGeneration,
    );
    if (execution === null) return null;
    if (
      execution.payload.runId !== payload.runId ||
      execution.payload.capacityPoolKey !== payload.capacityPoolKey
    ) {
      throw new Error("Outbox routing metadata does not match PostgreSQL");
    }

    const raw = await this.redis.hget(this.#keys.jobs, payload.domainJobId);
    if (raw !== null) {
      let existing: SchedulerRecord;
      try {
        existing = JSON.parse(raw) as SchedulerRecord;
      } catch {
        throw new Error("Scheduler contains malformed execution state");
      }
      const job = execution.schedulerJob;
      if (
        existing.dispatchGeneration === job.dispatchGeneration &&
        existing.tombstone === undefined
      ) {
        if (!sameSchedulerRecord(existing, job)) {
          throw new Error("Scheduler generation conflicts with PostgreSQL");
        }
        await this.#repairMissingIndexes(job);
        return { kind: "duplicate" };
      }
      if (
        existing.tombstone === "cancelled" &&
        existing.dispatchGeneration <= job.dispatchGeneration
      ) {
        await this.#clearInvalidCancellationTombstone(
          job.jobId,
          existing.dispatchGeneration,
        );
      }
    }

    const result = await this.scheduler.enqueue(execution.schedulerJob);
    if (
      result.kind === "conflict" || result.kind === "policy_mismatch" ||
      result.kind === "terminal"
    ) {
      throw new Error(`Scheduler rejected execution job: ${result.kind}`);
    }
    return result;
  }

  async handleOutboxEvent(event: OutboxEventRow): Promise<void> {
    const action = executionOutboxAction(event);
    if (action.kind === "dispatch") {
      await this.enqueue(action.payload);
      return;
    }
    await this.scheduler.removeJob(
      action.payload.domainJobId,
      action.payload.dispatchGeneration,
    );
    await this.queues.cancel(action.payload);
  }

  async dispatchBatch(ownerId: string): Promise<SchedulerDispatchResult> {
    let claimed = 0;
    let published = 0;
    let deferredForBuffer = 0;
    let deferredForState = 0;
    let discarded = 0;
    let failed = 0;
    let lostLease = 0;

    for (
      let index = 0;
      index < this.options.maxDispatchesPerIteration;
      index++
    ) {
      const next = await this.scheduler.claimNext(ownerId);
      if (next.kind === "empty") break;
      claimed += 1;
      let lease = next.lease;
      try {
        const execution = await loadScheduledExecution(
          this.pool,
          lease.jobId,
          lease.dispatchGeneration,
        );
        if (execution === null) {
          const durable = await loadDurableExecutionState(
            this.pool,
            lease.jobId,
          );
          if (durable.kind === "missing" || durable.kind === "terminal") {
            if (
              await this.scheduler.removeJob(
                lease.jobId,
                lease.dispatchGeneration,
              )
            ) discarded += 1;
            else lostLease += 1;
            continue;
          }
          if (durable.kind === "transported") {
            if (await this.scheduler.acknowledgeDispatch(lease)) discarded += 1;
            else lostLease += 1;
            continue;
          }

          const released = await this.scheduler.releaseDispatchLease(
            lease,
            await this.#releaseAt(),
          );
          if (!released) {
            lostLease += 1;
            continue;
          }
          if (
            durable.dispatchGeneration > lease.dispatchGeneration &&
            durable.execution !== null
          ) {
            const repaired = await this.scheduler.enqueue(
              durable.execution.schedulerJob,
            );
            if (
              repaired.kind !== "enqueued" && repaired.kind !== "duplicate" &&
              repaired.kind !== "class_disabled"
            ) {
              throw new Error(
                `Scheduler generation recovery failed: ${repaired.kind}`,
              );
            }
          } else if (durable.dispatchGeneration < lease.dispatchGeneration) {
            throw new Error("Scheduler generation is ahead of PostgreSQL");
          }
          deferredForState += 1;
          continue;
        }
        if (!sameLeaseJob(lease, execution)) {
          const released = await this.scheduler.releaseDispatchLease(
            lease,
            await this.#releaseAt(),
          );
          if (!released) {
            lostLease += 1;
            continue;
          }
          const payload = await rearmQueuedJobDispatch(
            this.pool,
            lease.jobId,
            lease.dispatchGeneration,
            "scheduler_dispatch_metadata_conflict",
          );
          if (payload !== null) {
            const rearmed = await loadScheduledExecution(
              this.pool,
              payload.domainJobId,
              payload.dispatchGeneration,
            );
            if (rearmed !== null) {
              const result = await this.scheduler.enqueue(rearmed.schedulerJob);
              if (
                result.kind !== "enqueued" && result.kind !== "duplicate" &&
                result.kind !== "class_disabled"
              ) {
                throw new Error(
                  `Scheduler metadata recovery failed: ${result.kind}`,
                );
              }
            }
          }
          failed += 1;
          continue;
        }

        const bufferLockOwner = `${ownerId}:${lease.leaseId}`;
        const bufferLock = await this.#acquirePoolBufferLock(
          execution.payload.capacityPoolKey,
          bufferLockOwner,
        );
        if (bufferLock === null) {
          await this.scheduler.releaseDispatchLease(
            lease,
            await this.#releaseAt(),
          );
          deferredForBuffer += 1;
          continue;
        }

        let heartbeat: DispatchHeartbeat | undefined;
        try {
          heartbeat = await this.#startDispatchHeartbeat(
            bufferLock,
            bufferLockOwner,
            lease,
          );
          lease = heartbeat.lease();
          if (heartbeat.lost()) {
            lostLease += 1;
            continue;
          }

          const waiting = await this.queues.waitingCount(
            execution.payload.capacityPoolKey,
          );
          if (waiting >= this.options.maxBullmqWaitingPerPool) {
            await heartbeat.stop();
            lease = heartbeat.lease();
            if (
              heartbeat.lost() ||
              !(await this.scheduler.releaseDispatchLease(
                lease,
                await this.#releaseAt(),
              ))
            ) lostLease += 1;
            else deferredForBuffer += 1;
            continue;
          }

          const schedulerToken = await armSchedulerTicket(
            this.pool,
            lease.jobId,
            lease.dispatchGeneration,
            lease.leaseId,
          );
          if (schedulerToken === null) {
            await heartbeat.stop();
            lease = heartbeat.lease();
            if (
              heartbeat.lost() ||
              !(await this.scheduler.releaseDispatchLease(lease))
            ) lostLease += 1;
            else deferredForState += 1;
            continue;
          }
          if (
            heartbeat.lost() ||
            !(await this.#renewPoolBufferLock(bufferLock, bufferLockOwner))
          ) {
            lostLease += 1;
            continue;
          }

          await this.queues.publish(execution.payload, schedulerToken);
          // Transport publication and scheduler acknowledgement are separate
          // fences. Once publish resolves, the deterministic BullMQ ticket is
          // present even if lock ownership is lost before scheduler ack. Count
          // that transport success now; lostLease below still records that a
          // later scheduler lease must observe the same ticket and acknowledge.
          published += 1;
          await heartbeat.stop();
          lease = heartbeat.lease();
          if (
            heartbeat.lost() ||
            !(await this.#renewPoolBufferLock(bufferLock, bufferLockOwner))
          ) {
            // Publication is deterministic and durably provenance-fenced. A
            // replacement scheduler lease will observe the same BullMQ ticket.
            lostLease += 1;
            continue;
          }
          const renewed = await this.scheduler.renewDispatchLease(lease);
          if (!renewed.ok) {
            lostLease += 1;
            continue;
          }
          lease = renewed.lease;
          if (!(await this.#renewPoolBufferLock(bufferLock, bufferLockOwner))) {
            lostLease += 1;
            continue;
          }
          if (!(await this.scheduler.acknowledgeDispatch(lease))) {
            lostLease += 1;
          }
        } finally {
          await heartbeat?.stop();
          await this.#releasePoolBufferLock(bufferLock, bufferLockOwner);
        }
      } catch {
        try {
          await this.scheduler.releaseDispatchLease(
            lease,
            await this.#releaseAt(),
          );
        } catch {
          // Lease expiry is the recovery path when explicit release is lost.
        }
        failed += 1;
      }
    }

    return {
      claimed,
      published,
      deferredForBuffer,
      deferredForState,
      discarded,
      failed,
      lostLease,
    };
  }

  async rebuildAll(batchSize = 500): Promise<SchedulerReconciliationResult> {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error("batchSize must be a positive safe integer");
    }
    let cursor = 0;
    let inspected = 0;
    let enqueued = 0;
    let rearmed = 0;
    let repaired = 0;
    let held = 0;

    const accountEnqueue = (result: EnqueueResult, context: string): void => {
      if (result.kind === "enqueued") enqueued += 1;
      else if (result.kind === "class_disabled") held += 1;
      else if (result.kind !== "duplicate") {
        throw new Error(`${context}: ${result.kind}`);
      }
    };

    while (true) {
      const { rows } = await this.pool.query<ScheduledExecutionRow>(
        `select j.id, j.run_id, j.workspace_id, j.scheduling_class,
                j.scheduling_policy_version, j.estimated_cost_units,
                j.fifo_sequence, j.eligible_at, j.dispatch_generation,
                cp.key as capacity_pool_key, trace_context.traceparent,
                trace_context.tracestate
           from relay.execution_jobs j
           join relay.capacity_pools cp on cp.id = j.capacity_pool_id
           join relay.tool_versions tv on tv.id = j.tool_version_id
           join relay.tools t on t.id = tv.tool_id
           left join lateral (
             select oe.payload->>'traceparent' as traceparent,
                    oe.payload->>'tracestate' as tracestate
               from relay.outbox_events oe
              where oe.aggregate_type = 'execution_job'
                and oe.aggregate_id = j.id::text
                and jsonb_typeof(oe.payload->'traceparent') = 'string'
              order by oe.id
              limit 1
           ) trace_context on true
          where ${RUNNABLE_JOB_PREDICATE}
            and j.fifo_sequence > $1
          order by j.fifo_sequence
          limit $2`,
        [cursor, batchSize],
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        const execution = scheduledExecution(row);
        inspected += 1;
        cursor = execution.schedulerJob.fifoSequence;
        const raw = await this.redis.hget(
          this.#keys.jobs,
          execution.schedulerJob.jobId,
        );
        if (raw === null) {
          accountEnqueue(
            await this.scheduler.enqueue(execution.schedulerJob),
            "Scheduler rebuild failed",
          );
          continue;
        }

        let existing: SchedulerRecord;
        try {
          existing = JSON.parse(raw) as SchedulerRecord;
        } catch {
          throw new Error("Scheduler contains malformed execution state");
        }
        if (!Number.isSafeInteger(existing.dispatchGeneration)) {
          throw new Error("Scheduler contains an invalid dispatch generation");
        }
        if (
          existing.dispatchGeneration >
            execution.schedulerJob.dispatchGeneration
        ) {
          throw new Error("Scheduler generation is ahead of PostgreSQL");
        }

        if (existing.tombstone === "cancelled") {
          await this.#clearInvalidCancellationTombstone(
            execution.schedulerJob.jobId,
            existing.dispatchGeneration,
          );
          accountEnqueue(
            await this.scheduler.enqueue(execution.schedulerJob),
            "Scheduler cancellation tombstone recovery failed",
          );
          continue;
        }

        if (
          existing.dispatchGeneration <
            execution.schedulerJob.dispatchGeneration
        ) {
          accountEnqueue(
            await this.scheduler.enqueue(execution.schedulerJob),
            "Scheduler generation repair failed",
          );
          continue;
        }
        if (existing.tombstone === undefined) {
          if (!sameSchedulerRecord(existing, execution.schedulerJob)) {
            throw new Error("Scheduler generation conflicts with PostgreSQL");
          }
          if (await this.#repairMissingIndexes(execution.schedulerJob)) {
            repaired += 1;
          }
          continue;
        }
        if (
          existing.tombstone === "dispatched" &&
          await this.queues.hasRunnableTicket(execution.payload)
        ) {
          continue;
        }

        const payload = await rearmQueuedJobDispatch(
          this.pool,
          execution.payload.domainJobId,
          execution.payload.dispatchGeneration,
          `scheduler_${existing.tombstone}_without_transport`,
        );
        if (payload === null) continue;
        const rearmedExecution = await loadScheduledExecution(
          this.pool,
          payload.domainJobId,
          payload.dispatchGeneration,
        );
        if (rearmedExecution === null) continue;
        accountEnqueue(
          await this.scheduler.enqueue(rearmedExecution.schedulerJob),
          "Scheduler tombstone repair failed",
        );
        rearmed += 1;
      }

      if (rows.length < batchSize) break;
    }

    return { inspected, enqueued, rearmed, repaired, held };
  }
}
