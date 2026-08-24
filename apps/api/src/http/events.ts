import type { Context } from "@hono/hono";
import { type SSEStreamingApi, streamSSE } from "@hono/hono/streaming";
import {
  encodeCursor,
  type WorkspaceActorContext,
  type WorkspaceEventApplicationService,
} from "@relay/application";
import {
  listWorkspaceEventsRequestSchema,
  listWorkspaceEventsResultSchema,
  MAX_PAGE_SIZE,
  type WorkspaceEventEnvelope,
} from "@relay/contracts";
import { invalidRequest, notFound } from "./errors.ts";
import {
  identityIsStillCurrent,
  type SessionIdentityResolver,
} from "./identity.ts";
import { parseContractInput } from "./request.ts";

export const SSE_RESYNCHRONIZED_EVENT = "relay.resynchronized";

export interface WorkspaceEventWaitRequest {
  readonly workspaceId: string;
  readonly afterEventId: string | null;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * Optional low-latency wake-up source. It is never treated as event history;
 * every wake-up is followed by a durable application-service read.
 */
export interface WorkspaceEventSource {
  wait(request: WorkspaceEventWaitRequest): Promise<void>;
}

export interface WorkspaceEventStreamOptions {
  readonly source?: WorkspaceEventSource;
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly reconnectDelayMs?: number;
  readonly pageSize?: number;
}

interface EventStreamDependencies {
  readonly events: WorkspaceEventApplicationService;
  readonly resolveIdentity: SessionIdentityResolver;
  readonly options?: WorkspaceEventStreamOptions;
}

interface StreamState {
  cursor: string | null;
  lastEventId: string | null;
  lastWriteAt: number;
}

const LAST_EVENT_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;

function positiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) || selected < 1 || selected > maximum
  ) {
    throw new TypeError(`${field} must be a positive bounded integer`);
  }
  return selected;
}

