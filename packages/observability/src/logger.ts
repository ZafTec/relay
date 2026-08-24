import { isSpanContextValid, trace } from "@opentelemetry/api";
import { AttributeGuard, type AttributeGuardOptions } from "./attributes.ts";
import { type NormalizedErrorType, normalizeError } from "./errors.ts";
import { sanitizeIdentifier, sanitizeTelemetryText } from "./redaction.ts";

export const LOG_SEVERITIES = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
export type LogSeverity = typeof LOG_SEVERITIES[number];

export interface LogEvent {
  readonly eventName: string;
  readonly severity: LogSeverity;
  /** Must be a static operational description, never an Error.message. */
  readonly message: string;
  readonly operation?: string;
  readonly outcome?: string;
  readonly error?: unknown;
  readonly errorType?: NormalizedErrorType;
  readonly httpRoute?: string;
  readonly toolKey?: string;
  readonly toolVersion?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly attemptNumber?: number;
  readonly queueReason?: string;
  /** Structured metadata only; provisioning must never promote this to a label. */
  readonly requestId?: string;
}

export interface LogRecord {
  readonly "schema.version": 1;
  readonly timestamp: string;
  readonly "event.name": string;
  readonly severity: LogSeverity;
  readonly message: string;
  readonly operation: string | null;
  readonly outcome: string | null;
  readonly "error.type": NormalizedErrorType | null;
  readonly "http.route": string | null;
  readonly "tool.key": string | null;
  readonly "tool.version": string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly "attempt.number": number | null;
  readonly "queue.reason": string | null;
  readonly "request.id": string | null;
  readonly trace_id: string | null;
  readonly span_id: string | null;
}

export interface LogSink {
  write(line: string, severity: LogSeverity): void;
}

export interface LoggerOptions {
  readonly sink?: LogSink;
  readonly now?: () => Date;
  readonly attributes?: AttributeGuardOptions;
  readonly traceContext?: () => {
    readonly traceId: string | null;
    readonly spanId: string | null;
  };
}

const MAX_EVENT_NAMES = 128;

const consoleSink: LogSink = {
  write(line, severity) {
    switch (severity) {
      case "DEBUG":
        console.debug(line);
        break;
      case "WARN":
        console.warn(line);
        break;
      case "ERROR":
        console.error(line);
        break;
      default:
        console.info(line);
    }
  },
};

function activeTraceContext(): {
  traceId: string | null;
  spanId: string | null;
} {
  try {
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (spanContext === undefined || !isSpanContextValid(spanContext)) {
      return { traceId: null, spanId: null };
    }
    return { traceId: spanContext.traceId, spanId: spanContext.spanId };
  } catch {
    return { traceId: null, spanId: null };
  }
}

function correlationId(value: unknown): string | null {
  const normalized = sanitizeIdentifier(value, 128);
  return normalized !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
    ? normalized
    : null;
}

function value(
  attributes: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const candidate = attributes[key];
  return typeof candidate === "string" ? candidate : null;
}

/** Emits one fixed-schema JSON object to console for Deno OTel log capture. */
export class JsonLogger {
  readonly #sink: LogSink;
  readonly #now: () => Date;
  readonly #guard: AttributeGuard;
  readonly #traceContext: NonNullable<LoggerOptions["traceContext"]>;
  readonly #eventNames = new Set<string>();

  constructor(options: LoggerOptions = {}) {
    this.#sink = options.sink ?? consoleSink;
    this.#now = options.now ?? (() => new Date());
    this.#guard = new AttributeGuard(options.attributes);
    this.#traceContext = options.traceContext ?? activeTraceContext;
  }

  log(event: LogEvent): LogRecord {
    return this.#emit(event);
  }

  debug(event: Omit<LogEvent, "severity">): LogRecord {
    return this.#emit(event, "DEBUG");
  }

  info(event: Omit<LogEvent, "severity">): LogRecord {
    return this.#emit(event, "INFO");
  }

  warn(event: Omit<LogEvent, "severity">): LogRecord {
    return this.#emit(event, "WARN");
  }

  error(event: Omit<LogEvent, "severity">): LogRecord {
    return this.#emit(event, "ERROR");
  }

