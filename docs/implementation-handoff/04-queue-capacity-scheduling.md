# BullMQ, capacity, and fair scheduling

Phase: Wave 3A after a mandatory Wave 0 spike\
Primary owner: queue/worker worktree\
Depends on: merged Wave 3.0 run/job/outbox/capacity contracts, Redis
configuration, auth workspace IDs\
Blocks: asynchronous tools, MCP execution, provider work, live run UI

## Objective

Provide durable asynchronous execution where PostgreSQL records accepted work,
BullMQ transports near-ready tickets, Redis enforces global capacity, and a fair
scheduler prevents one workspace or service class from monopolizing a tool.

## Proposed paths

```text
packages/queue/
  src/bullmq.ts
  src/tickets.ts
  src/outbox-relay.ts
  src/reconciliation.ts
packages/capacity/
  src/coordinator.ts
  src/policies.ts
  src/scripts/*.lua or embedded equivalents
  src/fair-scheduler.ts
  src/leases.ts
apps/worker/src/
packages/database/src/migrations/<reserved-execution-ids>.ts
```

Wave 3.0 owns durable run/job transitions, counter schemas, capacity pools, and
migration IDs. Queue and capacity agents may work in parallel only after those
contracts merge and their worktrees rebase.

## BullMQ compatibility gate

Research found BullMQ imports and compiles under Deno with env/net permissions,
but live production behavior remains unproven.

Spike both clients:

```text
bullmq 6.1.2 + redis 6.2.1 through createNodeRedisClient
bullmq 6.1.2 + ioredis 5.11.1
```

Prefer the official node-redis adapter for standalone Redis if it passes. Select
ioredis when required behavior such as Cluster/Sentinel support makes it
necessary and its compiled tests pass.

Restrictions:

- Explicitly construct the Redis client; do not rely on dynamic default loading.
- Inline async processor functions only.
- No sandboxed processor paths, child processes, or worker-thread processor
  files in the compiled binary.
- No broad filesystem, subprocess, or FFI permission solely for BullMQ.
- Frozen lockfile and source-free Linux runtime.

Failure of both supported client lanes is an architecture blocker. Do not write
BullMQ's private Redis structures or silently replace the approved queue.

## Durable versus transport state

PostgreSQL owns:

- Run/job status
- Inputs and output references
- Attempts and submission certainty
- Eligibility/deadline
- Idempotency
- Usage reservation
- Queue depth counters
- Cancellation
- Outbox and reconciliation state

BullMQ owns:

- Short-lived execution tickets
- Worker delivery and lock
- Near-term delay/retry transport where fairness is not bypassed
- Operational queue events

A BullMQ ticket contains only durable references:

```ts
interface ExecutionTicket {
  domainJobId: string;
  dispatchGeneration: number;
  policyVersion: number;
  traceparent?: string;
  tracestate?: string;
}
```

Never put prompts, credentials, provider payloads, signed URLs, or file metadata
in the queue payload.

## Queue topology

Use one BullMQ queue per capacity pool, not per tier. A capacity pool represents
shared constraints such as provider account/model/region or a local execution
class.

Keep the BullMQ waiting buffer shallow—approximately enough to keep workers
busy. The durable backlog and fair order remain in PostgreSQL plus Relay-owned
Redis scheduler structures. If thousands of jobs are pushed directly into
BullMQ, BullMQ FIFO/priority order bypasses weighted fairness.

BullMQ global concurrency remains a secondary safety cap. Relay's capacity
coordinator is authoritative for cross-tool/provider/workspace constraints.

## Acceptance transaction

The HTTP/MCP application service performs one PostgreSQL transaction:

1. Resolve idempotency and return the existing run for a matching replay.
2. Authorize workspace, tool version, provider binding, and scheduling class.
3. Validate tool/queue policy.
4. Lock global-tool, workspace-total, then workspace-tool queue-counter rows in
   that deterministic order.
5. Reject if any configured global, workspace-total, or workspace-tool queued
   depth is full.
6. Reserve usage.
7. Create run and job.
8. Store `eligible_at`, `admission_deadline_at`, `run_deadline_at`, class, cost
   units, and policy revisions.
9. Increment durable queued depth.
10. Insert outbox `job.ready`.
11. Commit and return `202`.

Redis availability is not inside this transaction. If Redis is down, outbox
reconciliation can publish later until durable backlog limits are reached. The
API may remain ready in a documented degraded-admission mode while PostgreSQL is
healthy; it reports `coordination_unavailable` and no live-dispatch promise.
Workers and schedulers fail readiness and start no provider work until Redis
state is healthy and reconciled.

