import { RUN_STATUSES, type RunStatus } from "../api/runs";

export const WORKSPACE_EVENT_TYPES = [
  "run.created",
  "run.status_changed",
  "run.progress_changed",
  "run.completed",
  "artifact.created",
  "share_link.changed",
  "usage.changed",
  "tool.availability_changed",
  "session.permission_changed",
] as const;

export type WorkspaceEventType = typeof WORKSPACE_EVENT_TYPES[number];

export type WorkspaceEventData =
  | { readonly type: "run.created" | "run.progress_changed"; readonly runId: string }
  | {
      readonly type: "run.status_changed" | "run.completed";
      readonly runId: string;
      readonly status: RunStatus;
    }
  | {
      readonly type: "artifact.created";
      readonly artifactId: string;
      readonly runId: string | null;
    }
  | {
      readonly type: "share_link.changed";
      readonly shareLinkId: string;
      readonly artifactId: string;
    }
  | { readonly type: "usage.changed"; readonly metric: string | null }
  | { readonly type: "tool.availability_changed"; readonly toolKey: string }
  | {
      readonly type: "session.permission_changed";
      readonly reason: "membership_changed" | "role_changed";
    };

export interface WorkspaceEventEnvelope {
  readonly id: string;
  readonly workspaceId: string;
  readonly occurredAt: string;
  readonly event: WorkspaceEventData;
}

export interface ResynchronizedEvent {
  readonly lastEventId: string | null;
}

export type WorkspaceEventConnectionState =
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | { readonly kind: "reconnecting"; readonly attempt: number }
  | { readonly kind: "stale" }
  | { readonly kind: "offline" }
  | { readonly kind: "resynchronized" }
  | {
      readonly kind: "permission_changed";
      readonly reason: "membership_changed" | "role_changed";
    };

export interface WorkspaceEventSourceHandlers {
  readonly onState: (state: WorkspaceEventConnectionState) => void;
  readonly onEvent: (event: WorkspaceEventEnvelope) => void;
  readonly onResynchronized: (event: ResynchronizedEvent) => void;
  readonly onAuthExpired: () => void;
  readonly onAccessUnavailable: () => void;
}

export interface WorkspaceEventSourceRequest {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly handlers: WorkspaceEventSourceHandlers;
}

export interface WorkspaceEventConnection {
  close(): void;
  reconnect(): void;
}

export type WorkspaceEventSourceFactory = (
  request: WorkspaceEventSourceRequest,
) => WorkspaceEventConnection;

export interface FetchWorkspaceEventSourceOptions {
  readonly fetcher?: typeof fetch;
  readonly reconnectDelayMs?: number;
  readonly staleAfterMs?: number;
}

export class InvalidWorkspaceEventError extends TypeError {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "InvalidWorkspaceEventError";
  }
}

const EVENTS_PATH = "/api/v1/events";
const RUN_ID_PATTERN = /^run_[0-9a-f]{32}$/;
const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{32}$/;
const SHARE_LINK_ID_PATTERN = /^share_[0-9a-f]{32}$/;
const TOOL_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const EVENT_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_STALE_AFTER_MS = 45_000;
const MAX_SSE_BUFFER_BYTES = 1_048_576;

function invalid(path: string, message: string): never {
  throw new InvalidWorkspaceEventError(path, message);
}

function strictObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(path, "must be an object");
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, "is not supported");
  }
  return value as Record<string, unknown>;
}

function required(
  object: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  if (!Object.hasOwn(object, key)) invalid(`${path}.${key}`, "is required");
  return object[key];
}

function stringValue(
  value: unknown,
  path: string,
  options: {
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: RegExp;
  } = {},
): string {
  if (typeof value !== "string") return invalid(path, "must be a string");
  if (options.minLength !== undefined && value.length < options.minLength) {
    invalid(path, "is too short");
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    invalid(path, "is too long");
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    invalid(path, "has an invalid format");
  }
  return value;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  path: string,
  values: Values,
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    return invalid(path, `must be one of: ${values.join(", ")}`);
  }
  return value as Values[number];
}

