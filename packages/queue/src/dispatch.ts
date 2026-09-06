import type pg from "pg";
import type { DatabasePool } from "@relay/database";
import {
  dispatchDeduplicationKey,
  type ExecutionOutboxPayload,
  type ExecutionTicket,
  parseExecutionOutboxPayload,
} from "./tickets.ts";
import { sanitizeError } from "./safety.ts";
import {
  lockQueueCounterMutation,
  lockQueueCounterReconciliation,
} from "./counter-lock.ts";

export interface ExecutionCapacityLimits {
  readonly globalTool: number;
  readonly pool: number;
  readonly workspaceTotal: number;
  readonly workspaceTool: number;
}

const DEFAULT_EXECUTION_CAPACITY_LIMITS: ExecutionCapacityLimits = {
  globalTool: 1,
  pool: 1,
  workspaceTotal: 1,
  workspaceTool: 1,
};

export interface SubmissionRatePolicy {
  readonly providerPerMinute: number | null;
  readonly toolPerMinute: number | null;
  readonly capacityPoolRevision: number | null;
  readonly toolRevision: number | null;
}

export interface ClaimedJob {
  readonly jobId: string;
  readonly runId: string;
  readonly leaseEpoch: number;
  readonly dispatchGeneration: number;
  readonly workspaceId: string;
  readonly toolVersionId: string;
  readonly toolId: string;
  readonly toolKey: string;
  readonly providerModelId: string;
  readonly capacityPoolId: string;
  readonly capacityPoolKey: string;
  readonly capacityUnits: number;
  readonly policyVersion: number;
  readonly capacityPolicyRevision: number | null;
  readonly capacityLimits: ExecutionCapacityLimits;
  readonly submissionRatePolicy: SubmissionRatePolicy;
  /** Guides resume/inspect behavior after an interrupted or retryable attempt. */
  readonly previousRetryClassification: string | null;
  readonly previousProviderOperationId: string | null;
}

export interface JobAttempt {
  readonly attemptId: string;
  readonly attemptNumber: number;
  /** Stable for the logical job so a stalled redelivery cannot duplicate a provider operation. */
  readonly providerIdempotencyKey: string;
}

export type ClaimResult =
  | { readonly kind: "claimed"; readonly job: ClaimedJob }
  | { readonly kind: "no_op" };

interface ClaimedJobDbRow {
  id: string;
  run_id: string;
  workspace_id: string;
  tool_version_id: string;
  lease_epoch: string;
  dispatch_generation: number;
  state_version: string;
  scheduling_policy_version: number;
  tool_id: string;
  tool_key: string;
  provider_model_id: string;
  capacity_pool_id: string;
  capacity_pool_key: string;
  estimated_cost_units: string | number | null;
}

interface CapacityPolicyDbRow {
  scope_type: "capacity_pool" | "tool";
  revision: number;
  configuration: unknown;
}

function positiveLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseExecutionCapacityLimits(
  configuration: unknown,
): ExecutionCapacityLimits {
  if (configuration === null || typeof configuration !== "object") {
    return DEFAULT_EXECUTION_CAPACITY_LIMITS;
  }
  const root = configuration as Record<string, unknown>;
  const nested = root.executionConcurrency;
  if (nested === null || typeof nested !== "object") {
    return DEFAULT_EXECUTION_CAPACITY_LIMITS;
  }
  const limits = nested as Record<string, unknown>;
  return {
    globalTool: positiveLimit(
      limits.globalTool,
      DEFAULT_EXECUTION_CAPACITY_LIMITS.globalTool,
    ),
    pool: positiveLimit(limits.pool, DEFAULT_EXECUTION_CAPACITY_LIMITS.pool),
    workspaceTotal: positiveLimit(
      limits.workspaceTotal,
      DEFAULT_EXECUTION_CAPACITY_LIMITS.workspaceTotal,
    ),
    workspaceTool: positiveLimit(
      limits.workspaceTool,
      DEFAULT_EXECUTION_CAPACITY_LIMITS.workspaceTool,
    ),
  };
}

function policyConfiguration(
  policy: CapacityPolicyDbRow,
): Record<string, unknown> {
  if (
    policy.configuration === null ||
    typeof policy.configuration !== "object" ||
    Array.isArray(policy.configuration)
  ) {
    throw new Error(
      `Current ${policy.scope_type} capacity policy revision ${policy.revision} has invalid configuration`,
    );
  }
  return policy.configuration as Record<string, unknown>;
}