## Suggested durable fields

The canonical run is defined before the transport job:

```text
relay.tool_runs
  id
  workspace_id
  tool_version_id
  status
  result_completeness nullable
  input jsonb
  output_set_id nullable
  reservation_id
  idempotency_record_id
  created_by
  accepted_at
  started_at nullable
  terminal_at nullable
```

Run transitions use the canonical states `queued`, `running`, `succeeded`,
`failed`, `cancel_requested`, and `cancelled`. Partial output is terminal
`succeeded` plus explicit completeness/warnings unless the tool contract defines
zero acceptable outputs, in which case it fails.

Capacity pools and policies are also Wave 3.0 contracts:

```text
relay.capacity_pools
  id
  key unique
  provider_model_id nullable
  region nullable
  execution_class
  enabled

relay.capacity_policies
  id
  scope_type
  scope_id
  revision
  configuration jsonb
  effective_at
  expires_at nullable
```

```text
relay.execution_jobs
  id
  run_id
  workspace_id
  tool_version_id
  capacity_pool_id
  status
  scheduling_class
  scheduling_policy_version
  estimated_cost_units
  accepted_at
  eligible_at
  admission_deadline_at
  attempt_deadline_at nullable
  run_deadline_at nullable
  dispatch_generation
  attempt_count
  deferral_count
  lease_epoch
  lease_owner
  lease_expires_at
  capacity_lease_id nullable
  capacity_policy_revision nullable
  cancel_requested_at
  terminal_at
  state_version
```

```text
relay.job_attempts
  id
  job_id
  attempt_number
  lease_epoch
  submission_state
  provider_idempotency_key
  provider_operation_id
  routing_decision_id
  actual_model_version nullable
  started_at
  heartbeat_at
  finished_at
  outcome
  retry_classification
  sanitized_error
```

```text
relay.tool_queue_counters
  tool_id primary key
  queued_count
  running_count
  updated_at

relay.workspace_queue_counters
  workspace_id primary key
  queued_count
  running_count
  updated_at

relay.workspace_tool_queue_counters
  workspace_id
  tool_id
  queued_count
  running_count
  updated_at
  primary key (workspace_id, tool_id)

relay.execution_capacity_leases
  id
  job_id
  lease_epoch
  tool_id
  workspace_id
  capacity_pool_id
  units
  acquired_at
  expires_at
  released_at nullable
  policy_revision
```

Every counter change occurs in the same transaction as the state transition.
Admission locks global-tool, workspace-total, then workspace-tool counter rows
in one documented order to avoid deadlocks. Scheduling class/profile assignment
is loaded from a server-owned workspace grant; clients cannot request `paid`,
`enterprise`, or `internal`. Periodic reconciliation detects and repairs
counter/lease drift.

## Transactional outbox

Outbox rows include stable event ID, aggregate/version, type, bounded payload,
eligibility, lease, attempt count, publication time, and last sanitized error.

Relay claims batches with `FOR UPDATE SKIP LOCKED`, commits the claim, performs
Redis/BullMQ I/O outside the transaction, then conditionally marks publication.

Publication is at least once. Therefore:

- Redis ready insertion is idempotent.
- BullMQ ticket IDs are deterministic per job/generation.
- Worker claim is conditional in PostgreSQL.
- Provider submission has a durable idempotency key.

BullMQ job-ID deduplication is not durable after old jobs are removed.

## Worker claim and fencing

On BullMQ delivery:

1. Validate ticket version and IDs.
2. Conditionally claim the PostgreSQL job.
3. Increment a monotonic `lease_epoch`.
4. Return no-op when terminal, cancelled, or already superseded.
5. Acquire Redis execution capacity.
6. Persist attempt/submission intent before provider interaction.
7. Heartbeat PostgreSQL and Redis leases.
8. Require the expected epoch/owner on every state mutation.

A stale worker with epoch 41 cannot update a job after recovery issues epoch 42.
Provider idempotency and operation IDs are still required because external
providers do not understand Relay fencing.

## Capacity coordinator

Expose a domain interface rather than Redis keys:

```text
acquireExecutionLease
acquireSubmissionPermit
renewExecutionLease
releaseExecutionLease
setProviderCooldown
inspectCapacity
```

### Execution lease checks

- Global tool active limit
- Capacity-pool/provider active limit
- Workspace-total active limit
- Workspace tool active limit
- Optional scheduling-class share limit

### Submission permit checks

- Global tool start rate
- Provider/model request rate
- Provider cooldown
- Weighted cost/token limits when applicable