function nullable<T>(
  value: unknown,
  path: string,
  parser: (candidate: unknown, candidatePath: string) => T,
): T | null {
  return value === null ? null : parser(value, path);
}

function identifier(value: unknown, path: string, pattern: RegExp): string {
  return stringValue(value, path, { pattern });
}

function isoTimestamp(value: unknown, path: string): string {
  const parsed = stringValue(value, path, {
    minLength: 24,
    maxLength: 24,
    pattern: ISO_TIMESTAMP_PATTERN,
  });
  if (!Number.isFinite(Date.parse(parsed))) invalid(path, "must be an ISO timestamp");
  return parsed;
}

function eventData(value: unknown, path: string): WorkspaceEventData {
  const broad = strictObject(value, path, [
    "type",
    "runId",
    "status",
    "artifactId",
    "shareLinkId",
    "metric",
    "toolKey",
    "reason",
  ]);
  const type = enumValue(
    required(broad, "type", path),
    `${path}.type`,
    WORKSPACE_EVENT_TYPES,
  );

  switch (type) {
    case "run.created":
    case "run.progress_changed": {
      const object = strictObject(value, path, ["type", "runId"]);
      return {
        type,
        runId: identifier(required(object, "runId", path), `${path}.runId`, RUN_ID_PATTERN),
      };
    }
    case "run.status_changed":
    case "run.completed": {
      const object = strictObject(value, path, ["type", "runId", "status"]);
      return {
        type,
        runId: identifier(required(object, "runId", path), `${path}.runId`, RUN_ID_PATTERN),
        status: enumValue(required(object, "status", path), `${path}.status`, RUN_STATUSES),
      };
    }
    case "artifact.created": {
      const object = strictObject(value, path, ["type", "artifactId", "runId"]);
      return {
        type,
        artifactId: identifier(
          required(object, "artifactId", path),
          `${path}.artifactId`,
          ARTIFACT_ID_PATTERN,
        ),
        runId: nullable(
          required(object, "runId", path),
          `${path}.runId`,
          (item, itemPath) => identifier(item, itemPath, RUN_ID_PATTERN),
        ),
      };
    }
    case "share_link.changed": {
      const object = strictObject(value, path, ["type", "shareLinkId", "artifactId"]);
      return {
        type,
        shareLinkId: identifier(
          required(object, "shareLinkId", path),
          `${path}.shareLinkId`,
          SHARE_LINK_ID_PATTERN,
        ),
        artifactId: identifier(
          required(object, "artifactId", path),
          `${path}.artifactId`,
          ARTIFACT_ID_PATTERN,
        ),
      };
    }
    case "usage.changed": {
      const object = strictObject(value, path, ["type", "metric"]);
      return {
        type,
        metric: nullable(
          required(object, "metric", path),
          `${path}.metric`,
          (item, itemPath) => stringValue(item, itemPath, { pattern: SAFE_CODE_PATTERN }),
        ),
      };
    }
    case "tool.availability_changed": {
      const object = strictObject(value, path, ["type", "toolKey"]);
      return {
        type,
        toolKey: stringValue(required(object, "toolKey", path), `${path}.toolKey`, {
          minLength: 1,
          maxLength: 128,
          pattern: TOOL_KEY_PATTERN,
        }),
      };
    }
    case "session.permission_changed": {
      const object = strictObject(value, path, ["type", "reason"]);
      return {
        type,
        reason: enumValue(
          required(object, "reason", path),
          `${path}.reason`,
          ["membership_changed", "role_changed"] as const,
        ),
      };
    }
  }
}

export function parseWorkspaceEventEnvelope(value: unknown): WorkspaceEventEnvelope {
  const path = "$input";
  const object = strictObject(value, path, ["id", "workspaceId", "occurredAt", "event"]);
  return {
    id: stringValue(required(object, "id", path), `${path}.id`, {
      minLength: 1,
      maxLength: 20,
      pattern: EVENT_ID_PATTERN,
    }),
    workspaceId: stringValue(required(object, "workspaceId", path), `${path}.workspaceId`, {
      minLength: 1,
      maxLength: 255,
    }),
    occurredAt: isoTimestamp(required(object, "occurredAt", path), `${path}.occurredAt`),
    event: eventData(required(object, "event", path), `${path}.event`),
  };
}

