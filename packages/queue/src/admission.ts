import type pg from "pg";
import { sha256Hex, withTransaction } from "@relay/database";
import type { DatabasePool } from "@relay/database";
import { generatePublicId, ID_PREFIXES } from "@relay/contracts";

/**
 * The "Acceptance transaction" from
 * docs/implementation-handoff/04-queue-capacity-scheduling.md, steps 1,
 * 3-5, 7-11. Steps 2 ("Authorize workspace, tool version, provider
 * binding, and scheduling class") and 6 ("Reserve usage") are not
 * implemented here -- they depend on the Wave 3B tool/provider catalog
 * and metering, neither of which exist yet. Callers must have already
 * authorized the request and resolved every ID below; this function's
 * job is only the durable admission write, done atomically.
 */
export interface AdmitRunInput {
  readonly workspaceId: string;
  /** Counter key -- the tool, not the tool *version*; matches `relay.tool_queue_counters.tool_id`. */
  readonly toolId: string;
  readonly toolVersionId: string;
  readonly createdBy: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly capacityPoolId: number;
  readonly schedulingClass: string;
  readonly schedulingPolicyVersion: number | null;
  readonly estimatedCostUnits: number | null;
  readonly admissionDeadlineMs: number;
  readonly runDeadlineMs: number | null;
  readonly limits: {
    readonly globalTool: number;
    readonly workspaceTotal: number;
    readonly workspaceTool: number;
  };
}

export type AdmitRunResult =
  | {
    readonly kind: "admitted";
    readonly runId: string;
    readonly jobId: string;
  }
  | { readonly kind: "replayed"; readonly runId: string }
  | { readonly kind: "idempotency_conflict" }
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

export async function admitToolRun(
  pool: DatabasePool,
  input: AdmitRunInput,
): Promise<AdmitRunResult> {
  const canonicalPayloadHash = await sha256Hex(canonicalStringify(input.input));

  return await withTransaction(pool, async (client) => {
    const existing = await client.query<
      { canonical_payload_hash: string; run_id: string | null }
    >(
      `select canonical_payload_hash, run_id from relay.idempotency_records
       where workspace_id = $1 and idempotency_key = $2`,
      [input.workspaceId, input.idempotencyKey],
    );

    if (existing.rows.length > 0) {
      const record = existing.rows[0];
      if (record.canonical_payload_hash !== canonicalPayloadHash) {
        return { kind: "idempotency_conflict" };
      }
      // A replay recorded before its run/job insert committed (a crash
      // between steps 10 and 11 restored via lease/outbox reconciliation,
      // not here) would have a null run_id; this admission function
      // always inserts both in the same transaction, so that state never
      // reaches this branch in practice, but it's still not a valid
      // replay target -- treat it as a conflict rather than returning
      // a nonexistent run.
      if (record.run_id === null) {
        return { kind: "idempotency_conflict" };
      }
      return { kind: "replayed", runId: record.run_id };
    }

    // Deterministic lock order -- global-tool, then workspace-total, then
    // workspace-tool -- per step 4, so two concurrent admissions can never
    // deadlock against each other.
    const globalToolCount = await lockToolCounter(client, input.toolId);
    if (globalToolCount >= input.limits.globalTool) {
      return { kind: "queue_full", scope: "global_tool" };
    }

    const workspaceTotalCount = await lockWorkspaceCounter(
      client,
      input.workspaceId,
    );
    if (workspaceTotalCount >= input.limits.workspaceTotal) {
      return { kind: "queue_full", scope: "workspace_total" };
    }

    const workspaceToolCount = await lockWorkspaceToolCounter(
      client,
      input.workspaceId,
      input.toolId,
    );
    if (workspaceToolCount >= input.limits.workspaceTool) {
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
        input.capacityPoolId,
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
      [input.toolId],
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
      [input.workspaceId, input.toolId],
    );

    await client.query(
      `insert into relay.idempotency_records
         (workspace_id, idempotency_key, canonical_payload_hash, run_id)
       values ($1, $2, $3, $4)`,
      [input.workspaceId, input.idempotencyKey, canonicalPayloadHash, runId],
    );

    await client.query(
      `insert into relay.outbox_events
         (aggregate_type, aggregate_id, aggregate_version, event_type, payload)
       values ('execution_job', $1, 1, 'job.ready', $2)`,
      [jobId, JSON.stringify({ domainJobId: jobId, runId })],
    );

    return { kind: "admitted", runId, jobId };
  });
}