Use atomic Redis Lua scripts and Redis `TIME`. All relevant checks are
all-or-none; a denied later constraint must not consume an earlier token.

Use GCRA for smooth request-rate limits and token bucket for genuinely burstable
weighted quotas. Do not use fixed windows for provider limits.

## Redis keys and leases

The MVP capacity coordinator supports one standalone Redis authority. Place all
keys needed by one all-or-none acquisition in one explicit coordination hash
domain:

```text
relay:production:{capacity}:rate:tool:<tool-key>
relay:production:{capacity}:rate:provider:<provider-model>
relay:production:{capacity}:active:tool:<tool-key>
relay:production:{capacity}:active:workspace:<workspace-id>
relay:production:{capacity}:active:workspace:<workspace-id>:tool:<tool-key>
relay:production:{capacity}:active:pool:<pool-id>
relay:production:{capacity}:cooldown:<pool-id>
relay:production:{capacity}:scheduler:*
```

This deliberately concentrates coordination so Lua can enforce global tool,
provider, and workspace constraints atomically. Redis Cluster capacity sharding
is unsupported in the MVP. A future multi-region/Cluster design requires an ADR
and allocation protocol; pool-specific hash tags must not accidentally turn a
"global per-tool" limit into one limit per provider pool.

Concurrency uses expiring sorted-set leases. Scripts remove expired entries,
check units, add a lease, and return lease ID/expiry. Renew near one-third of
TTL. Release only when owner and lease ID match.

After Redis state loss, pause new provider submissions, reconcile durable
`execution_capacity_leases`, active PostgreSQL jobs, and worker heartbeats,
rehydrate leases, and apply a conservative cooldown before dispatch resumes. If
lease facts cannot be reconstructed, remain paused longer than every applicable
lease/rate window rather than risk an overshoot.

## Capacity deferral

Capacity waiting is not an attempt.

When no permit is available:

1. Do not call the provider.
2. Release any partial lease.
3. Return the job to queued state through a fenced transition.
4. Set `eligible_at` to coordinator `retryAt` plus bounded jitter.
5. Increment `deferral_count`, not `attempt_count`.
6. Emit a new scheduling outbox event.
7. Complete the current BullMQ ticket as a handled disposition.

Expose queue reason:

```text
awaiting_worker
global_tool_rate
global_tool_concurrency
provider_rate_limit
provider_cooldown
workspace_concurrency
scheduled_retry
coordination_unavailable
```

## Queue depth and maximum wait

PostgreSQL enforces exact queue depth atomically. A BullMQ `count` followed by
`add` is not a hard limit.

Define queued depth as ready, deferred, outbox-pending, and waiting-ticket jobs.
Running work has its own limit.

Use separate deadlines:

```text
admission_deadline_at = accepted_at + policy.max_initial_queue_wait
attempt_deadline_at   = retry scheduling decision + policy.max_retry_wait
run_deadline_at       = accepted_at + policy.max_total_run_time
```

The initial admission deadline applies only before the first provider attempt.
Retries use their own attempt deadline and remain bounded by the overall run
deadline, so a long valid provider attempt does not make a storage/retrieval
retry expire immediately. A sweeper terminalizes the applicable timeout,
releases or settles reservation by policy, and never calls the provider after
expiry.

## Weighted fair scheduling

Scheduling classes:

```text
standard
paid
enterprise
internal
```

Configuration is durable and versioned:

```text
relay.scheduler_classes
  class_key
  weight
  max_share nullable
  enabled
  policy_version

relay.workspace_scheduling_profiles
  workspace_id primary key
  class_key
  policy_version
  granted_by
  granted_at
  expires_at nullable
```

Every job stores its class, policy revision, and estimated cost units.
Production may initially map every workspace to `standard`; the engine and tests
support all classes from day one.

Scheduler replicas call one atomic Redis script that promotes due work, updates
bounded deficits, selects one candidate, and moves it to a short fenced
`dispatching` lease before BullMQ publication. PostgreSQL/outbox reconciliation
recovers an expired dispatch lease. Deficit and cursor state survive scheduler
process crashes in Redis and can be rebuilt conservatively from durable jobs.

Algorithm:

1. Weighted deficit round robin across classes.
2. Fair workspace selection within each class.
3. FIFO within a workspace.
4. Deduct estimated cost units, not always one.
5. Cap accumulated idle deficit, but never below the maximum valid single-job
   cost; every valid job must eventually accumulate enough deficit.
