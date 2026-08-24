import type pg from "pg";
import { sha256Hex, withTransaction } from "@relay/database";
import type { DatabasePool } from "@relay/database";
import { generatePublicId, ID_PREFIXES } from "@relay/contracts";
import { getMembership } from "@relay/auth";
import {
  type CatalogRouteSelection,
  type HandlerRegistry,
  persistCatalogRoutingDecision,
  resolveCatalogRoute,
} from "@relay/catalog";
import {
  resolveWorkspaceSchedulingProfile,
  type WorkspaceSchedulingProfile,
} from "@relay/scheduler";
import {
  injectTraceContext,
  type TracePropagationApi,
} from "@relay/observability";
import { lockQueueCounterMutation } from "./counter-lock.ts";
import {
  dispatchDeduplicationKey,
  MAX_SCHEDULER_COST_UNITS,
} from "./tickets.ts";

/**
 * The "Acceptance transaction" from
 * docs/implementation-handoff/04-queue-capacity-scheduling.md, steps
 * 1-5, 7-11. Workspace membership, immutable catalog routing, scheduling
 * profile, and cost are all resolved by server-owned services or database
 * constraints. Step 6 ("Reserve usage") is represented by the required
 * AdmissionUsagePort; this package does not silently install an unmetered
 * production fallback. Queue depth limits are resolved server-side from
 * `relay.capacity_policies` (see `resolveQueueLimits` below), never
 * accepted from the caller -- an admission caller choosing its own
 * limits could admit past whatever depth every other admission control
 * assumes is real.
 */
export interface AdmitRunInput {
  readonly workspaceId: string;
  readonly toolVersionId: string;
  readonly createdBy: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly requestedModelVersion?: string | null;
  readonly admissionDeadlineMs: number;
  readonly runDeadlineMs: number | null;
}

export interface AdmissionUsageRequest {
  readonly workspaceId: string;
  readonly toolVersionId: string;
  readonly createdBy: string;
  readonly input: unknown;
  readonly route: CatalogRouteSelection;
  readonly schedulingProfile: WorkspaceSchedulingProfile;
}

export interface AdmissionUsageQuote {
  readonly estimatedCostUnits: number;
  /** Stable version/fingerprint of the server-owned estimate policy. */
  readonly policyKey: string;
}

/** Future metering integrates here without changing the acceptance transaction. */
export interface AdmissionUsagePort {
  quote(
    client: pg.PoolClient,
    request: AdmissionUsageRequest,
  ): Promise<AdmissionUsageQuote>;
  reserve(
    client: pg.PoolClient,
    request: AdmissionUsageRequest,
    quote: AdmissionUsageQuote,
  ): Promise<string | null>;
}

export interface AdmitRunDependencies {
  readonly handlers: HandlerRegistry;
  readonly usage: AdmissionUsagePort;
  /** Test seam; production injects through Deno's active global context. */
  readonly tracePropagation?: TracePropagationApi;
}

export type AdmitRunResult =
  | {
    readonly kind: "admitted";
    readonly runId: string;
    readonly jobId: string;
  }
  | { readonly kind: "replayed"; readonly runId: string }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "not_a_member" }
  /** No matching `relay.tool_versions` row, it isn't published, or its tool is disabled/retired. */
  | { readonly kind: "tool_version_unavailable" }
  /** The tool version has no enabled `relay.tool_provider_bindings` row to route through. */
  | { readonly kind: "no_provider_binding" }
  | {
    readonly kind: "queue_full";
    readonly scope: "global_tool" | "workspace_total" | "workspace_tool";
  };

const TOOL_VERSION_UNAVAILABLE_CODES = new Set([
  "tool_version_not_found",
  "tool_version_unpublished",
  "tool_disabled",
  "tool_retired",
  "handler_not_registered",
  "handler_compatibility_mismatch",
  "immutable_hash_mismatch",
]);

function unavailableCatalogResult(
  issueCodes: readonly string[],
): AdmitRunResult {
  return issueCodes.some((code) => TOOL_VERSION_UNAVAILABLE_CODES.has(code))
    ? { kind: "tool_version_unavailable" }
    : { kind: "no_provider_binding" };
}

