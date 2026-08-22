import type pg from "pg";
import { sha256Hex, withTransaction } from "@relay/database";
import type { DatabasePool } from "@relay/database";
import { generatePublicId, ID_PREFIXES } from "@relay/contracts";
import { getMembership } from "@relay/auth";

/**
 * The "Acceptance transaction" from
 * docs/implementation-handoff/04-queue-capacity-scheduling.md, steps
 * 1-5, 7-11. Step 2 ("Authorize workspace, tool version, provider
 * binding, and scheduling class") is now implemented for workspace
 * membership, tool version, and provider binding, using the catalog and
 * auth packages built in Wave 3B/2A -- "scheduling class" authorization
 * (verifying the workspace is actually granted the requested class) is
 * still deferred, since `relay.workspace_scheduling_profiles` (the
 * weighted-fair-scheduler's, not yet built) doesn't exist. Step 6
 * ("Reserve usage") is also still deferred to metering, which doesn't
 * exist yet. Queue depth limits are resolved server-side from
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
  readonly schedulingClass: string;
  readonly schedulingPolicyVersion: number | null;
  readonly estimatedCostUnits: number | null;
  readonly admissionDeadlineMs: number;
  readonly runDeadlineMs: number | null;
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
  const canonicalPayloadHash = await sha256Hex(canonicalStringify({
    actor: input.createdBy,
    toolVersionId: input.toolVersionId,
    input: input.input,
  }));

  try {
    return await withTransaction(pool, async (client) => {
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

      const versionRows = await client.query<
        { tool_id: string; lifecycle: string }
      >(
        `select tv.tool_id, t.lifecycle
         from relay.tool_versions tv
         join relay.tools t on t.id = tv.tool_id
         where tv.id = $1 and tv.published_at is not null`,
        [input.toolVersionId],
      );
      if (versionRows.rows.length === 0) {
        return { kind: "tool_version_unavailable" };
      }
      const { tool_id: toolId, lifecycle } = versionRows.rows[0];
      if (lifecycle === "disabled" || lifecycle === "retired") {
        return { kind: "tool_version_unavailable" };
      }

      // A binding row being `enabled` only says the *routing entry*
      // itself hasn't been turned off -- it says nothing about whether
      // the provider, provider model, or capacity pool it points at are
      // themselves usable. Without these joins, a disabled provider/model
      // or a disabled capacity pool could still admit runs onto a route
      // nothing should be dispatching through. Excluding
      // disabled/retired here (not requiring exactly 'published') matches
      // the tool-lifecycle check just above: 'draft'/'internal'/
      // 'deprecated' provider state is a soft warning elsewhere, not a
      // hard admission block. A disabled/retired provider or model, or a
      // disabled pool, simply drops out of eligible routing order here --
      // if a lower-priority binding is still fully eligible, admission
      // falls through to it rather than rejecting outright.
      const bindingRows = await client.query<{ capacity_pool_id: number }>(
        `select tpb.capacity_pool_id
         from relay.tool_provider_bindings tpb
         join relay.provider_models pm on pm.id = tpb.provider_model_id
         join relay.providers p on p.id = pm.provider_id
         join relay.capacity_pools cp on cp.id = tpb.capacity_pool_id
         where tpb.tool_version_id = $1
           and tpb.enabled = true
           and cp.enabled = true
           and pm.lifecycle not in ('disabled', 'retired')
           and p.lifecycle not in ('disabled', 'retired')
         order by tpb.routing_order asc
         limit 1`,
        [input.toolVersionId],
      );
      if (bindingRows.rows.length === 0) return { kind: "no_provider_binding" };
      const capacityPoolId = bindingRows.rows[0].capacity_pool_id;

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

      const runId = generatePublicId(ID_PREFIXES.toolRun);
      await client.query(
        `insert into relay.tool_runs
           (id, workspace_id, tool_version_id, status, input, created_by)
         values ($1, $2, $3, 'queued', $4, $5)`,
        [
          runId,
          input.workspaceId,
          input.toolVersionId,
          JSON.stringify(input.input),
          input.createdBy,
        ],
      );

      const admissionDeadlineAt = new Date(
        Date.now() + input.admissionDeadlineMs,
      );
      const runDeadlineAt = input.runDeadlineMs === null
        ? null
        : new Date(Date.now() + input.runDeadlineMs);

      const jobResult = await client.query<{ id: string }>(
        `insert into relay.execution_jobs
           (run_id, workspace_id, tool_version_id, capacity_pool_id, status,
            scheduling_class, scheduling_policy_version, estimated_cost_units,
            admission_deadline_at, run_deadline_at)
         values ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9)
         returning id`,
        [
          runId,
          input.workspaceId,
          input.toolVersionId,
          capacityPoolId,
          input.schedulingClass,
          input.schedulingPolicyVersion,
          input.estimatedCostUnits,
          admissionDeadlineAt,
          runDeadlineAt,
        ],
      );
      const jobId = jobResult.rows[0].id;

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
           (aggregate_type, aggregate_id, aggregate_version, event_type, payload)
         values ('execution_job', $1, 1, 'job.ready', $2)`,
        [jobId, JSON.stringify({ domainJobId: jobId, runId })],
      );

      return { kind: "admitted", runId, jobId };
    });
  } catch (error) {
    if (error instanceof IdempotencyRaceLost) {
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