function eventOptions(options: WorkspaceEventStreamOptions | undefined) {
  return {
    source: options?.source ?? POLLING_WORKSPACE_EVENT_SOURCE,
    pollIntervalMs: positiveInteger(
      options?.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
      60_000,
    ),
    heartbeatIntervalMs: positiveInteger(
      options?.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
      120_000,
    ),
    reconnectDelayMs: positiveInteger(
      options?.reconnectDelayMs,
      DEFAULT_RECONNECT_DELAY_MS,
      "reconnectDelayMs",
      60_000,
    ),
    pageSize: positiveInteger(
      options?.pageSize,
      MAX_PAGE_SIZE,
      "pageSize",
      MAX_PAGE_SIZE,
    ),
  };
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export const POLLING_WORKSPACE_EVENT_SOURCE: WorkspaceEventSource = Object
  .freeze({
    wait(request: WorkspaceEventWaitRequest): Promise<void> {
      return abortableDelay(request.timeoutMs, request.signal);
    },
  });

async function waitForWake(
  source: WorkspaceEventSource,
  request: Omit<WorkspaceEventWaitRequest, "signal">,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const sourceAbort = new AbortController();
  const abortSource = () => sourceAbort.abort();
  signal.addEventListener("abort", abortSource, { once: true });
  try {
    await Promise.race([
      source.wait({ ...request, signal: sourceAbort.signal }),
      abortableDelay(request.timeoutMs, sourceAbort.signal),
    ]);
  } finally {
    signal.removeEventListener("abort", abortSource);
    sourceAbort.abort();
  }
}

function parseLastEventId(request: Request): string | null {
  const value = request.headers.get("last-event-id");
  if (value === null || value === "") return null;
  if (!LAST_EVENT_ID_PATTERN.test(value)) {
    throw invalidRequest({
      field: "last-event-id",
      reason: "invalid_event_id",
    });
  }
  return value;
}

function compareEventIds(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

async function writeEvent(
  stream: SSEStreamingApi,
  envelope: WorkspaceEventEnvelope,
  actor: WorkspaceActorContext,
  state: StreamState,
): Promise<void> {
  if (envelope.workspaceId !== actor.workspaceId) {
    throw new Error("application event escaped its workspace boundary");
  }
  if (
    state.lastEventId !== null &&
    compareEventIds(envelope.id, state.lastEventId) <= 0
  ) {
    throw new Error("application events are not strictly monotonic");
  }
  await stream.writeSSE({
    id: envelope.id,
    event: envelope.event.type,
    data: JSON.stringify(envelope),
  });
  state.lastEventId = envelope.id;
  state.cursor = encodeCursor("events", "", [envelope.id]);
  state.lastWriteAt = Date.now();
}

async function listEvents(
  service: WorkspaceEventApplicationService,
  actor: WorkspaceActorContext,
  cursor: string | null,
  pageSize: number,
) {
  const request = parseContractInput(listWorkspaceEventsRequestSchema, {
    cursor,
    limit: pageSize,
  });
  return listWorkspaceEventsResultSchema.parse(
    await service.list(actor, request),
  );
}

async function drainDurableEvents(
  stream: SSEStreamingApi,
  firstPage: Awaited<ReturnType<typeof listEvents>>,
  actor: WorkspaceActorContext,
  dependencies: EventStreamDependencies,
  pageSize: number,
  state: StreamState,
  signal: AbortSignal,
  request: Request,
): Promise<boolean> {
  let page = firstPage;
  while (!signal.aborted && !stream.aborted) {
    if (page.kind === "not_found") return false;
    for (const event of page.items) {
      await writeEvent(stream, event, actor, state);
      if (signal.aborted || stream.aborted) return false;
    }
    if (page.nextCursor === null) return true;
    if (page.items.length === 0) {
      throw new Error("application returned an empty event page with a cursor");
    }
    state.cursor = page.nextCursor;
    if (
      !await identityIsStillCurrent(
        dependencies.resolveIdentity,
        request,
        actor,
      )
    ) {
      return false;
    }
    page = await listEvents(
      dependencies.events,
      actor,
      state.cursor,
      pageSize,
    );
  }
  return false;
}

export async function createWorkspaceEventResponse(
  context: Context,
  actor: WorkspaceActorContext,
  dependencies: EventStreamDependencies,
): Promise<Response> {
  const request = context.req.raw;
  const lastEventId = parseLastEventId(request);
  const settings = eventOptions(dependencies.options);
  const initialCursor = lastEventId === null
    ? null
    : encodeCursor("events", "", [lastEventId]);
  const initialPage = await listEvents(
    dependencies.events,
    actor,
    initialCursor,
    settings.pageSize,
  );
  if (initialPage.kind === "not_found") throw notFound();

  context.header("x-accel-buffering", "no");
  context.header("vary", "Cookie, Last-Event-ID, Accept");

  const response = streamSSE(context, async (stream) => {
    const abort = new AbortController();
    const abortStream = () => abort.abort();
    stream.onAbort(abortStream);
    const state: StreamState = {
      cursor: initialCursor,
      lastEventId,
      lastWriteAt: Date.now(),
    };

    try {
      await stream.write(": connected\n\n");
      state.lastWriteAt = Date.now();
      if (
        !await drainDurableEvents(
          stream,
          initialPage,
          actor,
          dependencies,
          settings.pageSize,
          state,
          abort.signal,
          request,
        )
      ) return;
      await stream.writeSSE({
        event: SSE_RESYNCHRONIZED_EVENT,
        data: JSON.stringify({ lastEventId: state.lastEventId }),
        retry: settings.reconnectDelayMs,
      });
      state.lastWriteAt = Date.now();

      while (!abort.signal.aborted && !stream.aborted) {
        const heartbeatRemaining = Math.max(
          1,
          settings.heartbeatIntervalMs - (Date.now() - state.lastWriteAt),
        );
        const timeoutMs = Math.min(
          settings.pollIntervalMs,
          heartbeatRemaining,
        );
        await waitForWake(
          settings.source,
          {
            workspaceId: actor.workspaceId,
            afterEventId: state.lastEventId,
            timeoutMs,
          },
          abort.signal,
        );
        if (abort.signal.aborted || stream.aborted) return;
        if (
          !await identityIsStillCurrent(
            dependencies.resolveIdentity,
            request,
            actor,
          )
        ) return;

        const page = await listEvents(
          dependencies.events,
          actor,
          state.cursor,
          settings.pageSize,
        );
        if (
          !await drainDurableEvents(
            stream,
            page,
            actor,
            dependencies,
            settings.pageSize,
            state,
            abort.signal,
            request,
          )
        ) return;

        if (Date.now() - state.lastWriteAt >= settings.heartbeatIntervalMs) {
          await stream.write(": heartbeat\n\n");
          state.lastWriteAt = Date.now();
        }
      }
    } catch {
      // The response has started; close without serializing internal failures.
    } finally {
      abort.abort();
    }
  });
  response.headers.set("cache-control", "no-cache, no-transform");
  return response;
}