export function parseResynchronizedEvent(value: unknown): ResynchronizedEvent {
  const path = "$input";
  const object = strictObject(value, path, ["lastEventId"]);
  return {
    lastEventId: nullable(
      required(object, "lastEventId", path),
      `${path}.lastEventId`,
      (item, itemPath) => stringValue(item, itemPath, {
        minLength: 1,
        maxLength: 20,
        pattern: EVENT_ID_PATTERN,
      }),
    ),
  };
}

function positiveDelay(value: number | undefined, fallback: number, field: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 120_000) {
    throw new TypeError(`${field} must be a positive bounded integer`);
  }
  return selected;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
    || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

interface StreamCallbacks {
  readonly onActivity: () => void;
  readonly onRetry: (milliseconds: number) => void;
  readonly onEvent: (name: string, id: string | null, data: string) => void;
}

async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  callbacks: StreamCallbacks,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let eventName = "";
  let eventId: string | null = null;
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length > 0) {
      callbacks.onEvent(eventName || "message", eventId, dataLines.join("\n"));
    }
    eventName = "";
    eventId = null;
    dataLines = [];
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    callbacks.onActivity();
    if (line.length === 0) {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let fieldValue = separator === -1 ? "" : line.slice(separator + 1);
    if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
    switch (field) {
      case "event":
        eventName = fieldValue;
        break;
      case "data":
        dataLines.push(fieldValue);
        break;
      case "id":
        if (!fieldValue.includes("\u0000")) eventId = fieldValue;
        break;
      case "retry":
        if (/^[0-9]+$/.test(fieldValue)) {
          const parsed = Number(fieldValue);
          if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 60_000) {
            callbacks.onRetry(parsed);
          }
        }
        break;
    }
  };

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (new TextEncoder().encode(buffer).byteLength > MAX_SSE_BUFFER_BYTES) {
        invalid("$stream", "event buffer is too large");
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) processLine(buffer);
    dispatch();
  } finally {
    reader.releaseLock();
  }
}

function parseEventJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return invalid("$stream.data", "must be valid JSON");
  }
}

function connectionStateKey(state: WorkspaceEventConnectionState): string {
  return JSON.stringify(state);
}