function assertEstimatedCostUnits(value: number): void {
  if (
    !Number.isFinite(value) || value <= 0 ||
    value > MAX_SCHEDULER_COST_UNITS
  ) {
    throw new Error(
      `Admission usage estimate must be between 0 and ${MAX_SCHEDULER_COST_UNITS}`,
    );
  }
}

/**
 * Deterministic key order so the same logical payload always hashes the
 * same way regardless of how the caller happened to construct the
 * object -- object-key insertion order isn't semantically meaningful for
 * a JSON request body, but `JSON.stringify` is sensitive to it.
 */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${
      entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

interface QueueLimits {
  readonly globalTool: number;
  readonly workspaceTotal: number;
  readonly workspaceTool: number;
}

/**
 * Used until a tool has its own `relay.capacity_policies` row -- there is
 * no admin UI yet to create one (Wave 5's weighted-fair-scheduler
 * territory), so a tool with no configured policy must still get *some*
 * limit rather than fail closed entirely. Deliberately conservative: a
 * misconfigured or forgotten policy should throttle a tool hard, not
 * silently admit an unbounded queue.
 */
const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  globalTool: 50,
  workspaceTotal: 20,
  workspaceTool: 5,
};

function isQueueLimits(value: unknown): value is QueueLimits {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.globalTool === "number" &&
    typeof v.workspaceTotal === "number" &&
    typeof v.workspaceTool === "number";
}

/**
 * Resolves queue-depth admission limits from `relay.capacity_policies`
 * (`scope_type = 'tool'`, `scope_id = toolId`), never from the caller --
 * see the module doc comment. Picks the highest-revision row that is
 * currently effective (`effective_at <= now()` and, if set,
 * `expires_at > now()`); falls back to `DEFAULT_QUEUE_LIMITS` when no
 * such row exists yet, or its `configuration` doesn't have the shape
 * this admission logic actually reads (better to fall back to a safe
 * default than to silently admit under a policy nobody meant to write).
 */
async function resolveQueueLimits(
  client: pg.PoolClient,
  toolId: string,
): Promise<QueueLimits> {
  const { rows } = await client.query<{ configuration: unknown }>(
    `select configuration from relay.capacity_policies
     where scope_type = 'tool' and scope_id = $1
       and effective_at <= now()
       and (expires_at is null or expires_at > now())
     order by revision desc
     limit 1`,
    [toolId],
  );
  if (rows.length === 0) return DEFAULT_QUEUE_LIMITS;
  const configuration = rows[0].configuration;
  return isQueueLimits(configuration) ? configuration : DEFAULT_QUEUE_LIMITS;
}

interface CounterRow {
  queued_count: number;
}

/**
 * Locks (inserting the row on first use) exactly one counter row and
 * returns its current `queued_count`. `INSERT ... ON CONFLICT DO UPDATE`
 * is used purely for its row-lock side effect -- it always returns the
 * current row, whether this call created it or a prior admission did,
 * with no separate SELECT FOR UPDATE round trip.
 */
async function lockToolCounter(
  client: pg.PoolClient,
  toolId: string,
): Promise<number> {
  const { rows } = await client.query<CounterRow>(
    `insert into relay.tool_queue_counters (tool_id) values ($1)
     on conflict (tool_id) do update set tool_id = excluded.tool_id
     returning queued_count`,
    [toolId],
  );
  return rows[0].queued_count;
}

async function lockWorkspaceCounter(
  client: pg.PoolClient,
  workspaceId: string,
): Promise<number> {
  const { rows } = await client.query<CounterRow>(
    `insert into relay.workspace_queue_counters (workspace_id) values ($1)
     on conflict (workspace_id) do update set workspace_id = excluded.workspace_id
     returning queued_count`,
    [workspaceId],
  );
  return rows[0].queued_count;
}

async function lockWorkspaceToolCounter(
  client: pg.PoolClient,
  workspaceId: string,
  toolId: string,
): Promise<number> {
  const { rows } = await client.query<CounterRow>(
    `insert into relay.workspace_tool_queue_counters (workspace_id, tool_id) values ($1, $2)
     on conflict (workspace_id, tool_id) do update set workspace_id = excluded.workspace_id
     returning queued_count`,
    [workspaceId, toolId],
  );
  return rows[0].queued_count;
}