  #emit(
    event: LogEvent | Omit<LogEvent, "severity">,
    forcedSeverity?: LogSeverity,
  ): LogRecord {
    let record: LogRecord;
    try {
      record = this.#createRecord(event as LogEvent, forcedSeverity);
    } catch {
      record = this.#fallbackRecord(forcedSeverity);
    }

    try {
      this.#sink.write(JSON.stringify(record), record.severity);
    } catch {
      // Logging is telemetry and must not fail the caller.
    }
    return record;
  }

  #createRecord(event: LogEvent, forcedSeverity?: LogSeverity): LogRecord {
    const hasError = Object.prototype.hasOwnProperty.call(event, "error") ||
      event.errorType !== undefined;
    const normalizedError = hasError
      ? normalizeError(event.error, { type: event.errorType })
      : null;
    const attributes = this.#safeAttributes({
      operation: event.operation,
      outcome: event.outcome,
      "error.type": normalizedError?.type,
      "http.route": event.httpRoute,
      "tool.key": event.toolKey,
      "tool.version": event.toolVersion,
      provider: event.provider,
      model: event.model,
      "attempt.number": event.attemptNumber,
      "queue.reason": event.queueReason,
    });
    const traceContext = this.#safeTraceContext();
    const requestedSeverity = forcedSeverity ?? event.severity;
    return {
      "schema.version": 1,
      timestamp: this.#safeTimestamp(),
      "event.name": this.#eventName(event.eventName),
      severity: (LOG_SEVERITIES as readonly string[]).includes(
          requestedSeverity,
        )
        ? requestedSeverity
        : "INFO",
      message: normalizedError?.message ?? sanitizeTelemetryText(event.message),
      operation: value(attributes, "operation"),
      outcome: value(attributes, "outcome"),
      "error.type": normalizedError?.type ?? null,
      "http.route": value(attributes, "http.route"),
      "tool.key": value(attributes, "tool.key"),
      "tool.version": value(attributes, "tool.version"),
      provider: value(attributes, "provider"),
      model: value(attributes, "model"),
      "attempt.number": typeof attributes["attempt.number"] === "number"
        ? attributes["attempt.number"] as number
        : null,
      "queue.reason": value(attributes, "queue.reason"),
      "request.id": correlationId(event.requestId),
      trace_id: traceContext.traceId,
      span_id: traceContext.spanId,
    };
  }

  #fallbackRecord(forcedSeverity?: LogSeverity): LogRecord {
    const traceContext = this.#safeTraceContext();
    return {
      "schema.version": 1,
      timestamp: this.#safeTimestamp(),
      "event.name": "relay.invalid_event",
      severity: forcedSeverity ?? "INFO",
      message: "Invalid log event",
      operation: null,
      outcome: null,
      "error.type": null,
      "http.route": null,
      "tool.key": null,
      "tool.version": null,
      provider: null,
      model: null,
      "attempt.number": null,
      "queue.reason": null,
      "request.id": null,
      trace_id: traceContext.traceId,
      span_id: traceContext.spanId,
    };
  }

  #eventName(raw: unknown): string {
    const normalized = sanitizeIdentifier(raw, 96);
    if (
      normalized === null ||
      !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized)
    ) {
      return "relay.invalid_event";
    }
    if (this.#eventNames.has(normalized)) return normalized;
    if (this.#eventNames.size >= MAX_EVENT_NAMES) return "relay.event_overflow";
    this.#eventNames.add(normalized);
    return normalized;
  }

  #safeAttributes(
    attributes: Record<string, unknown>,
  ): Readonly<Record<string, unknown>> {
    try {
      return this.#guard.sanitize(attributes);
    } catch {
      return {};
    }
  }

  #safeTimestamp(): string {
    try {
      const date = this.#now();
      return Number.isFinite(date.getTime())
        ? date.toISOString()
        : "1970-01-01T00:00:00.000Z";
    } catch {
      return "1970-01-01T00:00:00.000Z";
    }
  }

  #safeTraceContext(): { traceId: string | null; spanId: string | null } {
    try {
      const current = this.#traceContext();
      return {
        traceId: /^[0-9a-f]{32}$/.test(current.traceId ?? "")
          ? current.traceId
          : null,
        spanId: /^[0-9a-f]{16}$/.test(current.spanId ?? "")
          ? current.spanId
          : null,
      };
    } catch {
      return { traceId: null, spanId: null };
    }
  }
}

export function createJsonLogger(options: LoggerOptions = {}): JsonLogger {
  return new JsonLogger(options);
}
