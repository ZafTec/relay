import {
  type CancelRunResult,
  cancelRunResultSchema,
  type GetRunResult,
  getRunResultSchema,
  type ListRunsRequest,
  listRunsRequestSchema,
  type ListRunsResult,
  listRunsResultSchema,
  PUBLIC_ID_PATTERNS,
  type RunDetail,
  runDetailSchema,
  type RunStatus,
  type RunSummary,
  runSummarySchema,
} from "@relay/contracts";
import type { DatabasePool } from "@relay/database";
import {
  type CancellationRequestResult,
  requestJobCancellation,
} from "@relay/queue";
import type { WorkspaceActorContext } from "../context.ts";
import { validateWorkspaceActorContext } from "../context.ts";
import { decodeCursor, encodeCursor, InvalidCursorError } from "../cursor.ts";
import type {
  RunCancellationApplicationService,
  RunReadApplicationService,
} from "../services.ts";
import { filterSignature } from "./filter.ts";
import { hasCurrentMembership, iso, isoOrNull, jsonArray } from "./shared.ts";

interface RunSummaryRow {
  readonly id: string;
  readonly status: RunStatus;
  readonly result_completeness: RunSummary["resultCompleteness"];
  readonly accepted_at: Date | string;
  readonly started_at: Date | string | null;
  readonly terminal_at: Date | string | null;
  readonly tool_key: string;
  readonly tool_name: string;
  readonly tool_version_id: string;
  readonly tool_version: number;
}

interface RunDetailRow extends RunSummaryRow {
  readonly input: unknown;
  readonly output_set_id: string | null;
  readonly requested_count: number | null;
  readonly produced_count: number | null;
  readonly output_completeness: RunDetail["resultCompleteness"];
  readonly warnings: unknown;
  readonly output_items: unknown;
  readonly reservation_id: string | null;
  readonly reservation_metric: string | null;
  readonly reservation_unit: string | null;
  readonly reservation_amount: string | null;
  readonly reservation_status:
    | "active"
    | "committed"
    | "released"
    | "expired"
    | null;
  readonly reservation_expires_at: Date | string | null;
}

function validateRunId(runId: string): string {
  if (!PUBLIC_ID_PATTERNS.run.test(runId)) {
    throw new TypeError("runId has an invalid format");
  }
  return runId;
}

function summaryFromRow(row: RunSummaryRow): RunSummary {
  return runSummarySchema.parse({
    id: row.id,
    tool: {
      key: row.tool_key,
      name: row.tool_name,
      versionId: row.tool_version_id,
      version: row.tool_version,
    },
    status: row.status,
    resultCompleteness: row.result_completeness,
    acceptedAt: iso(row.accepted_at),
    startedAt: isoOrNull(row.started_at),
    terminalAt: isoOrNull(row.terminal_at),
  });
}

function detailFromRow(row: RunDetailRow): RunDetail {
  let outputSet: unknown = null;
  if (row.output_set_id !== null) {
    if (
      row.requested_count === null || row.produced_count === null ||
      row.output_completeness === null
    ) {
      throw new TypeError("database returned an incomplete output set");
    }
    outputSet = {
      id: row.output_set_id,
      requestedCount: row.requested_count,
      producedCount: row.produced_count,
      completeness: row.output_completeness,
      warnings: jsonArray(row.warnings),
      items: jsonArray(row.output_items),
    };
  }

  const reservation = row.reservation_id === null ? null : {
    id: row.reservation_id,
    metric: row.reservation_metric,
    unit: row.reservation_unit,
    amount: row.reservation_amount,
    status: row.reservation_status,
    expiresAt: row.reservation_expires_at === null
      ? null
      : iso(row.reservation_expires_at),
  };

  return runDetailSchema.parse({
    ...summaryFromRow(row),
    input: row.input,
    outputSet,
    reservation,
  });
}

const RUN_DETAIL_SELECT = `
  select tr.id, tr.status, tr.result_completeness, tr.input,
         tr.accepted_at, tr.started_at, tr.terminal_at,
         t.key as tool_key, t.name as tool_name,
         tv.id as tool_version_id, tv.version as tool_version,
         os.id as output_set_id, os.requested_count, os.produced_count,
         os.completeness as output_completeness, os.warnings,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'ordinal', item.ordinal,
             'name', item.name,
             'status', item.status,
             'artifactId', version.artifact_id,
             'artifactVersionId', item.artifact_version_id,
             'errorCode', item.error_code
           ) order by item.ordinal)
             from relay.output_items item
             left join relay.artifact_versions version
               on version.workspace_id = item.workspace_id
              and version.id = item.artifact_version_id
            where item.workspace_id = tr.workspace_id
              and item.output_set_id = os.id
         ), '[]'::jsonb) as output_items,
         reservation.id as reservation_id,
         reservation.metric_key as reservation_metric,
         reservation.unit as reservation_unit,
         reservation.reserved_amount::text as reservation_amount,
         reservation.status as reservation_status,
         reservation.expires_at as reservation_expires_at
    from relay.tool_runs tr
    join relay.tool_versions tv on tv.id = tr.tool_version_id
    join relay.tools t on t.id = tv.tool_id
    left join relay.output_sets os
      on os.workspace_id = tr.workspace_id and os.id = tr.output_set_id
    left join relay.usage_reservations reservation
      on reservation.workspace_id = tr.workspace_id
     and reservation.id = tr.reservation_id`;