function positiveIntegerRate(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function submissionRateDefaults(
  policy: CapacityPolicyDbRow,
  required: boolean,
): {
  readonly providerPerMinute: number | null;
  readonly toolPerMinute: number | null;
} {
  const configuration = policyConfiguration(policy);
  const defaults = configuration.submissionRateDefaults;
  if (defaults === undefined && !required) {
    return { providerPerMinute: null, toolPerMinute: null };
  }
  if (
    defaults === null || typeof defaults !== "object" || Array.isArray(defaults)
  ) {
    throw new Error(
      `Current ${policy.scope_type} capacity policy revision ${policy.revision} has invalid submissionRateDefaults`,
    );
  }
  const rates = defaults as Record<string, unknown>;
  const providerPerMinute = rates.providerPerMinute === undefined
    ? null
    : positiveIntegerRate(
      rates.providerPerMinute,
      `${policy.scope_type} submissionRateDefaults.providerPerMinute`,
    );
  const toolPerMinute = rates.toolPerMinute === undefined
    ? null
    : positiveIntegerRate(
      rates.toolPerMinute,
      `${policy.scope_type} submissionRateDefaults.toolPerMinute`,
    );
  if (required && providerPerMinute === null) {
    throw new Error(
      `${policy.scope_type} submissionRateDefaults.providerPerMinute must be a positive integer`,
    );
  }
  return { providerPerMinute, toolPerMinute };
}

export function parseSubmissionRatePolicy(
  capacityPoolPolicy: {
    readonly revision: number;
    readonly configuration: unknown;
  } | null,
  toolPolicy: {
    readonly revision: number;
    readonly configuration: unknown;
  } | null,
): SubmissionRatePolicy {
  const capacityPoolRates = capacityPoolPolicy === null
    ? { providerPerMinute: null, toolPerMinute: null }
    : submissionRateDefaults(
      { ...capacityPoolPolicy, scope_type: "capacity_pool" },
      true,
    );
  const toolRates = toolPolicy === null
    ? { providerPerMinute: null, toolPerMinute: null }
    : submissionRateDefaults(
      { ...toolPolicy, scope_type: "tool" },
      false,
    );
  return {
    providerPerMinute: capacityPoolRates.providerPerMinute,
    toolPerMinute: toolRates.toolPerMinute ?? capacityPoolRates.toolPerMinute,
    capacityPoolRevision: capacityPoolPolicy?.revision ?? null,
    toolRevision: toolPolicy?.revision ?? null,
  };
}

async function resolveExecutionCapacityPolicy(
  client: pg.PoolClient,
  toolId: string,
  capacityPoolId: string,
): Promise<{
  revision: number | null;
  limits: ExecutionCapacityLimits;
  submissionRates: SubmissionRatePolicy;
}> {
  const { rows } = await client.query<CapacityPolicyDbRow>(
    `select distinct on (scope_type) scope_type, revision, configuration
       from relay.capacity_policies
      where effective_at <= now()
        and (expires_at is null or expires_at > now())
        and (
          (scope_type = 'capacity_pool' and scope_id = $1)
          or (scope_type = 'tool' and scope_id = $2)
        )
      order by scope_type, revision desc`,
    [capacityPoolId, toolId],
  );
  const capacityPoolPolicy = rows.find((row: CapacityPolicyDbRow) =>
    row.scope_type === "capacity_pool"
  );
  const toolPolicy = rows.find((row: CapacityPolicyDbRow) =>
    row.scope_type === "tool"
  );
  const concurrencyPolicy = capacityPoolPolicy ?? toolPolicy;

  return {
    revision: concurrencyPolicy?.revision ?? null,
    limits: concurrencyPolicy === undefined
      ? DEFAULT_EXECUTION_CAPACITY_LIMITS
      : parseExecutionCapacityLimits(concurrencyPolicy.configuration),
    submissionRates: parseSubmissionRatePolicy(
      capacityPoolPolicy ?? null,
      toolPolicy ?? null,
    ),
  };
}

/**
 * Claims only the exact queued generation/policy represented by the ticket.
 * The job/run transition and queued→running counter shift commit together.
 * No attempt is created here: capacity waiting is not provider work.
 */
export async function claimJobForDispatch(
  pool: DatabasePool,
  ticket: ExecutionTicket,
  leaseOwner: string,
  leaseDurationMs: number,
): Promise<ClaimResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await lockQueueCounterMutation(client);
      const { rows } = await client.query<ClaimedJobDbRow>(
        `update relay.execution_jobs j
            set status = 'running',
                lease_epoch = j.lease_epoch + 1,
                lease_owner = $2,
                lease_expires_at = now() + ($3 || ' milliseconds')::interval,
                scheduler_ticket_token = null,
                state_version = j.state_version + 1
           from relay.tool_versions tv, relay.tools t, relay.capacity_pools cp,
                relay.routing_decisions rd
          where j.id = $1
            and j.dispatch_generation = $4
            and j.scheduling_policy_version = $5
            and j.scheduler_ticket_token = $6
            and j.status = 'queued'
            and j.eligible_at <= now()
            and (j.run_deadline_at is null or j.run_deadline_at > now())
            and (
              (j.attempt_count = 0 and (
                j.admission_deadline_at is null
                or j.admission_deadline_at > now()
              ))
              or (j.attempt_count > 0 and (
                j.attempt_deadline_at is null
                or j.attempt_deadline_at > now()
              ))
            )
            and tv.id = j.tool_version_id
            and t.id = tv.tool_id
            and t.lifecycle not in ('disabled', 'retired')
            and cp.id = j.capacity_pool_id
            and cp.enabled = true
            and rd.tool_run_id = j.run_id
            and rd.tool_version_id = j.tool_version_id
            and rd.capacity_pool_id = j.capacity_pool_id
          returning j.id, j.run_id, j.workspace_id, j.tool_version_id,
                    j.lease_epoch, j.dispatch_generation, j.state_version,
                    j.scheduling_policy_version, t.id as tool_id,
                    t.key as tool_key, rd.provider_model_id,
                    cp.id as capacity_pool_id, cp.key as capacity_pool_key,
                    j.estimated_cost_units`,
        [
          ticket.domainJobId,
          leaseOwner,
          leaseDurationMs,
          ticket.dispatchGeneration,
          ticket.policyVersion,
          ticket.schedulerToken,
        ],
      );

      if (rows.length === 0) {
        await client.query("rollback");
        return { kind: "no_op" };
      }

      const row = rows[0];
      const policy = await resolveExecutionCapacityPolicy(
        client,
        row.tool_id,
        row.capacity_pool_id,
      );
      const previousAttempt = await client.query<{
        retry_classification: string | null;
        provider_operation_id: string | null;
      }>(
        `select retry_classification, provider_operation_id
           from relay.job_attempts
          where job_id = $1 and finished_at is not null
          order by attempt_number desc
          limit 1`,
        [row.id],
      );
      const run = await client.query<{ id: string }>(
        `update relay.tool_runs
            set status = 'running', started_at = coalesce(started_at, now())
          where id = $1 and status = 'queued'
          returning id`,
        [row.run_id],
      );
      requireExactlyOne(run.rows, "claim execution run");
      await shiftCounters(client, row.tool_id, row.workspace_id, {
        queuedDelta: -1,
        runningDelta: 1,
      });
      await insertLifecycleOutbox(
        client,
        row.id,
        row.state_version,
        "job.started",
      );

      await client.query("commit");
      return {
        kind: "claimed",
        job: {
          jobId: row.id,
          runId: row.run_id,
          leaseEpoch: Number(row.lease_epoch),
          dispatchGeneration: row.dispatch_generation,
          workspaceId: row.workspace_id,
          toolVersionId: row.tool_version_id,
          toolId: row.tool_id,
          toolKey: row.tool_key,
          providerModelId: String(row.provider_model_id),
          capacityPoolId: String(row.capacity_pool_id),
          capacityPoolKey: row.capacity_pool_key,
          // Scheduler cost measures work/usage; concurrency counts active jobs.
          // A multi-image request still occupies one provider execution slot.
          capacityUnits: 1,
          policyVersion: row.scheduling_policy_version,
          capacityPolicyRevision: policy.revision,
          capacityLimits: policy.limits,
          submissionRatePolicy: policy.submissionRates,
          previousRetryClassification:
            previousAttempt.rows[0]?.retry_classification ?? null,
          previousProviderOperationId:
            previousAttempt.rows[0]?.provider_operation_id ?? null,
        },
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

async function resolveToolId(
  client: pg.PoolClient,
  toolVersionId: string,
): Promise<string> {
  const { rows } = await client.query<{ tool_id: string }>(
    `select tool_id from relay.tool_versions where id = $1`,
    [toolVersionId],
  );
  if (rows.length !== 1) throw new Error("Execution job references no tool");
  return rows[0].tool_id;
}

function requireExactlyOne(
  rows: readonly unknown[],
  operation: string,
): void {
  if (rows.length !== 1) {
    throw new Error(
      `${operation} affected ${rows.length} rows; expected exactly one`,
    );
  }
}

/** Fixed counter lock/update order: tool, workspace, workspace-tool. */
async function shiftCounters(
  client: pg.PoolClient,
  toolId: string,
  workspaceId: string,
  delta: { readonly queuedDelta: number; readonly runningDelta: number },
): Promise<void> {
  const tool = await client.query<{ tool_id: string }>(
    `update relay.tool_queue_counters
        set queued_count = queued_count + $2,
            running_count = running_count + $3,
            updated_at = now()
      where tool_id = $1
      returning tool_id`,
    [toolId, delta.queuedDelta, delta.runningDelta],
  );
  requireExactlyOne(tool.rows, "update tool queue counter");

  const workspace = await client.query<{ workspace_id: string }>(
    `update relay.workspace_queue_counters
        set queued_count = queued_count + $2,
            running_count = running_count + $3,
            updated_at = now()
      where workspace_id = $1
      returning workspace_id`,
    [workspaceId, delta.queuedDelta, delta.runningDelta],
  );
  requireExactlyOne(workspace.rows, "update workspace queue counter");

  const workspaceTool = await client.query<{ workspace_id: string }>(
    `update relay.workspace_tool_queue_counters
        set queued_count = queued_count + $3,
            running_count = running_count + $4,
            updated_at = now()
      where workspace_id = $1 and tool_id = $2
      returning workspace_id`,
    [workspaceId, toolId, delta.queuedDelta, delta.runningDelta],
  );
  requireExactlyOne(workspaceTool.rows, "update workspace-tool queue counter");
}

export interface PersistCapacityLeaseInput {
  readonly redisLeaseId: string;
  readonly redisScopeKeys: readonly string[];
  readonly expiresAt: Date;
  readonly units?: number;
}

/** Persists the Redis lease and attaches its FK under the current job fence. */
export async function persistCapacityLease(
  pool: DatabasePool,
  job: ClaimedJob,
  leaseOwner: string,
  input: PersistCapacityLeaseInput,
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const lease = await client.query<{ id: string }>(
        `insert into relay.execution_capacity_leases
           (job_id, lease_epoch, tool_id, workspace_id, capacity_pool_id,
            units, expires_at, policy_revision, redis_lease_id,
            redis_scope_keys, lease_owner)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning id`,
        [
          job.jobId,
          job.leaseEpoch,
          job.toolId,
          job.workspaceId,
          job.capacityPoolId,
          input.units ?? 1,
          input.expiresAt,
          job.capacityPolicyRevision,
          input.redisLeaseId,
          JSON.stringify(input.redisScopeKeys),
          leaseOwner,
        ],
      );
      const attached = await client.query<{ id: string }>(
        `update relay.execution_jobs
            set capacity_lease_id = $4,
                capacity_policy_revision = $5
          where id = $1 and lease_epoch = $2 and lease_owner = $3
            and status = 'running' and capacity_lease_id is null
          returning id`,
        [
          job.jobId,
          job.leaseEpoch,
          leaseOwner,
          lease.rows[0].id,
          job.capacityPolicyRevision,
        ],
      );
      if (attached.rows.length !== 1) {
        await client.query("rollback");
        return null;
      }
      await client.query("commit");
      return lease.rows[0].id;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

/** Opens at most one durable attempt for a claimed lease epoch. */
export async function beginJobAttempt(
  pool: DatabasePool,
  job: ClaimedJob,
  leaseOwner: string,
): Promise<JobAttempt | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const owned = await client.query<{ attempt_count: number }>(
        `select attempt_count
           from relay.execution_jobs
          where id = $1 and lease_epoch = $2 and lease_owner = $3
            and status = 'running' and capacity_lease_id is not null
          for update`,
        [job.jobId, job.leaseEpoch, leaseOwner],
      );
      if (owned.rows.length !== 1) {
        await client.query("rollback");
        return null;
      }

      const existing = await client.query<{
        id: string;
        attempt_number: number;
        provider_idempotency_key: string | null;
      }>(
        `select id, attempt_number, provider_idempotency_key
           from relay.job_attempts
          where job_id = $1 and lease_epoch = $2`,
        [job.jobId, job.leaseEpoch],
      );
      if (existing.rows.length > 0) {
        requireExactlyOne(existing.rows, "load job attempt for lease epoch");
        if (existing.rows[0].provider_idempotency_key === null) {
          throw new Error(
            "Existing job attempt has no provider idempotency key",
          );
        }
        await client.query("commit");
        return {
          attemptId: existing.rows[0].id,
          attemptNumber: existing.rows[0].attempt_number,
          providerIdempotencyKey: existing.rows[0].provider_idempotency_key,
        };
      }

      const bumped = await client.query<{ attempt_count: number }>(
        `update relay.execution_jobs
            set attempt_count = attempt_count + 1,
                state_version = state_version + 1
          where id = $1 and lease_epoch = $2 and lease_owner = $3
            and status = 'running' and capacity_lease_id is not null
          returning attempt_count`,
        [job.jobId, job.leaseEpoch, leaseOwner],
      );
      requireExactlyOne(bumped.rows, "increment execution attempt count");

      const routing = await client.query<{ id: string }>(
        `select id from relay.routing_decisions where tool_run_id = $1`,
        [job.runId],
      );
      const providerIdempotencyKey = `execution-job.${job.jobId}`;
      const attempt = await client.query<{ id: string }>(
        `insert into relay.job_attempts
           (job_id, attempt_number, lease_epoch, submission_state,
            provider_idempotency_key, routing_decision_id)
         values ($1, $2, $3, 'pending', $4, $5)
         returning id`,
        [
          job.jobId,
          bumped.rows[0].attempt_count,
          job.leaseEpoch,
          providerIdempotencyKey,
          routing.rows[0]?.id ?? null,
        ],
      );
      requireExactlyOne(attempt.rows, "insert job attempt");
      await client.query("commit");
      return {
        attemptId: attempt.rows[0].id,
        attemptNumber: bumped.rows[0].attempt_count,
        providerIdempotencyKey,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function markAttemptSubmitting(
  pool: DatabasePool,
  jobId: string,
  attemptId: string,
  leaseEpoch: number,
  leaseOwner: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `update relay.job_attempts a
        set submission_state = 'submitting', heartbeat_at = now()
       from relay.execution_jobs j
      where a.id = $1 and a.job_id = j.id and j.id = $2
        and a.lease_epoch = $3 and j.lease_epoch = $3
        and j.lease_owner = $4 and j.status = 'running'
        and a.finished_at is null
        and a.submission_state in ('pending', 'submitting')
      returning a.id`,
    [attemptId, jobId, leaseEpoch, leaseOwner],
  );
  return rows.length === 1;
}

export async function markAttemptSubmitted(
  pool: DatabasePool,
  jobId: string,
  attemptId: string,
  leaseEpoch: number,
  leaseOwner: string,
  providerOperationId: string,
): Promise<boolean> {
  if (providerOperationId.trim().length === 0) {
    throw new Error("providerOperationId must not be empty");
  }
  const { rows } = await pool.query<{ id: string }>(
    `update relay.job_attempts a
        set submission_state = 'submitted',
            provider_operation_id = $5,
            heartbeat_at = now()
       from relay.execution_jobs j
      where a.id = $1 and a.job_id = j.id and j.id = $2
        and a.lease_epoch = $3 and j.lease_epoch = $3
        and j.lease_owner = $4 and j.status = 'running'
        and a.finished_at is null
        and a.submission_state in ('submitting', 'submitted')
        and (a.provider_operation_id is null or a.provider_operation_id = $5)
      returning a.id`,
    [attemptId, jobId, leaseEpoch, leaseOwner, providerOperationId],
  );
  return rows.length === 1;
}

export type JobHeartbeatResult =
  | { readonly kind: "renewed"; readonly cancelRequested: boolean }
  | { readonly kind: "deadline_exceeded" }
  | { readonly kind: "lost" };

export async function heartbeatJobLease(
  pool: DatabasePool,
  jobId: string,
  leaseEpoch: number,
  leaseOwner: string,
  leaseDurationMs: number,
  capacityLeaseExpiresAt?: Date,
): Promise<JobHeartbeatResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const owned = await client.query<{
        status: string;
        capacity_lease_id: string | null;
        run_deadline_at: Date | null;
        deadline_exceeded: boolean;
      }>(
        `select status, capacity_lease_id, run_deadline_at,
                run_deadline_at is not null and run_deadline_at <= now()
                  as deadline_exceeded
           from relay.execution_jobs
          where id = $1 and lease_epoch = $2 and lease_owner = $3
            and status in ('running', 'cancel_requested')
          for update`,
        [jobId, leaseEpoch, leaseOwner],
      );
      if (owned.rows.length !== 1) {
        await client.query("rollback");
        return { kind: "lost" };
      }
      if (owned.rows[0].deadline_exceeded) {
        await client.query("commit");
        return { kind: "deadline_exceeded" };
      }

      const renewedJob = await client.query<{ id: string }>(
        `update relay.execution_jobs
            set lease_expires_at = now() + ($4 || ' milliseconds')::interval
          where id = $1 and lease_epoch = $2 and lease_owner = $3
            and status in ('running', 'cancel_requested')
          returning id`,
        [jobId, leaseEpoch, leaseOwner, leaseDurationMs],
      );
      requireExactlyOne(renewedJob.rows, "renew execution job lease");

      await client.query(
        `update relay.job_attempts
            set heartbeat_at = now()
          where job_id = $1 and lease_epoch = $2 and finished_at is null`,
        [jobId, leaseEpoch],
      );

      if (
        capacityLeaseExpiresAt !== undefined &&
        owned.rows[0].capacity_lease_id !== null
      ) {
        const capacity = await client.query<{ id: string }>(
          `update relay.execution_capacity_leases
              set expires_at = $5
            where id = $1 and job_id = $2 and lease_epoch = $3
              and lease_owner = $4 and released_at is null
            returning id`,
          [
            owned.rows[0].capacity_lease_id,
            jobId,
            leaseEpoch,
            leaseOwner,
            capacityLeaseExpiresAt,
          ],
        );
        if (capacity.rows.length !== 1) {
          await client.query("rollback");
          return { kind: "lost" };
        }
      }

      await client.query("commit");
      return {
        kind: "renewed",
        cancelRequested: owned.rows[0].status === "cancel_requested",
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

/** Backwards-compatible boolean heartbeat for callers that do not own capacity. */
export async function heartbeatJob(
  pool: DatabasePool,
  jobId: string,
  leaseEpoch: number,
  leaseOwner: string,
  leaseDurationMs: number,
): Promise<boolean> {
  return (await heartbeatJobLease(
    pool,
    jobId,
    leaseEpoch,
    leaseOwner,
    leaseDurationMs,
  )).kind === "renewed";
}

async function loadExecutionOutboxPayload(
  client: pg.PoolClient,
  jobId: string,
): Promise<ExecutionOutboxPayload> {
  const { rows } = await client.query<{
    id: string;
    run_id: string;
    capacity_pool_key: string;
    dispatch_generation: number;
    scheduling_policy_version: number;
    workspace_id: string;
    scheduling_class: string;
    estimated_cost_units: string | number;
    fifo_sequence: string | number;
    eligible_at: Date;
    traceparent: string | null;
    tracestate: string | null;
  }>(
    `select j.id, j.run_id, cp.key as capacity_pool_key,
            j.dispatch_generation, j.scheduling_policy_version,
            j.workspace_id, j.scheduling_class, j.estimated_cost_units,
            j.fifo_sequence, j.eligible_at,
            trace_context.traceparent, trace_context.tracestate
       from relay.execution_jobs j
       join relay.capacity_pools cp on cp.id = j.capacity_pool_id
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
      where j.id = $1`,
    [jobId],
  );
  if (rows.length !== 1) throw new Error("Execution job has no outbox payload");
  const row = rows[0];
  return parseExecutionOutboxPayload({
    domainJobId: row.id,
    runId: row.run_id,
    capacityPoolKey: row.capacity_pool_key,
    dispatchGeneration: row.dispatch_generation,
    policyVersion: row.scheduling_policy_version,
    ...(row.traceparent === null ? {} : { traceparent: row.traceparent }),
    ...(row.tracestate === null ? {} : { tracestate: row.tracestate }),
    workspaceId: row.workspace_id,
    classKey: row.scheduling_class,
    costUnits: Number(row.estimated_cost_units),
    fifoSequence: Number(row.fifo_sequence),
    eligibleAtMs: row.eligible_at.getTime(),
  });
}

async function insertDispatchOutbox(
  client: pg.PoolClient,
  eventType: "job.ready" | "job.deferred",
  payload: ExecutionOutboxPayload,
  eligibleAt: Date,
): Promise<void> {
  await client.query(
    `insert into relay.outbox_events
       (aggregate_type, aggregate_id, aggregate_version, event_type, payload,
        eligible_at, deduplication_key)
     values ('execution_job', $1, $2, $3, $4, $5, $6)
     on conflict (deduplication_key) where deduplication_key is not null
     do nothing`,
    [
      payload.domainJobId,
      payload.dispatchGeneration,
      eventType,
      JSON.stringify(payload),
      eligibleAt,
      dispatchDeduplicationKey(
        payload.domainJobId,
        payload.dispatchGeneration,
      ),
    ],
  );
}

type LifecycleOutboxEventType = "job.started" | "job.terminal";

async function insertLifecycleOutbox(
  client: pg.PoolClient,
  jobId: string,
  aggregateVersion: string,
  eventType: LifecycleOutboxEventType,
): Promise<void> {
  const payload = await loadExecutionOutboxPayload(client, jobId);
  const eventName = eventType === "job.started" ? "started" : "terminal";
  const event = await client.query<{ id: string }>(
    `insert into relay.outbox_events
       (aggregate_type, aggregate_id, aggregate_version, event_type, payload,
        deduplication_key)
     values ('execution_job', $1, $2, $3, $4, $5)
     on conflict (deduplication_key) where deduplication_key is not null
     do nothing
     returning id`,
    [
      jobId,
      aggregateVersion,
      eventType,
      JSON.stringify(payload),
      `execution-job.${jobId}.${eventName}.${aggregateVersion}`,
    ],
  );
  requireExactlyOne(event.rows, `insert ${eventName} outbox event`);
}

export async function armSchedulerTicket(
  pool: DatabasePool,
  jobId: string,
  dispatchGeneration: number,
  proposedToken: string,
): Promise<string | null> {
  if (proposedToken.length < 16 || proposedToken.length > 256) {
    throw new Error("Scheduler ticket token has invalid length");
  }
  const { rows } = await pool.query<{ scheduler_ticket_token: string }>(
    `update relay.execution_jobs
        set scheduler_ticket_token = coalesce(scheduler_ticket_token, $3),
            state_version = case
              when scheduler_ticket_token is null then state_version + 1
              else state_version
            end
      where id = $1 and status = 'queued' and dispatch_generation = $2
      returning scheduler_ticket_token`,
    [jobId, dispatchGeneration, proposedToken],
  );
  return rows[0]?.scheduler_ticket_token ?? null;
}

/** Creates a newer durable generation when a dispatched transport ticket vanished. */
export async function rearmQueuedJobDispatch(
  pool: DatabasePool,
  jobId: string,
  expectedGeneration: number,
  reason: string,
): Promise<ExecutionOutboxPayload | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const updated = await client.query<{ eligible_at: Date }>(
        `update relay.execution_jobs
            set dispatch_generation = dispatch_generation + 1,
                eligible_at = greatest(eligible_at, now()),
                scheduler_ticket_token = null,
                state_version = state_version + 1
          where id = $1 and status = 'queued'
            and dispatch_generation = $2
            and (run_deadline_at is null or run_deadline_at > now())
            and (
              (attempt_count = 0 and (
                admission_deadline_at is null or admission_deadline_at > now()
              ))
              or (attempt_count > 0 and (
                attempt_deadline_at is null or attempt_deadline_at > now()
              ))
            )
          returning eligible_at`,
        [jobId, expectedGeneration],
      );
      if (updated.rows.length === 0) {
        await client.query("rollback");
        return null;
      }
      requireExactlyOne(updated.rows, "rearm queued scheduler dispatch");
      const payload = await loadExecutionOutboxPayload(client, jobId);
      await insertDispatchOutbox(
        client,
        "job.ready",
        payload,
        updated.rows[0].eligible_at,
      );
      const outbox = await client.query<{ id: string }>(
        `update relay.outbox_events
            set payload = jsonb_set(payload, '{reason}', to_jsonb($2::text), true)
          where deduplication_key = $1
          returning id`,
        [
          dispatchDeduplicationKey(jobId, payload.dispatchGeneration),
          reason,
        ],
      );
      requireExactlyOne(outbox.rows, "annotate rearmed scheduler outbox event");
      await client.query("commit");
      return payload;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

/** Capacity denial returns to queued without ever creating an attempt. */
export async function deferJob(
  pool: DatabasePool,
  jobId: string,
  runId: string,
  leaseEpoch: number,
  leaseOwner: string,
  eligibleAt: Date,
  reason: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await lockQueueCounterMutation(client);
      const selected = await client.query<{
        id: string;
        run_id: string;
        workspace_id: string;
        tool_version_id: string;
        dispatch_generation: number;
        scheduling_policy_version: number;
        capacity_pool_key: string;
        capacity_lease_id: string | null;
      }>(
        `select j.id, j.run_id, j.workspace_id, j.tool_version_id,
                j.dispatch_generation, j.scheduling_policy_version,
                cp.key as capacity_pool_key, j.capacity_lease_id
           from relay.execution_jobs j
           join relay.capacity_pools cp on cp.id = j.capacity_pool_id
          where j.id = $1 and j.run_id = $2 and j.lease_epoch = $3
            and j.lease_owner = $4 and j.status = 'running'
          for update of j`,
        [jobId, runId, leaseEpoch, leaseOwner],
      );
      if (selected.rows.length !== 1) {
        await client.query("rollback");
        return false;
      }
      const row = selected.rows[0];

      const updated = await client.query<{ dispatch_generation: number }>(
        `update relay.execution_jobs
            set status = 'queued',
                dispatch_generation = dispatch_generation + 1,
                deferral_count = deferral_count + 1,
                eligible_at = $5,
                scheduler_ticket_token = null,
                lease_owner = null,
                lease_expires_at = null,
                capacity_lease_id = null,
                state_version = state_version + 1
          where id = $1 and run_id = $2 and lease_epoch = $3
            and lease_owner = $4 and status = 'running'
          returning dispatch_generation`,
        [jobId, runId, leaseEpoch, leaseOwner, eligibleAt],
      );
      requireExactlyOne(updated.rows, "defer execution job");

      if (row.capacity_lease_id !== null) {
        const capacity = await client.query<{ id: string }>(
          `update relay.execution_capacity_leases
              set released_at = coalesce(released_at, now())
            where id = $1 and job_id = $2 and lease_epoch = $3
              and lease_owner = $4 and released_at is null
            returning id`,
          [row.capacity_lease_id, jobId, leaseEpoch, leaseOwner],
        );
        requireExactlyOne(capacity.rows, "release deferred capacity lease");
      }

      const run = await client.query<{ id: string }>(
        `update relay.tool_runs set status = 'queued'
          where id = $1 and status = 'running'
          returning id`,
        [runId],
      );
      requireExactlyOne(run.rows, "defer execution run");
      const toolId = await resolveToolId(client, row.tool_version_id);
      await shiftCounters(client, toolId, row.workspace_id, {
        queuedDelta: 1,
        runningDelta: -1,
      });
      const payload = await loadExecutionOutboxPayload(client, jobId);
      await insertDispatchOutbox(client, "job.deferred", payload, eligibleAt);
      const outbox = await client.query<{ id: string }>(
        `update relay.outbox_events
            set payload = jsonb_set(payload, '{reason}', to_jsonb($2::text), true)
          where deduplication_key = $1
          returning id`,
        [
          dispatchDeduplicationKey(jobId, updated.rows[0].dispatch_generation),
          reason,
        ],
      );
      requireExactlyOne(outbox.rows, "annotate deferred outbox event");

      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Finishes one provider attempt and returns the same logical job to the durable
 * queue. Capacity deferrals use deferJob instead and therefore never reach this
 * transition or consume an attempt.
 */
export async function retryJob(
  pool: DatabasePool,
  jobId: string,
  runId: string,
  attemptId: string,
  leaseEpoch: number,
  leaseOwner: string,
  eligibleAt: Date,
  attemptDeadlineAt: Date,
  retryClassification: string,
  error: unknown,
  failureCode?: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await lockQueueCounterMutation(client);
      const selected = await client.query<{
        id: string;
        run_id: string;
        workspace_id: string;
        tool_version_id: string;
        dispatch_generation: number;
        scheduling_policy_version: number;
        capacity_pool_key: string;
        capacity_lease_id: string | null;
      }>(
        `select j.id, j.run_id, j.workspace_id, j.tool_version_id,
                j.dispatch_generation, j.scheduling_policy_version,
                cp.key as capacity_pool_key, j.capacity_lease_id
           from relay.execution_jobs j
           join relay.capacity_pools cp on cp.id = j.capacity_pool_id
          where j.id = $1 and j.run_id = $2 and j.lease_epoch = $3
            and j.lease_owner = $4 and j.status = 'running'
          for update of j`,
        [jobId, runId, leaseEpoch, leaseOwner],
      );
      if (selected.rows.length !== 1) {
        await client.query("rollback");
        return false;
      }
      const row = selected.rows[0];
      if (row.capacity_lease_id === null) {
        throw new Error("Retryable attempt has no durable capacity lease");
      }

      const attempt = await client.query<{ id: string }>(
        `update relay.job_attempts
            set submission_state = 'completed',
                heartbeat_at = now(),
                finished_at = now(),
                outcome = 'retry_scheduled',
                retry_classification = $4,
                sanitized_error = $5,
                failure_code = $6
          where id = $1 and job_id = $2 and lease_epoch = $3
            and finished_at is null
          returning id`,
        [
          attemptId,
          jobId,
          leaseEpoch,
          retryClassification,
          sanitizeError(error),
          failureCode ?? null,
        ],
      );
      requireExactlyOne(attempt.rows, "finish retryable job attempt");

      const updated = await client.query<{ dispatch_generation: number }>(
        `update relay.execution_jobs
            set status = 'queued',
                dispatch_generation = dispatch_generation + 1,
                eligible_at = $5,
                attempt_deadline_at = $6,
                scheduler_ticket_token = null,
                lease_owner = null,
                lease_expires_at = null,
                capacity_lease_id = null,
                state_version = state_version + 1
          where id = $1 and run_id = $2 and lease_epoch = $3
            and lease_owner = $4 and status = 'running'
          returning dispatch_generation`,
        [
          jobId,
          runId,
          leaseEpoch,
          leaseOwner,
          eligibleAt,
          attemptDeadlineAt,
        ],
      );
      requireExactlyOne(updated.rows, "schedule execution retry");

      const capacity = await client.query<{ id: string }>(
        `update relay.execution_capacity_leases
            set released_at = coalesce(released_at, now())
          where id = $1 and job_id = $2 and lease_epoch = $3
            and lease_owner = $4 and released_at is null
          returning id`,
        [row.capacity_lease_id, jobId, leaseEpoch, leaseOwner],
      );
      requireExactlyOne(capacity.rows, "release retry capacity lease");

      const run = await client.query<{ id: string }>(
        `update relay.tool_runs
            set status = 'queued', terminal_at = null
          where id = $1 and status = 'running'
          returning id`,
        [runId],
      );
      requireExactlyOne(run.rows, "queue execution run retry");

      const toolId = await resolveToolId(client, row.tool_version_id);
      await shiftCounters(client, toolId, row.workspace_id, {
        queuedDelta: 1,
        runningDelta: -1,
      });
      const payload = await loadExecutionOutboxPayload(client, jobId);
      await insertDispatchOutbox(client, "job.deferred", payload, eligibleAt);
      const outbox = await client.query<{ id: string }>(
        `update relay.outbox_events
            set payload = jsonb_set(payload, '{reason}', to_jsonb($2::text), true)
          where deduplication_key = $1
          returning id`,
        [
          dispatchDeduplicationKey(jobId, updated.rows[0].dispatch_generation),
          `scheduled_retry:${retryClassification}`,
        ],
      );
      requireExactlyOne(outbox.rows, "annotate retry outbox event");

      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

interface TerminalTransitionInput {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly allowedStatuses: readonly ("running" | "cancel_requested")[];
  readonly attemptId: string | null;
  readonly submissionState: string;
  readonly outcome: string;
  readonly retryClassification: string | null;
  readonly sanitizedError: string | null;
  readonly failureCode: string | null;
}

async function transitionJobToTerminal(
  pool: DatabasePool,
  jobId: string,
  leaseEpoch: number,
  leaseOwner: string,
  input: TerminalTransitionInput,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await lockQueueCounterMutation(client);
      const selected = await client.query<{
        run_id: string;
        workspace_id: string;
        tool_version_id: string;
        capacity_lease_id: string | null;
      }>(
        `select run_id, workspace_id, tool_version_id, capacity_lease_id
           from relay.execution_jobs
          where id = $1 and lease_epoch = $2 and lease_owner = $3
            and status = any($4::text[])
          for update`,
        [jobId, leaseEpoch, leaseOwner, [...input.allowedStatuses]],
      );
      if (selected.rows.length !== 1) {
        await client.query("rollback");
        return false;
      }
      const row = selected.rows[0];
      if (input.attemptId !== null && row.capacity_lease_id === null) {
        throw new Error("Terminal job attempt has no durable capacity lease");
      }

      if (input.attemptId !== null) {
        const attempt = await client.query<{ id: string }>(
          `update relay.job_attempts
              set submission_state = $4,
                  heartbeat_at = now(),
                  finished_at = now(),
                  outcome = $5,
                  retry_classification = $6,
                  sanitized_error = $7,
                  failure_code = $8
            where id = $1 and job_id = $2 and lease_epoch = $3
              and finished_at is null
            returning id`,
          [
            input.attemptId,
            jobId,
            leaseEpoch,
            input.submissionState,
            input.outcome,
            input.retryClassification,
            input.sanitizedError,
            input.failureCode,
          ],
        );
        requireExactlyOne(attempt.rows, "finish terminal job attempt");
      }

      const job = await client.query<{ state_version: string }>(
        `update relay.execution_jobs
            set status = $4,
                terminal_at = now(),
                lease_owner = null,
                lease_expires_at = null,
                capacity_lease_id = null,
                scheduler_ticket_token = null,
                state_version = state_version + 1
          where id = $1 and lease_epoch = $2 and lease_owner = $3
            and status = any($5::text[])
          returning state_version`,
        [jobId, leaseEpoch, leaseOwner, input.status, [
          ...input.allowedStatuses,
        ]],
      );
      requireExactlyOne(job.rows, "terminalize execution job");

      if (row.capacity_lease_id !== null) {
        const capacity = await client.query<{ id: string }>(
          `update relay.execution_capacity_leases
              set released_at = coalesce(released_at, now())
            where id = $1 and job_id = $2 and lease_epoch = $3
              and lease_owner = $4 and released_at is null
            returning id`,
          [row.capacity_lease_id, jobId, leaseEpoch, leaseOwner],
        );
        requireExactlyOne(capacity.rows, "release terminal capacity lease");
      }

      const run = await client.query<{ id: string }>(
        `update relay.tool_runs
            set status = $2, terminal_at = now()
          where id = $1 and status = any($3::text[])
          returning id`,
        [row.run_id, input.status, [...input.allowedStatuses]],
      );
      requireExactlyOne(run.rows, "terminalize execution run");

      const toolId = await resolveToolId(client, row.tool_version_id);
      await shiftCounters(client, toolId, row.workspace_id, {
        queuedDelta: 0,
        runningDelta: -1,
      });
      await insertLifecycleOutbox(
        client,
        jobId,
        job.rows[0].state_version,
        "job.terminal",
      );
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

/** Completion is allowed to win a cancellation race, but remains epoch/owner fenced. */
export async function completeJobSuccessfully(
  pool: DatabasePool,
  jobId: string,
  attemptId: string,
  leaseEpoch: number,
  leaseOwner: string,
): Promise<boolean> {
  return await transitionJobToTerminal(pool, jobId, leaseEpoch, leaseOwner, {
    status: "succeeded",
    allowedStatuses: ["running", "cancel_requested"],
    attemptId,
    submissionState: "completed",
    outcome: "succeeded",
    retryClassification: null,
    sanitizedError: null,
    failureCode: null,
  });
}

export async function failJob(
  pool: DatabasePool,
  jobId: string,
  attemptId: string,
  leaseEpoch: number,
  leaseOwner: string,
  retryClassification: string,
  error: unknown,
  failureCode?: string,
): Promise<boolean> {
  const ambiguousSubmission = retryClassification === "submission_ambiguous";
  return await transitionJobToTerminal(pool, jobId, leaseEpoch, leaseOwner, {
    status: "failed",
    allowedStatuses: ["running"],
    attemptId,
    submissionState: ambiguousSubmission ? "ambiguous" : "completed",
    outcome: "failed",
    retryClassification,
    sanitizedError: sanitizeError(error),
    failureCode: ambiguousSubmission
      ? "provider_submission_ambiguous"
      : failureCode ?? null,
  });
}

export async function completeJobCancellation(
  pool: DatabasePool,
  jobId: string,
  attemptId: string | null,
  leaseEpoch: number,
  leaseOwner: string,
): Promise<boolean> {
  return await transitionJobToTerminal(pool, jobId, leaseEpoch, leaseOwner, {
    status: "cancelled",
    allowedStatuses: ["cancel_requested"],
    attemptId,
    submissionState: "cancelled",
    outcome: "cancelled",
    retryClassification: null,
    sanitizedError: null,
    failureCode: null,
  });
}

export type CancellationRequestResult =
  | { readonly kind: "requested"; readonly running: boolean }
  | { readonly kind: "already_requested" }
  | { readonly kind: "terminal_or_missing" };

/** Durable cancellation wins against a queued claim under the same row lock. */
export async function requestJobCancellation(
  pool: DatabasePool,
  jobId: string,
): Promise<CancellationRequestResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await lockQueueCounterMutation(client);
      const selected = await client.query<{
        id: string;
        run_id: string;
        workspace_id: string;
        tool_version_id: string;
        status: string;
        dispatch_generation: number;
        scheduling_policy_version: number;
        capacity_pool_key: string;
        state_version: string;
      }>(
        `select j.id, j.run_id, j.workspace_id, j.tool_version_id, j.status,
                j.dispatch_generation, j.scheduling_policy_version,
                cp.key as capacity_pool_key, j.state_version
           from relay.execution_jobs j
           join relay.capacity_pools cp on cp.id = j.capacity_pool_id
          where j.id = $1
          for update of j`,
        [jobId],
      );
      if (selected.rows.length === 0) {
        await client.query("rollback");
        return { kind: "terminal_or_missing" };
      }
      const row = selected.rows[0];
      if (row.status === "cancel_requested") {
        await client.query("commit");
        return { kind: "already_requested" };
      }
      if (row.status !== "queued" && row.status !== "running") {
        await client.query("commit");
        return { kind: "terminal_or_missing" };
      }

      const running = row.status === "running";
      const nextStatus = running ? "cancel_requested" : "cancelled";
      const job = await client.query<{ state_version: string }>(
        `update relay.execution_jobs
            set status = $2,
                cancel_requested_at = now(),
                terminal_at = case when $2 = 'cancelled' then now() else terminal_at end,
                scheduler_ticket_token = null,
                state_version = state_version + 1
          where id = $1 and status = $3
          returning state_version`,
        [jobId, nextStatus, row.status],
      );
      requireExactlyOne(job.rows, "request execution job cancellation");

      const run = await client.query<{ id: string }>(
        `update relay.tool_runs
            set status = $2,
                terminal_at = case when $2 = 'cancelled' then now() else terminal_at end
          where id = $1 and status = $3
          returning id`,
        [row.run_id, nextStatus, row.status],
      );
      requireExactlyOne(run.rows, "request execution run cancellation");
      if (!running) {
        const toolId = await resolveToolId(client, row.tool_version_id);
        await shiftCounters(client, toolId, row.workspace_id, {
          queuedDelta: -1,
          runningDelta: 0,
        });
      }

      const payload = await loadExecutionOutboxPayload(client, jobId);
      const cancellationEvent = running
        ? "job.cancel_requested"
        : "job.cancelled";
      await client.query(
        `insert into relay.outbox_events
           (aggregate_type, aggregate_id, aggregate_version, event_type,
            payload, deduplication_key)
         values ('execution_job', $1, $2, $3, $4, $5)
         on conflict (deduplication_key) where deduplication_key is not null
         do nothing`,
        [
          jobId,
          job.rows[0].state_version,
          cancellationEvent,
          JSON.stringify(payload),
          `execution-job.${jobId}.cancel.${job.rows[0].state_version}`,
        ],
      );
      if (!running) {
        await insertLifecycleOutbox(
          client,
          jobId,
          job.rows[0].state_version,
          "job.terminal",
        );
      }
      await client.query("commit");
      return { kind: "requested", running };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

export interface ExpiredQueuedJobsResult {
  readonly expired: number;
}

/** Terminalizes queued work whose applicable durable deadline has elapsed. */
export async function expireQueuedJobs(
  pool: DatabasePool,
  now?: Date,
  batchSize: number = 100,
): Promise<ExpiredQueuedJobsResult> {
  const client = await pool.connect();
  let expired = 0;
  try {
    await client.query("begin");
    try {
      await lockQueueCounterMutation(client);
      const effectiveNow = now ?? (await client.query<{ now: Date }>(
        "select now() as now",
      )).rows[0].now;
      const { rows } = await client.query<{
        id: string;
        run_id: string;
        workspace_id: string;
        tool_version_id: string;
      }>(
        `select id, run_id, workspace_id, tool_version_id
           from relay.execution_jobs
          where status = 'queued'
            and (
              (run_deadline_at is not null and run_deadline_at <= $1)
              or (
                attempt_count = 0
                and admission_deadline_at is not null
                and admission_deadline_at <= $1
              )
              or (
                attempt_count > 0
                and attempt_deadline_at is not null
                and attempt_deadline_at <= $1
              )
            )
          order by coalesce(
                     run_deadline_at,
                     attempt_deadline_at,
                     admission_deadline_at
                   ), id
          limit $2
          for update skip locked`,
        [effectiveNow, batchSize],
      );

      for (const row of rows) {
        const job = await client.query<{ state_version: string }>(
          `update relay.execution_jobs
              set status = 'failed',
                  terminal_at = $2,
                  lease_owner = null,
                  lease_expires_at = null,
                  capacity_lease_id = null,
                  scheduler_ticket_token = null,
                  state_version = state_version + 1
            where id = $1 and status = 'queued'
            returning state_version`,
          [row.id, effectiveNow],
        );
        requireExactlyOne(job.rows, "expire queued execution job");

        const run = await client.query<{ id: string }>(
          `update relay.tool_runs
              set status = 'failed', terminal_at = $2
            where id = $1 and status = 'queued'
            returning id`,
          [row.run_id, effectiveNow],
        );
        requireExactlyOne(run.rows, "expire queued execution run");

        const toolId = await resolveToolId(client, row.tool_version_id);
        await shiftCounters(client, toolId, row.workspace_id, {
          queuedDelta: -1,
          runningDelta: 0,
        });
        await insertLifecycleOutbox(
          client,
          row.id,
          job.rows[0].state_version,
          "job.terminal",
        );
        expired += 1;
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
  return { expired };
}

export interface DurableCapacityLease {
  readonly databaseLeaseId: string;
  readonly redisLeaseId: string;
  readonly redisScopeKeys: readonly string[];
  readonly expiresAt: Date;
  readonly ownerId: string;
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly units: number;
}

function parseScopeKeys(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

export interface StalledRecoveryResult {
  readonly recovered: number;
  readonly cancelled: number;
  readonly failed: number;
  readonly capacityLeasesToRelease: readonly DurableCapacityLease[];
}

/**
 * Fences expired workers by bumping lease_epoch. Safe retries get a fresh
 * dispatch generation/outbox row; cancellation/deadline cases terminalize and
 * every path decrements the running counters exactly once.
 */
export async function recoverExpiredJobLeases(
  pool: DatabasePool,
  now?: Date,
  batchSize: number = 100,
  retryWaitMs: number = 5 * 60_000,
): Promise<StalledRecoveryResult> {
  const client = await pool.connect();
  const leases: DurableCapacityLease[] = [];
  let recovered = 0;
  let cancelled = 0;
  let failed = 0;
  try {
    await client.query("begin");
    try {
      await lockQueueCounterMutation(client);
      const effectiveNow = now ?? (await client.query<{ now: Date }>(
        "select now() as now",
      )).rows[0].now;
      const { rows } = await client.query<{
        id: string;
        run_id: string;
        workspace_id: string;
        tool_version_id: string;
        status: "running" | "cancel_requested";
        lease_epoch: string;
        dispatch_generation: number;
        scheduling_policy_version: number;
        admission_deadline_at: Date | null;
        run_deadline_at: Date | null;
        attempt_count: number;
        capacity_pool_key: string;
        capacity_lease_id: string | null;
        redis_lease_id: string | null;
        redis_scope_keys: unknown;
        capacity_expires_at: Date | null;
        capacity_lease_owner: string | null;
        capacity_units: string | number | null;
        current_attempt_id: string | null;
        current_attempt_submission_state:
          | "pending"
          | "submitting"
          | "submitted"
          | null;
        current_attempt_provider_operation_id: string | null;
      }>(
        `select j.id, j.run_id, j.workspace_id, j.tool_version_id, j.status,
                j.lease_epoch, j.dispatch_generation,
                j.scheduling_policy_version, j.admission_deadline_at,
                j.run_deadline_at, j.attempt_count,
                cp.key as capacity_pool_key, j.capacity_lease_id,
                cl.redis_lease_id, cl.redis_scope_keys,
                cl.expires_at as capacity_expires_at,
                cl.lease_owner as capacity_lease_owner,
                cl.units as capacity_units,
                current_attempt.id as current_attempt_id,
                current_attempt.submission_state as current_attempt_submission_state,
                current_attempt.provider_operation_id as current_attempt_provider_operation_id
           from relay.execution_jobs j
           join relay.capacity_pools cp on cp.id = j.capacity_pool_id
           left join relay.execution_capacity_leases cl
             on cl.id = j.capacity_lease_id
           left join relay.job_attempts current_attempt
             on current_attempt.job_id = j.id
            and current_attempt.lease_epoch = j.lease_epoch
            and current_attempt.finished_at is null
          where j.status in ('running', 'cancel_requested')
            and j.lease_expires_at <= $1
          order by j.lease_expires_at, j.id
          limit $2
          for update of j skip locked`,
        [effectiveNow, batchSize],
      );

      for (const row of rows) {
        const deadlineExpired = (row.run_deadline_at !== null &&
          row.run_deadline_at <= effectiveNow) ||
          (row.attempt_count === 0 && row.admission_deadline_at !== null &&
            row.admission_deadline_at <= effectiveNow);
        const ambiguousSubmission = row.current_attempt_id !== null &&
          (row.current_attempt_submission_state === "submitting" ||
            row.current_attempt_submission_state === "submitted") &&
          row.current_attempt_provider_operation_id === null;
        const target = ambiguousSubmission
          ? "failed"
          : row.status === "cancel_requested"
          ? "cancelled"
          : deadlineExpired
          ? "failed"
          : "queued";
        const recoveredSubmissionState = target === "cancelled"
          ? "cancelled"
          : ambiguousSubmission
          ? "ambiguous"
          : "interrupted";
        const recoveredOutcome = target === "cancelled"
          ? "cancelled"
          : ambiguousSubmission
          ? "failed"
          : "worker_stalled";
        const recoveredRetryClassification = ambiguousSubmission
          ? "submission_ambiguous"
          : target === "failed"
          ? "deadline_exceeded"
          : row.current_attempt_provider_operation_id === null
          ? "pre_submission_failure"
          : "submission_confirmed";
        const recoveredFailureCode = ambiguousSubmission
          ? "provider_submission_ambiguous"
          : null;
        const recoveredError = ambiguousSubmission
          ? "Provider submission outcome is ambiguous after stalled-worker recovery"
          : target === "failed"
          ? "Execution deadline expired during stalled-worker recovery"
          : null;
        const nextGeneration = row.dispatch_generation +
          (target === "queued" ? 1 : 0);
        const retryDeadline = new Date(effectiveNow.getTime() + retryWaitMs);
        const job = await client.query<{ state_version: string }>(
          `update relay.execution_jobs
              set status = $2,
                  dispatch_generation = $3,
                  eligible_at = case when $2 = 'queued' then $4::timestamptz else eligible_at end,
                  attempt_deadline_at = case
                    when $2 = 'queued' then $6::timestamptz
                    else attempt_deadline_at
                  end,
                  terminal_at = case when $2 in ('failed', 'cancelled') then $4::timestamptz else null end,
                  lease_epoch = lease_epoch + 1,
                  lease_owner = null,
                  lease_expires_at = null,
                  capacity_lease_id = null,
                  scheduler_ticket_token = null,
                  state_version = state_version + 1
            where id = $1 and lease_epoch = $5
            returning state_version`,
          [
            row.id,
            target,
            nextGeneration,
            effectiveNow,
            row.lease_epoch,
            retryDeadline,
          ],
        );
        requireExactlyOne(job.rows, "recover expired execution job lease");
        const attempt = await client.query<{ id: string }>(
          `update relay.job_attempts
              set submission_state = $3,
                  heartbeat_at = now(),
                  finished_at = now(),
                  outcome = $4,
                  retry_classification = $5,
                  sanitized_error = $6,
                  failure_code = $7
            where job_id = $1 and lease_epoch = $2 and finished_at is null
            returning id`,
          [
            row.id,
            row.lease_epoch,
            recoveredSubmissionState,
            recoveredOutcome,
            target === "cancelled" ? null : recoveredRetryClassification,
            recoveredError,
            recoveredFailureCode,
          ],
        );
        if (row.current_attempt_id !== null) {
          requireExactlyOne(attempt.rows, "finish recovered job attempt");
        } else if (attempt.rows.length !== 0) {
          throw new Error("Recovered unexpected job attempts");
        }
        if (row.capacity_lease_id !== null) {
          const capacity = await client.query<{ id: string }>(
            `update relay.execution_capacity_leases
                set released_at = coalesce(released_at, now())
              where id = $1 and job_id = $2 and lease_epoch = $3
                and released_at is null
              returning id`,
            [row.capacity_lease_id, row.id, row.lease_epoch],
          );
          requireExactlyOne(capacity.rows, "release recovered capacity lease");
        }
        const run = await client.query<{ id: string }>(
          `update relay.tool_runs
              set status = $2,
                  terminal_at = case when $2 in ('failed', 'cancelled') then $3::timestamptz else null end
            where id = $1 and status in ('running', 'cancel_requested')
            returning id`,
          [row.run_id, target, effectiveNow],
        );
        requireExactlyOne(run.rows, "recover execution run");
        const toolId = await resolveToolId(client, row.tool_version_id);
        await shiftCounters(client, toolId, row.workspace_id, {
          queuedDelta: target === "queued" ? 1 : 0,
          runningDelta: -1,
        });

        if (target === "queued") {
          await insertDispatchOutbox(
            client,
            "job.ready",
            await loadExecutionOutboxPayload(client, row.id),
            effectiveNow,
          );
          recovered += 1;
        } else {
          await insertLifecycleOutbox(
            client,
            row.id,
            job.rows[0].state_version,
            "job.terminal",
          );
          if (target === "cancelled") cancelled += 1;
          else failed += 1;
        }

        const scopeKeys = parseScopeKeys(row.redis_scope_keys);
        if (
          row.capacity_lease_id !== null &&
          row.redis_lease_id !== null &&
          scopeKeys !== null &&
          row.capacity_expires_at !== null &&
          row.capacity_lease_owner !== null &&
          row.capacity_units !== null
        ) {
          leases.push({
            databaseLeaseId: row.capacity_lease_id,
            redisLeaseId: row.redis_lease_id,
            redisScopeKeys: scopeKeys,
            expiresAt: row.capacity_expires_at,
            ownerId: row.capacity_lease_owner,
            jobId: row.id,
            leaseEpoch: Number(row.lease_epoch),
            units: Number(row.capacity_units),
          });
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
  return {
    recovered,
    cancelled,
    failed,
    capacityLeasesToRelease: leases,
  };
}

/** Recomputes all three durable counters under one advisory transaction lock. */
export async function reconcileQueueCounters(
  pool: DatabasePool,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await lockQueueCounterReconciliation(client);
      await client.query(
        `insert into relay.tool_queue_counters
           (tool_id, queued_count, running_count, updated_at)
         select tv.tool_id,
                count(*) filter (where j.status = 'queued')::integer,
                count(*) filter (where j.status in ('running', 'cancel_requested'))::integer,
                now()
           from relay.execution_jobs j
           join relay.tool_versions tv on tv.id = j.tool_version_id
          group by tv.tool_id
         on conflict (tool_id) do update
           set queued_count = excluded.queued_count,
               running_count = excluded.running_count,
               updated_at = excluded.updated_at`,
      );
      await client.query(
        `update relay.tool_queue_counters c
            set queued_count = 0, running_count = 0, updated_at = now()
          where not exists (
            select 1 from relay.execution_jobs j
            join relay.tool_versions tv on tv.id = j.tool_version_id
            where tv.tool_id = c.tool_id
              and j.status in ('queued', 'running', 'cancel_requested')
          )`,
      );
      await client.query(
        `insert into relay.workspace_queue_counters
           (workspace_id, queued_count, running_count, updated_at)
         select j.workspace_id,
                count(*) filter (where j.status = 'queued')::integer,
                count(*) filter (where j.status in ('running', 'cancel_requested'))::integer,
                now()
           from relay.execution_jobs j
          group by j.workspace_id
         on conflict (workspace_id) do update
           set queued_count = excluded.queued_count,
               running_count = excluded.running_count,
               updated_at = excluded.updated_at`,
      );
      await client.query(
        `update relay.workspace_queue_counters c
            set queued_count = 0, running_count = 0, updated_at = now()
          where not exists (
            select 1 from relay.execution_jobs j
            where j.workspace_id = c.workspace_id
              and j.status in ('queued', 'running', 'cancel_requested')
          )`,
      );
      await client.query(
        `insert into relay.workspace_tool_queue_counters
           (workspace_id, tool_id, queued_count, running_count, updated_at)
         select j.workspace_id, tv.tool_id,
                count(*) filter (where j.status = 'queued')::integer,
                count(*) filter (where j.status in ('running', 'cancel_requested'))::integer,
                now()
           from relay.execution_jobs j
           join relay.tool_versions tv on tv.id = j.tool_version_id
          group by j.workspace_id, tv.tool_id
         on conflict (workspace_id, tool_id) do update
           set queued_count = excluded.queued_count,
               running_count = excluded.running_count,
               updated_at = excluded.updated_at`,
      );
      await client.query(
        `update relay.workspace_tool_queue_counters c
            set queued_count = 0, running_count = 0, updated_at = now()
          where not exists (
            select 1 from relay.execution_jobs j
            join relay.tool_versions tv on tv.id = j.tool_version_id
            where j.workspace_id = c.workspace_id and tv.tool_id = c.tool_id
              and j.status in ('queued', 'running', 'cancel_requested')
          )`,
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}