6. Borrow unused capacity when a class is empty.
7. Ensure every positive-weight backlogged class eventually progresses.
8. Apply a documented hard `internal.max_share` while customer classes are
   backlogged; unused customer capacity remains borrowable when they are empty.
9. Keep critical control-plane work in a separate bounded operational queue.

BullMQ OSS priorities do not satisfy this because sustained high priority can
starve lower classes. BullMQ Pro Groups also do not remove the need for weighted
classes, PostgreSQL durability, provider limits, or fencing.

## Retry classification

BullMQ transport tickets default to one attempt for provider work. Relay domain
logic decides retries.

Classify:

```text
pre_submission_failure        safe to retry
submission_confirmed          inspect/retrieve same operation
submission_ambiguous          reconcile; never blindly resubmit
retrieval_failure             retry retrieval
storage_failure               retry persistence without regeneration
provider_transient            bounded retry through capacity gate
provider_rate_limited         set cooldown and reschedule
schema_or_policy_failure      permanent; no automatic retry
safety_rejection              permanent unless inputs change
```

Each retry re-enters rate/capacity checks and preserves the same logical run.

## Cancellation

1. API transaction sets `cancel_requested` and writes outbox.
2. Scheduler removes pending entries best effort.
3. Waiting BullMQ ticket is removed best effort.
4. Redis Pub/Sub gives low-latency notice.
5. Owning worker aborts local operation where supported.
6. Worker always checks durable cancellation at phase/heartbeat boundaries.
7. Provider adapter requests cancellation when supported.
8. Final transition records cancellation, partial usage, or completion-won race.

BullMQ local cancellation is not the durable protocol.

## Graceful shutdown

Worker startup uses `autorun: false`, installs listeners, verifies dependencies
and scripts, marks ready, then runs.

On shutdown:

1. Mark not ready.
2. Stop outbox/scheduler claims.
3. Stop accepting new BullMQ work.
4. Wait under a deadline shorter than Compose grace.
5. Checkpoint or abort local operations near deadline.
6. Close Worker, Queue, QueueEvents, Redis clients, database pool, and
   telemetry.

Expect forced exits to create stalled tickets; PostgreSQL fencing and provider
idempotency make redelivery safe.

## Redis production requirements

- Redis 6.2+ and exact tested image/version
- Authentication or ACLs
- Private Docker network
- `maxmemory-policy noeviction`
- AOF, normally `appendfsync everysec`
- Memory sized for queue, scheduler, scripts, rate windows, and RedisInsight
- Monitoring for memory, evictions, blocked clients, latency, AOF errors,
  connections, and restarts
- Authenticated healthcheck
- Secrets not embedded in command-line arguments
- BullMQ `prefix`, never ioredis `keyPrefix`

The supplied 128 MB container cap is a risk and requires observed sizing before
production.

## Expected tests

### Compatibility

- Compiled Linux binary runs with no Node/source/node_modules.
- Live enqueue/consume, deterministic duplicate ticket, delay, retry, events,
  progress, and shutdown pass.
- No unsupported permission is required.
- Redis restart and `SCRIPT FLUSH` recover.

### Durability

- Crash after database commit before Redis publish recovers.
- Crash after Redis publish before outbox acknowledgement does not duplicate
  domain work.
- Redis ticket loss is reconciled.
- Stale fence cannot heartbeat or commit.
- Ambiguous provider submission never creates a second provider request.

### Limits

- Concurrent admission never exceeds exact tool/workspace depth.
- GCRA/token buckets show zero overshoot under multiple workers.
- Concurrency leases never exceed configured units.
- Cooldown cannot be shortened by an older response.
- Queue deadline prevents provider submission and releases reservation.
- Deferral does not increment attempts.

### Fairness

Under continuous equal-cost backlog:

- Throughput converges within an agreed tolerance of configured normalized
  weights after warm-up.
- Every positive-weight class has a bounded dispatch gap.
- Empty classes waste no capacity.
- Returning classes cannot use unlimited accumulated deficit.
- Variable-cost jobs progress without starving smaller or larger work.
- Internal class respects maximum share.
- Results hold with multiple scheduler replicas.

### Shutdown/cancellation

- Waiting/claim cancellation race
- Active abort signal propagation
- Provider cancellation unsupported/supported paths
- Completion-wins race
- SIGTERM graceful completion
- Deadline checkpoint/forced close
- No leaked connections/handles

## Completion gate

The phase completes only when accepted work is never permanently lost, duplicate
delivery cannot duplicate provider submission, configured global limits cannot
be exceeded, fair classes cannot starve, and all behavior runs from the compiled
Linux backend image.
