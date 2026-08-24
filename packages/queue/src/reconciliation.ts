import type { DatabasePool } from "@relay/database";
import type { Redis } from "./redis.ts";
import {
  type DurableCapacityLease,
  reconcileQueueCounters,
  recoverExpiredJobLeases,
} from "./dispatch.ts";
import {
  dispatchDeduplicationKey,
  type ExecutionOutboxPayload,
  parseExecutionOutboxPayload,
} from "./tickets.ts";

const READY_PREFIX = "ready:v2:";

export class RedisDispatchGate {
  readonly #statusKey: string;
  readonly #lockKey: string;

  constructor(
    private readonly redis: Redis,
    prefix: string,
  ) {
    this.#statusKey = `${prefix}:dispatch-reconciliation`;
    this.#lockKey = `${this.#statusKey}:lock`;
  }

  async #redisRunId(): Promise<string> {
    const info = await this.redis.info("server");
    const match = /^run_id:([^\r\n]+)$/m.exec(info);
    if (match === null) throw new Error("Redis INFO omitted server run_id");
    return match[1];
  }

  async readyToken(): Promise<string | null> {
    const [value, runId] = await Promise.all([
      this.redis.get(this.#statusKey),
      this.#redisRunId(),
    ]);
    return value !== null && value.startsWith(`${READY_PREFIX}${runId}:`)
      ? value
      : null;
  }

  async isReady(): Promise<boolean> {
    return await this.readyToken() !== null;
  }

  async invalidate(): Promise<void> {
    await this.redis.del(this.#statusKey);
  }

  async tryBegin(owner: string, leaseDurationMs: number): Promise<boolean> {
    const acquired = await this.redis.eval(
      `if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
         redis.call('SET', KEYS[2], ARGV[3])
         return 1
       end
       return 0`,
      2,
      this.#lockKey,
      this.#statusKey,
      owner,
      leaseDurationMs,
      `reconciling:${owner}`,
    );
    return Number(acquired) === 1;
  }

  async renew(owner: string, leaseDurationMs: number): Promise<boolean> {
    const result = await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
         redis.call('PEXPIRE', KEYS[1], ARGV[2])
         return 1
       end
       return 0`,
      1,
      this.#lockKey,
      owner,
      leaseDurationMs,
    );
    return Number(result) === 1;
  }

  async finish(owner: string): Promise<boolean> {
    const readyValue = `${READY_PREFIX}${await this.#redisRunId()}:${owner}`;
    const result = await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
         redis.call('SET', KEYS[2], ARGV[2])
         redis.call('DEL', KEYS[1])
         return 1
       end
       return 0`,
      2,
      this.#lockKey,
      this.#statusKey,
      owner,
      readyValue,
    );
    return Number(result) === 1;
  }

  async waitUntilReady(timeoutMs: number, pollMs = 50): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isReady()) return true;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return await this.isReady();
  }
}

interface QueuedDispatchDbRow {
  id: string;
  run_id: string;
  dispatch_generation: number;
  scheduling_policy_version: number;
  capacity_pool_key: string;
  workspace_id: string;
  scheduling_class: string;
  estimated_cost_units: string | number;
  fifo_sequence: string | number;
  eligible_at: Date;
}

function queuedPayload(row: QueuedDispatchDbRow): ExecutionOutboxPayload {
  return parseExecutionOutboxPayload({
    domainJobId: row.id,
    runId: row.run_id,
    dispatchGeneration: row.dispatch_generation,
    policyVersion: row.scheduling_policy_version,
    capacityPoolKey: row.capacity_pool_key,
    workspaceId: row.workspace_id,
    classKey: row.scheduling_class,
    costUnits: Number(row.estimated_cost_units),
    fifoSequence: Number(row.fifo_sequence),
    eligibleAtMs: row.eligible_at.getTime(),
  });
}

export interface LostTicketReconciliationResult {
  readonly inspected: number;
  readonly rearmed: number;
}

/** Repairs selectively lost/completed/failed transport tickets. */
export async function reconcileLostTickets(
  pool: DatabasePool,
  hasRunnableTicket: (payload: ExecutionOutboxPayload) => Promise<boolean>,
  batchSize = 500,
): Promise<LostTicketReconciliationResult> {
  const { rows } = await pool.query<QueuedDispatchDbRow>(
    `select j.id, j.run_id, j.dispatch_generation,
            j.scheduling_policy_version, cp.key as capacity_pool_key,
            j.workspace_id, j.scheduling_class, j.estimated_cost_units,
            j.fifo_sequence, j.eligible_at
       from relay.execution_jobs j
       join relay.capacity_pools cp on cp.id = j.capacity_pool_id
      where j.status = 'queued' and j.eligible_at <= now()
        and (j.run_deadline_at is null or j.run_deadline_at > now())
        and (
          (j.attempt_count = 0 and (
            j.admission_deadline_at is null or j.admission_deadline_at > now()
          ))
          or (j.attempt_count > 0 and (
            j.attempt_deadline_at is null or j.attempt_deadline_at > now()
          ))
        )
      order by j.eligible_at, j.id
      limit $1`,
    [batchSize],
  );

  let rearmed = 0;
  for (const row of rows) {
    const payload = queuedPayload(row);
    if (await hasRunnableTicket(payload)) continue;
    const result = await pool.query<{ id: string }>(
      `insert into relay.outbox_events
         (aggregate_type, aggregate_id, aggregate_version, event_type, payload,
          eligible_at, deduplication_key)
       select 'execution_job', j.id::text, j.dispatch_generation, 'job.ready',
              jsonb_build_object(
                'domainJobId', j.id::text,
                'runId', j.run_id,
                'capacityPoolKey', cp.key,
                'dispatchGeneration', j.dispatch_generation,
                'policyVersion', j.scheduling_policy_version,
                'workspaceId', j.workspace_id,
                'classKey', j.scheduling_class,
                'costUnits', j.estimated_cost_units,
                'fifoSequence', j.fifo_sequence,
                'eligibleAtMs', floor(extract(epoch from j.eligible_at) * 1000)
              ),
              greatest(j.eligible_at, now()), $3
         from relay.execution_jobs j
         join relay.capacity_pools cp on cp.id = j.capacity_pool_id
        where j.id = $1 and j.status = 'queued'
          and j.dispatch_generation = $2
          and (j.run_deadline_at is null or j.run_deadline_at > now())
          and (
            (j.attempt_count = 0 and (
              j.admission_deadline_at is null or j.admission_deadline_at > now()
            ))
            or (j.attempt_count > 0 and (
              j.attempt_deadline_at is null or j.attempt_deadline_at > now()
            ))
          )
       on conflict (deduplication_key) where deduplication_key is not null
       do update set
          aggregate_version = excluded.aggregate_version,
          event_type = excluded.event_type,
          payload = excluded.payload,
          eligible_at = excluded.eligible_at,
          lease_owner = null,
          lease_expires_at = null,
          attempt_count = 0,
          published_at = null,
          failed_at = null,
          last_error = null
       where relay.outbox_events.lease_expires_at is null
          or relay.outbox_events.lease_expires_at < now()
       returning id`,
      [
        row.id,
        row.dispatch_generation,
        dispatchDeduplicationKey(row.id, row.dispatch_generation),
      ],
    );
    if (result.rows.length === 1) rearmed += 1;
  }
  return { inspected: rows.length, rearmed };
}

interface ActiveLeaseDbRow {
  job_id: string;
  attempt_count: number;
  database_lease_id: string | null;
  redis_lease_id: string | null;
  redis_scope_keys: unknown;
  expires_at: Date | null;
  lease_owner: string | null;
  lease_epoch: string;
  units: string | number | null;
}

function parseScopeKeys(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.length > 0 &&
      value.every((item) => typeof item === "string")
    ? value
    : null;
}

export interface CapacityRehydrationPlan {
  readonly leases: readonly DurableCapacityLease[];
  readonly unsafeJobIds: readonly string[];
}

/**
 * An active attempt without complete capacity facts is unsafe after Redis loss:
 * dispatch must remain closed rather than guessing that no provider work exists.
 */
export async function loadCapacityRehydrationPlan(
  pool: DatabasePool,
  now?: Date,
): Promise<CapacityRehydrationPlan> {
  const effectiveNow = now ?? (await pool.query<{ now: Date }>(
    "select now() as now",
  )).rows[0].now;
  const { rows } = await pool.query<ActiveLeaseDbRow>(
    `select j.id as job_id, j.attempt_count, j.lease_epoch,
            cl.id as database_lease_id, cl.redis_lease_id,
            cl.redis_scope_keys, cl.expires_at, cl.lease_owner, cl.units
       from relay.execution_jobs j
       left join relay.execution_capacity_leases cl
         on cl.id = j.capacity_lease_id and cl.released_at is null
      where j.status in ('running', 'cancel_requested')`,
  );
  const leases: DurableCapacityLease[] = [];
  const unsafeJobIds: string[] = [];
  for (const row of rows) {
    const scopeKeys = parseScopeKeys(row.redis_scope_keys);
    if (
      row.database_lease_id === null ||
      row.redis_lease_id === null ||
      scopeKeys === null ||
      row.expires_at === null ||
      row.expires_at <= effectiveNow ||
      row.lease_owner === null ||
      row.units === null
    ) {
      // A just-claimed job has no attempt and has not contacted a provider, so
      // it consumes no capacity and can safely be recovered when its DB lease
      // expires. Once an attempt exists, missing lease facts are fail-closed.
      if (row.attempt_count > 0) unsafeJobIds.push(row.job_id);
      continue;
    }
    leases.push({
      databaseLeaseId: row.database_lease_id,
      redisLeaseId: row.redis_lease_id,
      redisScopeKeys: scopeKeys,
      expiresAt: row.expires_at,
      ownerId: row.lease_owner,
      jobId: row.job_id,
      leaseEpoch: Number(row.lease_epoch),
      units: Number(row.units),
    });
  }
  return { leases, unsafeJobIds };
}

export interface RedisResetReconciliationOptions {
  readonly owner: string;
  readonly lockDurationMs: number;
  readonly conservativeDelayMs: number;
  readonly retryWaitMs?: number;
}

export interface RedisResetReconciliationDependencies {
  restoreCapacityLease(lease: DurableCapacityLease): Promise<void>;
  releaseCapacityLease(lease: DurableCapacityLease): Promise<void>;
  rebuildScheduler(): Promise<{
    readonly enqueued: number;
    readonly rearmed: number;
  }>;
}

export type RedisResetReconciliationResult =
  | {
    readonly kind: "reconciled";
    readonly restoredLeases: number;
    readonly recoveredJobs: number;
    readonly rebuiltSchedulerJobs: number;
    readonly rearmedSchedulerJobs: number;
  }
  | { readonly kind: "followed_existing_reconciliation" };

interface ReconciliationHeartbeat {
  readonly verify: (phase: string) => Promise<void>;
  readonly stop: () => Promise<void>;
}

function startReconciliationHeartbeat(
  gate: RedisDispatchGate,
  owner: string,
  leaseDurationMs: number,
): ReconciliationHeartbeat {
  let stopped = false;
  let lost = false;
  let wake: (() => void) | undefined;
  const intervalMs = Math.max(1, Math.floor(leaseDurationMs / 3));

  const renew = async (): Promise<void> => {
    try {
      if (!(await gate.renew(owner, leaseDurationMs))) lost = true;
    } catch {
      lost = true;
    }
  };

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
      await renew();
    }
  })();

  return {
    verify: async (phase: string) => {
      if (!lost) await renew();
      if (lost) {
        throw new Error(`Lost Redis reconciliation ownership ${phase}`);
      }
    },
    stop: async () => {
      stopped = true;
      wake?.();
      await task;
    },
  };
}

/**
 * Rebuilds all safety-critical Redis state before setting the shared ready
 * marker. Any unknown active lease leaves the marker closed and throws.
 */
export async function reconcileRedisReset(
  pool: DatabasePool,
  gate: RedisDispatchGate,
  dependencies: RedisResetReconciliationDependencies,
  options: RedisResetReconciliationOptions,
): Promise<RedisResetReconciliationResult> {
  const reconciliationOwner = `${options.owner}:${crypto.randomUUID()}`;
  if (!(await gate.tryBegin(reconciliationOwner, options.lockDurationMs))) {
    if (await gate.waitUntilReady(options.lockDurationMs)) {
      return { kind: "followed_existing_reconciliation" };
    }
    throw new Error("Timed out waiting for Redis reconciliation owner");
  }

  const heartbeat = startReconciliationHeartbeat(
    gate,
    reconciliationOwner,
    options.lockDurationMs,
  );
  try {
    const stalled = await recoverExpiredJobLeases(
      pool,
      undefined,
      100,
      options.retryWaitMs,
    );
    await heartbeat.verify("after expired lease recovery");
    for (const lease of stalled.capacityLeasesToRelease) {
      await dependencies.releaseCapacityLease(lease);
      await heartbeat.verify("during recovered capacity release");
    }

    const plan = await loadCapacityRehydrationPlan(pool);
    if (plan.unsafeJobIds.length > 0) {
      throw new Error(
        `Cannot safely reconstruct capacity for active jobs: ${
          plan.unsafeJobIds.join(", ")
        }`,
      );
    }
    for (const lease of plan.leases) {
      await dependencies.restoreCapacityLease(lease);
      await heartbeat.verify("during lease restore");
    }

    await heartbeat.verify("before durable repair");
    await reconcileQueueCounters(pool);
    await heartbeat.verify("after queue counter repair");
    const scheduler = await dependencies.rebuildScheduler();
    await heartbeat.verify("after scheduler rebuild");

    if (options.conservativeDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, options.conservativeDelayMs)
      );
      await heartbeat.verify("after cooldown");
    }
    if (!(await gate.finish(reconciliationOwner))) {
      throw new Error(
        "Lost Redis reconciliation ownership before finalization",
      );
    }
    return {
      kind: "reconciled",
      restoredLeases: plan.leases.length,
      recoveredJobs: stalled.recovered + stalled.cancelled + stalled.failed,
      rebuiltSchedulerJobs: scheduler.enqueued,
      rearmedSchedulerJobs: scheduler.rearmed,
    };
  } finally {
    await heartbeat.stop();
  }
}

export async function listEnabledCapacityPoolKeys(
  pool: DatabasePool,
): Promise<readonly string[]> {
  const { rows } = await pool.query<{ key: string }>(
    `select key from relay.capacity_pools where enabled = true order by key`,
  );
  return rows.map((row: { key: string }) => row.key);
}
