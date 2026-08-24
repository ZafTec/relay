import {
  type ListWorkspaceEventsRequest,
  listWorkspaceEventsRequestSchema,
  type ListWorkspaceEventsResult,
  listWorkspaceEventsResultSchema,
  type RunStatus,
  type WorkspaceEventData,
  type WorkspaceEventEnvelope,
  workspaceEventEnvelopeSchema,
} from "@relay/contracts";
import type { DatabasePool } from "@relay/database";
import type { WorkspaceActorContext } from "../context.ts";
import { validateWorkspaceActorContext } from "../context.ts";
import { decodeCursor, encodeCursor, InvalidCursorError } from "../cursor.ts";
import type { WorkspaceEventApplicationService } from "../services.ts";
import { hasCurrentMembership, iso } from "./shared.ts";

const INTERNAL_EVENT_TYPES = [
  "job.ready",
  "job.deferred",
  "job.cancel_requested",
  "job.cancelled",
] as const;

interface EventRow {
  readonly id: string;
  readonly aggregate_version: string;
  readonly event_type: (typeof INTERNAL_EVENT_TYPES)[number];
  readonly created_at: Date | string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly run_status: RunStatus;
}

function eventFromRow(row: EventRow): WorkspaceEventData {
  switch (row.event_type) {
    case "job.ready":
      return row.aggregate_version === "0"
        ? { type: "run.created", runId: row.run_id }
        : { type: "run.progress_changed", runId: row.run_id };
    case "job.deferred":
      return { type: "run.progress_changed", runId: row.run_id };
    case "job.cancel_requested":
      return {
        type: "run.status_changed",
        runId: row.run_id,
        status: "cancel_requested",
      };
    case "job.cancelled":
      return { type: "run.completed", runId: row.run_id, status: "cancelled" };
  }
}

export class PostgresWorkspaceEventService
  implements WorkspaceEventApplicationService {
  readonly #pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.#pool = pool;
  }

  async list(
    rawContext: WorkspaceActorContext,
    rawRequest: ListWorkspaceEventsRequest,
  ): Promise<ListWorkspaceEventsResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const request = listWorkspaceEventsRequestSchema.parse(rawRequest);
    if (!await hasCurrentMembership(this.#pool, context)) {
      return { kind: "not_found" };
    }

    let afterId: string | null = null;
    if (request.cursor !== null) {
      const position = decodeCursor(request.cursor, "events", "", 1);
      if (!/^[1-9][0-9]{0,18}$/.test(position[0])) {
        throw new InvalidCursorError("event cursor position is invalid");
      }
      afterId = position[0];
    }

    const { rows } = await this.#pool.query<EventRow>(
      `select event.id::text, event.aggregate_version::text,
              event.event_type, event.created_at,
              job.workspace_id, job.run_id, run.status as run_status
         from relay.outbox_events event
         join relay.execution_jobs job
           on event.aggregate_type = 'execution_job'
          and event.aggregate_id = job.id::text
         join relay.tool_runs run
           on run.workspace_id = job.workspace_id and run.id = job.run_id
        where job.workspace_id = $1
          and exists (
            select 1 from auth.member member
             where member."organizationId" = job.workspace_id
               and member."userId" = $2
          )
          and event.event_type = any($3::text[])
          and ($4::bigint is null or event.id > $4)
        order by event.id asc
        limit $5`,
      [
        context.workspaceId,
        context.actorUserId,
        [...INTERNAL_EVENT_TYPES],
        afterId,
        request.limit + 1,
      ],
    );
    const hasMore = rows.length > request.limit;
    const selected = rows.slice(0, request.limit);
    const items = selected.map((row: EventRow): WorkspaceEventEnvelope =>
      workspaceEventEnvelopeSchema.parse({
        id: row.id,
        workspaceId: row.workspace_id,
        occurredAt: iso(row.created_at),
        event: eventFromRow(row),
      })
    );
    const last = selected.at(-1);
    return listWorkspaceEventsResultSchema.parse({
      kind: "ok",
      items,
      nextCursor: hasMore && last !== undefined
        ? encodeCursor("events", "", [last.id])
        : null,
    });
  }
}