export async function loadRunDetail(
  pool: DatabasePool,
  rawContext: WorkspaceActorContext,
  rawRunId: string,
): Promise<GetRunResult> {
  const context = validateWorkspaceActorContext(rawContext);
  const runId = validateRunId(rawRunId);
  const { rows } = await pool.query<RunDetailRow>(
    `${RUN_DETAIL_SELECT}
    where tr.workspace_id = $1 and tr.id = $2
      and exists (
        select 1 from auth.member member
         where member."organizationId" = tr.workspace_id
           and member."userId" = $3
      )`,
    [context.workspaceId, runId, context.actorUserId],
  );
  const row = rows[0];
  return getRunResultSchema.parse(
    row === undefined
      ? { kind: "not_found" }
      : { kind: "found", run: detailFromRow(row) },
  );
}

export class PostgresRunReadService implements RunReadApplicationService {
  readonly #pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.#pool = pool;
  }

  async list(
    rawContext: WorkspaceActorContext,
    rawRequest: ListRunsRequest,
  ): Promise<ListRunsResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const request = listRunsRequestSchema.parse(rawRequest);
    if (!await hasCurrentMembership(this.#pool, context)) {
      return { kind: "not_found" };
    }

    const statuses = request.statuses === undefined
      ? null
      : [...request.statuses].sort();
    const filter = filterSignature([
      ["statuses", statuses],
      ["toolKey", request.toolKey ?? null],
      ["acceptedAfter", request.acceptedAfter ?? null],
      ["acceptedBefore", request.acceptedBefore ?? null],
    ]);
    let cursorAcceptedAt: string | null = null;
    let cursorId: string | null = null;
    if (request.cursor !== null) {
      const position = decodeCursor(request.cursor, "runs", filter, 2);
      const timestamp = new Date(position[0]);
      if (
        !Number.isFinite(timestamp.getTime()) ||
        timestamp.toISOString() !== position[0] ||
        !PUBLIC_ID_PATTERNS.run.test(position[1])
      ) {
        throw new InvalidCursorError("run cursor position is invalid");
      }
      [cursorAcceptedAt, cursorId] = position;
    }

    const { rows } = await this.#pool.query<RunSummaryRow>(
      `select tr.id, tr.status, tr.result_completeness,
              tr.accepted_at, tr.started_at, tr.terminal_at,
              t.key as tool_key, t.name as tool_name,
              tv.id as tool_version_id, tv.version as tool_version
         from relay.tool_runs tr
         join relay.tool_versions tv on tv.id = tr.tool_version_id
         join relay.tools t on t.id = tv.tool_id
        where tr.workspace_id = $1
          and exists (
            select 1 from auth.member member
             where member."organizationId" = tr.workspace_id
               and member."userId" = $2
          )
          and ($3::text[] is null or tr.status = any($3::text[]))
          and ($4::text is null or t.key = $4)
          and ($5::timestamptz is null or tr.accepted_at >= $5)
          and ($6::timestamptz is null or tr.accepted_at < $6)
          and ($7::timestamptz is null or
            (tr.accepted_at, tr.id) < ($7, $8))
        order by tr.accepted_at desc, tr.id desc
        limit $9`,
      [
        context.workspaceId,
        context.actorUserId,
        statuses,
        request.toolKey ?? null,
        request.acceptedAfter ?? null,
        request.acceptedBefore ?? null,
        cursorAcceptedAt,
        cursorId,
        request.limit + 1,
      ],
    );
    const hasMore = rows.length > request.limit;
    const selected = rows.slice(0, request.limit);
    const items = selected.map(summaryFromRow);
    const last = selected.at(-1);
    return listRunsResultSchema.parse({
      kind: "ok",
      items,
      nextCursor: hasMore && last !== undefined
        ? encodeCursor("runs", filter, [iso(last.accepted_at), last.id])
        : null,
    });
  }

  get(
    context: WorkspaceActorContext,
    runId: string,
  ): Promise<GetRunResult> {
    return loadRunDetail(this.#pool, context, runId);
  }
}

export type RequestJobCancellation = (
  pool: DatabasePool,
  jobId: string,
) => Promise<CancellationRequestResult>;

export class PostgresRunCancellationService
  implements RunCancellationApplicationService {
  readonly #pool: DatabasePool;
  readonly #requestCancellation: RequestJobCancellation;

  constructor(
    pool: DatabasePool,
    requestCancellation: RequestJobCancellation = requestJobCancellation,
  ) {
    this.#pool = pool;
    this.#requestCancellation = requestCancellation;
  }

  async cancel(
    rawContext: WorkspaceActorContext,
    rawRunId: string,
  ): Promise<CancelRunResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const runId = validateRunId(rawRunId);
    const { rows } = await this.#pool.query<{ job_id: string }>(
      `select job.id::text as job_id
         from relay.tool_runs run
         join relay.execution_jobs job
           on job.workspace_id = run.workspace_id and job.run_id = run.id
        where run.workspace_id = $1 and run.id = $2
          and exists (
            select 1 from auth.member member
             where member."organizationId" = run.workspace_id
               and member."userId" = $3
          )`,
      [context.workspaceId, runId, context.actorUserId],
    );
    if (rows.length !== 1) return { kind: "not_found" };

    const cancellation = await this.#requestCancellation(
      this.#pool,
      rows[0].job_id,
    );
    const current = await loadRunDetail(this.#pool, context, runId);
    if (current.kind === "not_found") return current;

    const kind = cancellation.kind === "requested"
      ? cancellation.running ? "cancel_requested" : "cancelled"
      : cancellation.kind === "already_requested"
      ? "cancel_requested"
      : "already_terminal";
    return cancelRunResultSchema.parse({ kind, run: current.run });
  }
}