export function createFetchWorkspaceEventSourceFactory(
  options: FetchWorkspaceEventSourceOptions = {},
): WorkspaceEventSourceFactory {
  const fetcher = options.fetcher ?? fetch;
  const configuredReconnectDelay = positiveDelay(
    options.reconnectDelayMs,
    DEFAULT_RECONNECT_DELAY_MS,
    "reconnectDelayMs",
  );
  const staleAfterMs = positiveDelay(
    options.staleAfterMs,
    DEFAULT_STALE_AFTER_MS,
    "staleAfterMs",
  );

  return ({ workspaceId, handlers }): WorkspaceEventConnection => {
    if (workspaceId.length === 0 || workspaceId.length > 255) {
      throw new TypeError("workspaceId must be a non-empty bounded string");
    }

    let closed = false;
    let generation = 0;
    let reconnectAttempt = 0;
    let reconnectDelayMs = configuredReconnectDelay;
    let lastEventId: string | null = null;
    let controller: AbortController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let currentStateKey = "";

    const emitState = (state: WorkspaceEventConnectionState) => {
      const key = connectionStateKey(state);
      if (key === currentStateKey) return;
      currentStateKey = key;
      handlers.onState(state);
    };

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const clearStaleTimer = () => {
      if (staleTimer !== null) clearTimeout(staleTimer);
      staleTimer = null;
    };

    const markActivity = () => {
      if (closed) return;
      clearStaleTimer();
      staleTimer = setTimeout(() => {
        if (!closed) emitState({ kind: "stale" });
      }, staleAfterMs);
      if (currentStateKey === connectionStateKey({ kind: "stale" })) {
        emitState({ kind: "connected" });
      }
    };

    const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

    const stopCurrentAttempt = () => {
      generation += 1;
      controller?.abort();
      controller = null;
      clearReconnectTimer();
      clearStaleTimer();
    };

    const removeNetworkListeners = () => {
      if (typeof window === "undefined") return;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };

    const close = () => {
      if (closed) return;
      closed = true;
      stopCurrentAttempt();
      removeNetworkListeners();
    };

    const dispatchEvent = (name: string, id: string | null, data: string) => {
      if (name === "relay.resynchronized") {
        const event = parseResynchronizedEvent(parseEventJson(data));
        if (event.lastEventId !== null) lastEventId = event.lastEventId;
        reconnectAttempt = 0;
        emitState({ kind: "resynchronized" });
        handlers.onResynchronized(event);
        return;
      }
      if (!(WORKSPACE_EVENT_TYPES as readonly string[]).includes(name)) {
        invalid("$stream.event", "is not a supported workspace event");
      }
      const envelope = parseWorkspaceEventEnvelope(parseEventJson(data));
      if (id === null || id !== envelope.id) {
        invalid("$stream.id", "must match the workspace event envelope");
      }
      if (name !== envelope.event.type) {
        invalid("$stream.event", "must match the workspace event envelope");
      }
      if (envelope.workspaceId !== workspaceId) {
        invalid("$stream.workspaceId", "does not match the active workspace");
      }
      lastEventId = envelope.id;
      handlers.onEvent(envelope);
    };

    const scheduleReconnect = (delayMs: number) => {
      if (closed) return;
      stopCurrentAttempt();
      if (!isOnline()) {
        emitState({ kind: "offline" });
        return;
      }
      reconnectAttempt += 1;
      emitState({ kind: "reconnecting", attempt: reconnectAttempt });
      const scheduledGeneration = generation;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (closed || scheduledGeneration !== generation) return;
        void connect(false);
      }, delayMs);
    };

    const connect = async (initial: boolean) => {
      if (closed) return;
      if (!isOnline()) {
        emitState({ kind: "offline" });
        return;
      }
      const attemptGeneration = ++generation;
      controller?.abort();
      const attemptController = new AbortController();
      controller = attemptController;
      if (initial) emitState({ kind: "connecting" });

      try {
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (lastEventId !== null) headers["last-event-id"] = lastEventId;
        const response = await fetcher(EVENTS_PATH, {
          cache: "no-store",
          credentials: "include",
          headers,
          signal: attemptController.signal,
        });
        if (response.status === 401) {
          handlers.onAuthExpired();
          close();
          return;
        }
        if (closed || attemptGeneration !== generation) return;
        if (response.status === 403 || response.status === 404) {
          handlers.onAccessUnavailable();
          close();
          return;
        }
        if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
          throw new TypeError("Relay event stream returned an invalid response");
        }
        if (response.body === null) {
          throw new TypeError("Relay event stream returned no body");
        }

        emitState({ kind: "connected" });
        markActivity();
        await consumeEventStream(response.body, attemptController.signal, {
          onActivity: markActivity,
          onRetry: (milliseconds) => {
            reconnectDelayMs = milliseconds;
          },
          onEvent: dispatchEvent,
        });
        if (!closed && attemptGeneration === generation) {
          scheduleReconnect(reconnectDelayMs);
        }
      } catch (error) {
        if (isAbortError(error) || closed || attemptGeneration !== generation) return;
        scheduleReconnect(reconnectDelayMs);
      } finally {
        if (controller === attemptController) controller = null;
      }
    };

    function handleOffline() {
      if (closed) return;
      stopCurrentAttempt();
      emitState({ kind: "offline" });
    }

    function handleOnline() {
      if (closed) return;
      scheduleReconnect(0);
    }

    if (typeof window !== "undefined") {
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
    }
    void connect(true);

    return {
      close,
      reconnect() {
        if (!closed) scheduleReconnect(0);
      },
    };
  };
}

export const httpWorkspaceEventSourceFactory = createFetchWorkspaceEventSourceFactory();