/**
 * Thrown from inside the acceptance transaction when this admission loses
 * a concurrent race for the same `(workspace_id, idempotency_key)` pair
 * (see the comment on the final insert below). Throwing forces
 * `withTransaction` to roll back everything this attempt already wrote --
 * the run, job, counter increments, and outbox event -- before the caller
 * resolves the outcome against the winning attempt's now-committed row.
 * Never escapes `admitToolRun`.
 */
class IdempotencyRaceLost extends Error {}

function resolveAgainstRecord(
  record: { canonical_payload_hash: string; run_id: string | null } | undefined,
  canonicalPayloadHash: string,
): AdmitRunResult {
  if (record === undefined || record.run_id === null) {
    // A record with a null run_id is either a race we lost before our own
    // run/job insert (see IdempotencyRaceLost) or, in principle, a replay
    // recorded before its run/job insert committed and later restored via
    // lease/outbox reconciliation -- either way it is not a valid replay
    // target.
    return { kind: "idempotency_conflict" };
  }
  if (record.canonical_payload_hash !== canonicalPayloadHash) {
    return { kind: "idempotency_conflict" };
  }
  return { kind: "replayed", runId: record.run_id };
}

export async function admitToolRun(
  pool: DatabasePool,
  input: AdmitRunInput,
  dependencies: AdmitRunDependencies,
): Promise<AdmitRunResult> {
  // Scoped to actor + tool version + payload, not payload alone: an
  // idempotency key is only client-supplied and unique per
  // (workspace, key) -- nothing stops two different actors, or the same
  // actor targeting two different tool versions, from reusing the same
  // key with a coincidentally-identical `input.input`. Hashing payload
  // alone would treat that as a legitimate replay and hand back a run
  // that belongs to a different actor/tool version than the one this
  // call actually asked for; including createdBy/toolVersionId in the
  // hash makes that a conflict instead.
  if (
    !Number.isSafeInteger(input.admissionDeadlineMs) ||
    input.admissionDeadlineMs <= 0 ||
    (input.runDeadlineMs !== null &&
      (!Number.isSafeInteger(input.runDeadlineMs) || input.runDeadlineMs <= 0))
  ) {
    throw new TypeError(
      "Admission and run deadlines must be positive integers",
    );
  }

  // Capture the request span before entering the transaction. Trace metadata is
  // not part of idempotency and never contains baggage or application IDs.
  const traceContext = injectTraceContext(
    undefined,
    dependencies.tracePropagation,
  );
  let canonicalPayloadHash: string | undefined;

  try {
    return await withTransaction(pool, async (client) => {
      await lockQueueCounterMutation(client);

      // Serializes every concurrent admitToolRun call sharing this exact
      // (workspace, idempotency key) pair before either one can decide
      // anything -- released automatically on commit or rollback
      // (transaction-scoped, not session-scoped). Without this, two
      // truly concurrent duplicate requests can both pass the "existing
      // record?" SELECT below before either commits (read committed
      // isolation shows neither the other's uncommitted insert), so both
      // proceed to the real counter checks; if capacity is tight enough
      // that the winner's own admission fills the queue, the loser reads
      // that same now-full counter and returns a genuine `queue_full`
      // instead of ever discovering it was actually a duplicate of a
      // request that succeeded. Serializing here means the second caller
      // always sees the first's committed idempotency row (admitted or
      // not) before making any capacity decision of its own. Two int32
      // hashes, not one, to keep collision-driven false contention
      // (never incorrectness -- just occasional unnecessary blocking)
      // vanishingly rare.
      await client.query(
        `select pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [input.workspaceId, input.idempotencyKey],
      );

      // Step 2: authorize workspace membership first, before anything
      // else -- including an idempotency replay. Membership can change
      // between two calls with the same key (the caller left the
      // workspace, was removed, etc.), and a stale replay must not bypass
      // that: every admission, replay or not, is authorized against
      // *current* membership. Queried through this transaction's own
      // `client`, not the outer `pool` -- with `poolMax: 1` (the
      // production admission pool), a second `pool.query()` here would
      // never get a connection, since the only one is the one this
      // transaction is already holding.
      const membership = await getMembership(
        client,
        input.workspaceId,
        input.createdBy,
      );
      if (membership === null) return { kind: "not_a_member" };

      const routeResolution = await resolveCatalogRoute(
        client,
        dependencies.handlers,
        input.toolVersionId,
      );
      if (routeResolution.kind === "unavailable") {
        return unavailableCatalogResult(
          routeResolution.issues.map((issue) => issue.code),
        );
      }
      const routeSelection: CatalogRouteSelection = {
        route: routeResolution.route,
        fallback: routeResolution.fallback,
      };
      const toolId = routeResolution.route.toolId;
      const capacityPoolId = routeResolution.route.capacityPoolId;
      const capacityPool = await client.query<{ key: string }>(
        `select key from relay.capacity_pools
          where id = $1 and enabled = true`,
        [capacityPoolId],
      );
      if (capacityPool.rows.length !== 1) {
        return { kind: "no_provider_binding" };
      }
      const capacityPoolKey = capacityPool.rows[0].key;
      const schedulingProfile = await resolveWorkspaceSchedulingProfile(
        client,
        input.workspaceId,
      );
      const usagePort = dependencies.usage;
      const usageRequest: AdmissionUsageRequest = {
        workspaceId: input.workspaceId,
        toolVersionId: input.toolVersionId,
        createdBy: input.createdBy,
        input: input.input,
        route: routeSelection,
        schedulingProfile,
      };
      const usageQuote = await usagePort.quote(client, usageRequest);
      assertEstimatedCostUnits(usageQuote.estimatedCostUnits);
      if (usageQuote.policyKey.trim() === "") {
        throw new Error("Admission usage policy key must not be empty");
      }
      canonicalPayloadHash = await sha256Hex(canonicalStringify({
        workspaceId: input.workspaceId,
        actor: input.createdBy,
        toolVersionId: input.toolVersionId,
        input: input.input,
        requestedModelVersion: input.requestedModelVersion ?? null,
        admissionDeadlineMs: input.admissionDeadlineMs,
        runDeadlineMs: input.runDeadlineMs,
        route: routeSelection,
        schedulingProfile,
        usageQuote,
      }));

      const existing = await client.query<
        { canonical_payload_hash: string; run_id: string | null }
      >(
        `select canonical_payload_hash, run_id from relay.idempotency_records
         where workspace_id = $1 and idempotency_key = $2`,
        [input.workspaceId, input.idempotencyKey],
      );
      if (existing.rows.length > 0) {
        return resolveAgainstRecord(existing.rows[0], canonicalPayloadHash);
      }

      const limits = await resolveQueueLimits(client, toolId);

      // Deterministic lock order -- global-tool, then workspace-total, then
      // workspace-tool -- per step 4, so two concurrent admissions can
      // never deadlock against each other.
      const globalToolCount = await lockToolCounter(client, toolId);
      if (globalToolCount >= limits.globalTool) {
        return { kind: "queue_full", scope: "global_tool" };
      }

      const workspaceTotalCount = await lockWorkspaceCounter(
        client,
        input.workspaceId,
      );
      if (workspaceTotalCount >= limits.workspaceTotal) {
        return { kind: "queue_full", scope: "workspace_total" };
      }

      const workspaceToolCount = await lockWorkspaceToolCounter(
        client,
        input.workspaceId,
        toolId,
      );
      if (workspaceToolCount >= limits.workspaceTool) {
        return { kind: "queue_full", scope: "workspace_tool" };
      }

      const reservationId = await usagePort.reserve(
        client,
        usageRequest,
        usageQuote,
      );

      const runId = generatePublicId(ID_PREFIXES.toolRun);
      await client.query(
        `insert into relay.tool_runs
           (id, workspace_id, tool_version_id, status, input, reservation_id,
            created_by)
         values ($1, $2, $3, 'queued', $4, $5, $6)`,
        [
          runId,
          input.workspaceId,
          input.toolVersionId,
          JSON.stringify(input.input),
          reservationId,
          input.createdBy,
        ],
      );
      await persistCatalogRoutingDecision(client, runId, routeSelection, {
        requestedModelVersion: input.requestedModelVersion ?? null,
      });

      const admissionDeadlineAt = new Date(
        Date.now() + input.admissionDeadlineMs,
      );
      const runDeadlineAt = input.runDeadlineMs === null
        ? null
        : new Date(Date.now() + input.runDeadlineMs);

      const jobResult = await client.query<{
        id: string;
        scheduling_class: string;
        scheduling_policy_version: number;
        estimated_cost_units: string | number;
        fifo_sequence: string | number;
        eligible_at: Date;
      }>(
        `insert into relay.execution_jobs
           (run_id, workspace_id, tool_version_id, capacity_pool_id, status,
            scheduling_class, scheduling_policy_version, estimated_cost_units,
            admission_deadline_at, run_deadline_at)
         values ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9)
         returning id, scheduling_class, scheduling_policy_version,
                   estimated_cost_units, fifo_sequence, eligible_at`,
        [
          runId,
          input.workspaceId,
          input.toolVersionId,
          capacityPoolId,
          schedulingProfile.classKey,
          schedulingProfile.policyVersion,
          usageQuote.estimatedCostUnits,
          admissionDeadlineAt,
          runDeadlineAt,
        ],
      );
      const job = jobResult.rows[0];
      if (
        job.scheduling_class !== schedulingProfile.classKey ||
        job.scheduling_policy_version !== schedulingProfile.policyVersion
      ) {
        throw new Error("Scheduling profile changed during admission; retry");
      }
      const jobId = job.id;
      const persistedCostUnits = Number(job.estimated_cost_units);
      const fifoSequence = Number(job.fifo_sequence);
      assertEstimatedCostUnits(persistedCostUnits);
      if (!Number.isSafeInteger(fifoSequence) || fifoSequence <= 0) {
        throw new Error("Database returned an invalid execution FIFO sequence");
      }

      await client.query(
        `update relay.tool_queue_counters
           set queued_count = queued_count + 1, updated_at = now()
         where tool_id = $1`,
        [toolId],
      );
      await client.query(
        `update relay.workspace_queue_counters
           set queued_count = queued_count + 1, updated_at = now()
         where workspace_id = $1`,
        [input.workspaceId],
      );
      await client.query(
        `update relay.workspace_tool_queue_counters
           set queued_count = queued_count + 1, updated_at = now()
         where workspace_id = $1 and tool_id = $2`,
        [input.workspaceId, toolId],
      );

      // `ON CONFLICT ... DO NOTHING` rather than a plain insert: two
      // concurrent requests with the same idempotency key can both reach
      // this point having seen no existing record (the earlier SELECT ran
      // before either committed). A plain INSERT would make the loser
      // throw a raw unique-violation error here. DO NOTHING instead makes
      // the loser's insert block on the winner's row until the winner
      // commits or rolls back, then affect zero rows without erroring --
      // at which point this attempt has definitely lost the race and must
      // roll back its own run/job/counters/outbox event (they'd otherwise
      // be an orphaned duplicate of the winner's), so it throws to force
      // `withTransaction` to roll back, and the caller resolves the
      // outcome against the winner's now-committed record.
      const claim = await client.query<{ id: string }>(
        `insert into relay.idempotency_records
           (workspace_id, idempotency_key, canonical_payload_hash, run_id)
         values ($1, $2, $3, $4)
         on conflict (workspace_id, idempotency_key) do nothing
         returning id`,
        [input.workspaceId, input.idempotencyKey, canonicalPayloadHash, runId],
      );
      if (claim.rows.length === 0) {
        throw new IdempotencyRaceLost();
      }

      await client.query(
        `insert into relay.outbox_events
           (aggregate_type, aggregate_id, aggregate_version, event_type, payload,
            deduplication_key)
         values ('execution_job', $1, 0, 'job.ready', $2, $3)`,
        [
          jobId,
          JSON.stringify({
            domainJobId: jobId,
            runId,
            capacityPoolKey,
            dispatchGeneration: 0,
            policyVersion: job.scheduling_policy_version,
            ...traceContext,
            workspaceId: input.workspaceId,
            classKey: job.scheduling_class,
            costUnits: persistedCostUnits,
            fifoSequence,
            eligibleAtMs: job.eligible_at.getTime(),
          }),
          dispatchDeduplicationKey(jobId, 0),
        ],
      );

      return { kind: "admitted", runId, jobId };
    });
  } catch (error) {
    if (
      error instanceof IdempotencyRaceLost && canonicalPayloadHash !== undefined
    ) {
      const { rows } = await pool.query<
        { canonical_payload_hash: string; run_id: string | null }
      >(
        `select canonical_payload_hash, run_id from relay.idempotency_records
         where workspace_id = $1 and idempotency_key = $2`,
        [input.workspaceId, input.idempotencyKey],
      );
      return resolveAgainstRecord(rows[0], canonicalPayloadHash);
    }
    throw error;
  }
}
