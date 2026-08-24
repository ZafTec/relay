import {
  type Attributes,
  type Context,
  context,
  type Meter,
  metrics,
  type ObservableCallback,
  type ObservableGauge,
  type ObservableResult,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import {
  AttributeGuard,
  type AttributeGuardOptions,
  type TelemetryAttributeKey,
  type TelemetryAttributes,
} from "./attributes.ts";
import { type NormalizedErrorType, normalizeError } from "./errors.ts";
import {
  looksLikeRawIdentifier,
  normalizeHttpMethod,
  sanitizeIdentifier,
  sanitizeRouteTemplate,
  sanitizeVersion,
  UNKNOWN_ROUTE,
} from "./redaction.ts";

export const RELAY_METRIC_NAMES = [
  "relay.http.server.request.duration",
  "relay.auth.outcomes",
  "relay.queue.depth",
  "relay.queue.oldest_age",
  "relay.queue.admission_rejections",
  "relay.queue.deferrals",
  "relay.job.attempt.duration",
  "relay.job.attempts",
  "relay.job.retries",
  "relay.job.stalls",
  "relay.job.cancellations",
  "relay.worker.heartbeats",
  "relay.capacity.active",
  "relay.capacity.wait.duration",
  "relay.capacity.rate_denials",
  "relay.provider.operation.duration",
  "relay.provider.outcomes",
  "relay.provider.cooldown",
  "relay.storage.operation.duration",
  "relay.storage.bytes",
  "relay.artifact.outcomes",
  "relay.usage.reservation.outcomes",
  "relay.usage.settlement.lag",
  "relay.sse.connections",
  "relay.sse.reconnects",
  "relay.outbox.pending",
  "relay.outbox.oldest_age",
] as const;

export type RelayMetricName = typeof RELAY_METRIC_NAMES[number];
export type RelayMetricInstrumentKind =
  | "counter"
  | "histogram"
  | "observable_gauge"
  | "up_down_counter";

interface RelayMetricDefinition {
  readonly kind: RelayMetricInstrumentKind;
  readonly description: string;
  readonly unit: string;
  readonly attributeKeys: readonly TelemetryAttributeKey[];
  readonly explicitBucketBoundaries?: readonly number[];
}

const REQUEST_DURATION_BOUNDARIES = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.075,
  0.1,
  0.25,
  0.5,
  0.75,
  1,
  2.5,
  5,
  7.5,
  10,
] as const;
const OPERATION_DURATION_BOUNDARIES = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  30,
  60,
] as const;
const WORK_DURATION_BOUNDARIES = [
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  30,
  60,
  120,
  300,
  600,
  1_800,
] as const;

const RELAY_METRICS = {
  "relay.http.server.request.duration": {
    kind: "histogram",
    description: "Relay HTTP response-header duration",
    unit: "s",
    explicitBucketBoundaries: REQUEST_DURATION_BOUNDARIES,
    attributeKeys: [
      "http.route",
      "http.request.method",
      "http.response.status_class",
      "error.type",
    ],
  },
  "relay.auth.outcomes": {
    kind: "counter",
    description: "Relay authentication and authorization outcomes",
    unit: "{outcome}",
    attributeKeys: ["operation", "outcome", "error.type"],
  },
  "relay.queue.depth": {
    kind: "observable_gauge",
    description: "Current Relay queue depth",
    unit: "{job}",
    attributeKeys: ["queue.name", "job.state"],
  },
  "relay.queue.oldest_age": {
    kind: "observable_gauge",
    description: "Age of the oldest queued Relay job",
    unit: "s",
    attributeKeys: ["queue.name"],
  },
  "relay.queue.admission_rejections": {
    kind: "counter",
    description: "Relay queue admission rejections",
    unit: "{rejection}",
    attributeKeys: ["queue.name", "queue.reason", "scheduling.class"],
  },
  "relay.queue.deferrals": {
    kind: "counter",
    description: "Relay queue deferrals",
    unit: "{deferral}",
    attributeKeys: ["queue.name", "queue.reason", "scheduling.class"],
  },
  "relay.job.attempt.duration": {
    kind: "histogram",
    description: "Relay job attempt duration",
    unit: "s",
    explicitBucketBoundaries: WORK_DURATION_BOUNDARIES,
    attributeKeys: [
      "queue.name",
      "job.handler",
      "outcome",
      "error.type",
    ],
  },
  "relay.job.attempts": {
    kind: "counter",
    description: "Relay job attempts",
    unit: "{attempt}",
    attributeKeys: [
      "queue.name",
      "job.handler",
      "outcome",
      "error.type",
    ],
  },
  "relay.job.retries": {
    kind: "counter",
    description: "Relay job retries",
    unit: "{retry}",
    attributeKeys: [
      "queue.name",
      "job.handler",
      "queue.reason",
      "error.type",
    ],
  },
  "relay.job.stalls": {
    kind: "counter",
    description: "Relay job stalls",
    unit: "{stall}",
    attributeKeys: ["queue.name", "job.handler"],
  },
  "relay.job.cancellations": {
    kind: "counter",
    description: "Relay job cancellations",
    unit: "{cancellation}",
    attributeKeys: ["queue.name", "job.handler", "outcome"],
  },
  "relay.worker.heartbeats": {
    kind: "counter",
    description: "Relay worker heartbeat events",
    unit: "{heartbeat}",
    attributeKeys: [],
  },
  "relay.capacity.active": {
    kind: "up_down_counter",
    description: "Active Relay capacity permits",
    unit: "{permit}",
    attributeKeys: ["scheduling.class"],
  },
  "relay.capacity.wait.duration": {
    kind: "histogram",
    description: "Relay capacity wait duration",
    unit: "s",
    explicitBucketBoundaries: WORK_DURATION_BOUNDARIES,
    attributeKeys: ["scheduling.class", "outcome", "queue.reason"],
  },
  "relay.capacity.rate_denials": {
    kind: "counter",
    description: "Relay capacity rate denials",
    unit: "{denial}",
    attributeKeys: ["scheduling.class", "queue.reason", "provider"],
  },
  "relay.provider.operation.duration": {
    kind: "histogram",
    description: "Relay provider operation duration",
    unit: "s",
    explicitBucketBoundaries: WORK_DURATION_BOUNDARIES,
    attributeKeys: [
      "provider",
      "model",
      "operation",
      "outcome",
      "error.type",
      "tool.key",
      "tool.version",
    ],
  },
  "relay.provider.outcomes": {
    kind: "counter",
    description: "Relay provider operation outcomes",
    unit: "{outcome}",
    attributeKeys: [
      "provider",
      "model",
      "operation",
      "outcome",
      "error.type",
      "tool.key",
      "tool.version",
    ],
  },
  "relay.provider.cooldown": {
    kind: "observable_gauge",
    description: "Remaining Relay provider cooldown",
    unit: "s",
    attributeKeys: ["provider", "model"],
  },
  "relay.storage.operation.duration": {
    kind: "histogram",
    description: "Relay storage operation duration",
    unit: "s",
    explicitBucketBoundaries: OPERATION_DURATION_BOUNDARIES,
    attributeKeys: ["storage.system", "operation", "outcome", "error.type"],
  },
  "relay.storage.bytes": {
    kind: "counter",
    description: "Relay storage bytes transferred",
    unit: "By",
    attributeKeys: ["storage.system", "operation", "outcome"],
  },
  "relay.artifact.outcomes": {
    kind: "counter",
    description: "Relay artifact operation outcomes",
    unit: "{outcome}",
    attributeKeys: ["operation", "outcome", "error.type"],
  },
  "relay.usage.reservation.outcomes": {
    kind: "counter",
    description: "Relay usage reservation outcomes",
    unit: "{outcome}",
    attributeKeys: ["operation", "outcome", "queue.reason", "error.type"],
  },
  "relay.usage.settlement.lag": {
    kind: "observable_gauge",
    description: "Relay usage settlement lag",
    unit: "s",
    attributeKeys: ["operation"],
  },
  "relay.sse.connections": {
    kind: "up_down_counter",
    description: "Active Relay SSE connections",
    unit: "{connection}",
    attributeKeys: ["http.route"],
  },
  "relay.sse.reconnects": {
    kind: "counter",
    description: "Relay SSE reconnects",
    unit: "{reconnect}",
    attributeKeys: ["http.route", "outcome"],
  },
  "relay.outbox.pending": {
    kind: "observable_gauge",
    description: "Pending Relay outbox events",
    unit: "{event}",
    attributeKeys: ["operation"],
  },
  "relay.outbox.oldest_age": {
    kind: "observable_gauge",
    description: "Age of the oldest pending Relay outbox event",
    unit: "s",
    attributeKeys: ["operation"],
  },
} as const satisfies Readonly<Record<RelayMetricName, RelayMetricDefinition>>;

type RelayMetricNameFor<K extends RelayMetricInstrumentKind> = {
  [Name in RelayMetricName]: (typeof RELAY_METRICS)[Name]["kind"] extends K
    ? Name
    : never;
}[RelayMetricName];

export type RelayCounterMetricName = RelayMetricNameFor<"counter">;
export type RelayHistogramMetricName = RelayMetricNameFor<"histogram">;
export type RelayObservableGaugeMetricName = RelayMetricNameFor<
  "observable_gauge"
>;
export type RelayUpDownCounterMetricName = RelayMetricNameFor<
  "up_down_counter"
>;

export type RelaySpanKind =
  | "client"
  | "consumer"
  | "internal"
  | "producer"
  | "server";

export interface RelaySpanOptions {
  readonly kind?: RelaySpanKind;
  readonly attributes?: TelemetryAttributes;
  /** Use the context returned by extractTraceContext for queue consumers. */
  readonly parentContext?: Context;
}

export interface SafeCounter {
  add(value: number, attributes?: TelemetryAttributes): void;
}

export interface SafeHistogram {
  record(value: number, attributes?: TelemetryAttributes): void;
}

export interface SafeUpDownCounter {
  add(value: number, attributes?: TelemetryAttributes): void;
}

export interface SafeSpan {
  setAttributes(attributes: TelemetryAttributes): void;
  addEvent(name: string, attributes?: TelemetryAttributes): void;
}

export interface ObservableGaugeRegistration {
  dispose(): void;
}

export type GaugeObserver = (
  observe: (value: number, attributes?: TelemetryAttributes) => void,
) => void;

export interface ActiveSpanEnrichment {
  readonly name?: string;
  readonly attributes?: TelemetryAttributes;
  readonly markError?: boolean;
  /** When present, add a sanitized exception event as well as ERROR status. */
  readonly error?: unknown;
  readonly errorType?: NormalizedErrorType;
}

export interface TelemetryDependencies {
  /** Test seam only. Production should use Deno's installed global provider. */
  readonly tracer?: Tracer | null;
  /** Test seam only. Production should use Deno's installed global provider. */
  readonly meter?: Meter | null;
}

export interface RelayTelemetryOptions {
  readonly instrumentationName?: string;
  readonly instrumentationVersion?: string;
  readonly attributes?: AttributeGuardOptions;
  /** Maximum distinct sanitized attribute sets retained by each metric. */
  readonly maxMetricAttributeSets?: number;
  readonly dependencies?: TelemetryDependencies;
}

const NOOP_COUNTER: SafeCounter = { add() {} };
const NOOP_HISTOGRAM: SafeHistogram = { record() {} };
const NOOP_UP_DOWN_COUNTER: SafeUpDownCounter = { add() {} };
const NOOP_REGISTRATION: ObservableGaugeRegistration = { dispose() {} };
const METRIC_NAME_SET = new Set<string>(RELAY_METRIC_NAMES);
const DEFAULT_MAX_METRIC_ATTRIBUTE_SETS = 256;
const MAX_SPAN_NAMES = 128;

function spanKind(kind: RelaySpanKind | undefined): SpanKind {
  switch (kind) {
    case "client":
      return SpanKind.CLIENT;
    case "consumer":
      return SpanKind.CONSUMER;
    case "producer":
      return SpanKind.PRODUCER;
    case "server":
      return SpanKind.SERVER;
    default:
      return SpanKind.INTERNAL;
  }
}

function metricOptions(name: RelayMetricName): {
  readonly description: string;
  readonly unit: string;
  readonly advice?: { readonly explicitBucketBoundaries: number[] };
} {
  const definition = RELAY_METRICS[name];
  return {
    description: definition.description,
    unit: definition.unit,
    ...(definition.kind === "histogram"
      ? {
        advice: {
          explicitBucketBoundaries: [
            ...definition.explicitBucketBoundaries,
          ],
        },
      }
      : {}),
  };
}

function isMetricName(value: string): value is RelayMetricName {
  return METRIC_NAME_SET.has(value);
}

function hasMetricKind(
  name: string,
  kind: RelayMetricInstrumentKind,
): name is RelayMetricName {
  return isMetricName(name) && RELAY_METRICS[name].kind === kind;
}

function metricAttributeSetLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_METRIC_ATTRIBUTE_SETS;
  if (!Number.isInteger(limit) || limit < 1 || limit > 4_096) {
    throw new TypeError(
      "maxMetricAttributeSets must be an integer between 1 and 4096",
    );
  }
  return limit;
}

function safeInstrumentationName(value: string | undefined): string {
  const normalized = sanitizeIdentifier(value ?? "relay.observability", 96);
  if (normalized === null) {
    throw new TypeError(
      "instrumentationName must be a bounded static identifier",
    );
  }
  return normalized;
}

function safeSpanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const routeSpan = /^([A-Za-z_]+) (\/.*)$/.exec(value);
  if (routeSpan !== null) {
    const method = normalizeHttpMethod(routeSpan[1]);
    const route = sanitizeRouteTemplate(routeSpan[2]);
    if (route !== UNKNOWN_ROUTE || routeSpan[2] === UNKNOWN_ROUTE) {
      return `${method === "_OTHER" ? "HTTP" : method} ${route}`;
    }
    return null;
  }

  const normalized = sanitizeIdentifier(value, 96);
  if (
    normalized === null ||
    !/^[a-z][a-z0-9]*(?:[._-][a-z][a-z0-9]*)*$/.test(normalized)
  ) {
    return null;
  }
  const segments = normalized.split(/[._-]/);
  return segments.some(looksLikeRawIdentifier) ? null : normalized;
}

function safeEventName(value: unknown): string {
  return safeSpanName(value) ?? "relay.event";
}

function markSpanError(
  span: Span,
  error: unknown,
  type?: NormalizedErrorType,
  recordException = true,
): void {
  const normalized = normalizeError(error, { type });
  try {
    span.setStatus(
      recordException
        ? { code: SpanStatusCode.ERROR, message: normalized.message }
        : { code: SpanStatusCode.ERROR },
    );
  } catch {
    // Telemetry providers are not allowed to fail business operations.
  }
  if (!recordException) return;

  try {
    span.addEvent("exception", {
      "exception.type": normalized.type,
      "exception.message": normalized.message,
    });
  } catch {
    // Deliberately omit recordException: it captures raw messages and stacks.
  }
}

class MetricAttributeSetGuard {
  readonly #seen = new Map<RelayMetricName, Set<string>>();

  constructor(
    private readonly guard: AttributeGuard,
    private readonly maximum: number,
  ) {}

  admit(
    name: RelayMetricName,
    attributes: TelemetryAttributes,
  ): Attributes | null {
    const sanitized = this.guard.sanitize(attributes);
    const admitted: Attributes = {};
    for (const key of RELAY_METRICS[name].attributeKeys) {
      const value = sanitized[key];
      if (value !== undefined) admitted[key] = value;
    }

    const fingerprint = JSON.stringify(admitted);
    let seen = this.#seen.get(name);
    if (seen === undefined) {
      seen = new Set<string>();
      this.#seen.set(name, seen);
    }
    if (seen.has(fingerprint)) return admitted;
    if (seen.size >= this.maximum) return null;
    seen.add(fingerprint);
    return admitted;
  }
}

class SafeSpanHandle implements SafeSpan {
  constructor(
    private readonly span: Span | undefined,
    private readonly guard: AttributeGuard,
  ) {}

  setAttributes(attributes: TelemetryAttributes): void {
    if (this.span === undefined) return;
    try {
      this.span.setAttributes(this.guard.sanitize(attributes));
    } catch {
      // A telemetry provider failure must be invisible to business work.
    }
  }

  addEvent(name: string, attributes: TelemetryAttributes = {}): void {
    if (this.span === undefined) return;
    try {
      this.span.addEvent(safeEventName(name), this.guard.sanitize(attributes));
    } catch {
      // A telemetry provider failure must be invisible to business work.
    }
  }
}

/**
 * API-only facade over the provider installed by Deno native OpenTelemetry.
 * This module never initializes an SDK, provider, processor, or exporter.
 */
export class RelayTelemetry {
  readonly #tracer: Tracer | undefined;
  readonly #meter: Meter | undefined;
  readonly #guard: AttributeGuard;
  readonly #metricAttributes: MetricAttributeSetGuard;
  readonly #spanNames = new Set<string>();
  readonly #counters = new Map<RelayMetricName, SafeCounter>();
  readonly #histograms = new Map<RelayMetricName, SafeHistogram>();
  readonly #upDownCounters = new Map<RelayMetricName, SafeUpDownCounter>();

  constructor(options: RelayTelemetryOptions = {}) {
    const name = safeInstrumentationName(options.instrumentationName);
    const version = options.instrumentationVersion === undefined
      ? undefined
      : sanitizeVersion(options.instrumentationVersion) ?? undefined;
    this.#guard = new AttributeGuard(options.attributes);
    this.#metricAttributes = new MetricAttributeSetGuard(
      this.#guard,
      metricAttributeSetLimit(options.maxMetricAttributeSets),
    );

    if (options.dependencies && "tracer" in options.dependencies) {
      this.#tracer = options.dependencies.tracer ?? undefined;
    } else {
      try {
        this.#tracer = trace.getTracer(name, version);
      } catch {
        this.#tracer = undefined;
      }
    }
    if (options.dependencies && "meter" in options.dependencies) {
      this.#meter = options.dependencies.meter ?? undefined;
    } else {
      try {
        this.#meter = metrics.getMeter(name, version);
      } catch {
        this.#meter = undefined;
      }
    }
  }

  sanitizeAttributes(
    attributes: TelemetryAttributes,
  ): Readonly<Record<string, unknown>> {
    try {
      return this.#guard.sanitize(attributes);
    } catch {
      return {};
    }
  }

  async withSpan<T>(
    name: string,
    options: RelaySpanOptions,
    work: (span: SafeSpan) => T | Promise<T>,
  ): Promise<T> {
    const normalizedName = this.#admitSpanName(name);
    const parentContext = options.parentContext ??
      (options.kind === "consumer" ? ROOT_CONTEXT : undefined);
    let span: Span | undefined;
    try {
      span = this.#tracer?.startSpan(
        normalizedName,
        {
          kind: spanKind(options.kind),
          attributes: this.#guard.sanitize(options.attributes),
        },
        parentContext,
      );
    } catch {
      span = undefined;
    }

    const handle = new SafeSpanHandle(span, this.#guard);
    let invoked = false;
    let workPromise: Promise<T> | undefined;
    const invokeOnce = (): Promise<T> => {
      if (!invoked) {
        invoked = true;
        workPromise = Promise.resolve().then(() => work(handle));
      }
      return workPromise!;
    };

    let execution: Promise<T>;
    if (span === undefined) {
      execution = invokeOnce();
    } else {
      try {
        const parent = parentContext ?? context.active();
        const active = trace.setSpan(parent, span);
        execution = Promise.resolve(context.with(active, invokeOnce));
      } catch {
        execution = invokeOnce();
      }
    }

    try {
      return await execution;
    } catch (error) {
      if (span !== undefined) markSpanError(span, error);
      throw error;
    } finally {
      if (span !== undefined) {
        try {
          span.end();
        } catch {
          // Export/provider failures never replace a business result.
        }
      }
    }
  }

  enrichActiveSpan(enrichment: ActiveSpanEnrichment): void {
    let span: Span | undefined;
    try {
      span = trace.getActiveSpan();
    } catch {
      return;
    }
    if (span === undefined) return;

    if (enrichment.name !== undefined) {
      try {
        span.updateName(this.#admitSpanName(enrichment.name));
      } catch {
        // Ignore provider failures and unsafe names.
      }
    }
    if (enrichment.attributes !== undefined) {
      try {
        span.setAttributes(this.#guard.sanitize(enrichment.attributes));
      } catch {
        // Ignore provider failures and malformed runtime input.
      }
    }
    if (enrichment.markError === true) {
      let recordException = false;
      try {
        recordException = Object.prototype.hasOwnProperty.call(
          enrichment,
          "error",
        );
      } catch {
        recordException = false;
      }
      let error: unknown;
      let errorType: NormalizedErrorType | undefined;
      try {
        error = enrichment.error;
        errorType = enrichment.errorType;
      } catch {
        error = undefined;
        errorType = undefined;
        recordException = false;
      }
      try {
        markSpanError(span, error, errorType, recordException);
      } catch {
        // Malformed enrichment must not affect the active business operation.
      }
    }
  }

  counter(name: RelayCounterMetricName): SafeCounter {
    if (!hasMetricKind(name, "counter")) return NOOP_COUNTER;
    const cached = this.#counters.get(name);
    if (cached !== undefined) return cached;

    let instrument: ReturnType<Meter["createCounter"]> | undefined;
    try {
      instrument = this.#meter?.createCounter(name, metricOptions(name));
    } catch {
      instrument = undefined;
    }
    const safe: SafeCounter = {
      add: (value, attributes = {}) => {
        if (!Number.isFinite(value) || value < 0 || instrument === undefined) {
          return;
        }
        try {
          const admitted = this.#metricAttributes.admit(name, attributes);
          if (admitted !== null) instrument.add(value, admitted);
        } catch {
          // Drop telemetry instead of affecting the caller.
        }
      },
    };
    this.#counters.set(name, safe);
    return safe;
  }

  histogram(name: RelayHistogramMetricName): SafeHistogram {
    if (!hasMetricKind(name, "histogram")) return NOOP_HISTOGRAM;
    const cached = this.#histograms.get(name);
    if (cached !== undefined) return cached;

    let instrument: ReturnType<Meter["createHistogram"]> | undefined;
    try {
      instrument = this.#meter?.createHistogram(name, metricOptions(name));
    } catch {
      instrument = undefined;
    }
    const safe: SafeHistogram = {
      record: (value, attributes = {}) => {
        if (!Number.isFinite(value) || value < 0 || instrument === undefined) {
          return;
        }
        try {
          const admitted = this.#metricAttributes.admit(name, attributes);
          if (admitted !== null) instrument.record(value, admitted);
        } catch {
          // Drop telemetry instead of affecting the caller.
        }
      },
    };
    this.#histograms.set(name, safe);
    return safe;
  }

  upDownCounter(name: RelayUpDownCounterMetricName): SafeUpDownCounter {
    if (!hasMetricKind(name, "up_down_counter")) {
      return NOOP_UP_DOWN_COUNTER;
    }
    const cached = this.#upDownCounters.get(name);
    if (cached !== undefined) return cached;

    let instrument: ReturnType<Meter["createUpDownCounter"]> | undefined;
    try {
      instrument = this.#meter?.createUpDownCounter(
        name,
        metricOptions(name),
      );
    } catch {
      instrument = undefined;
    }
    const safe: SafeUpDownCounter = {
      add: (value, attributes = {}) => {
        if (!Number.isFinite(value) || instrument === undefined) return;
        try {
          const admitted = this.#metricAttributes.admit(name, attributes);
          if (admitted !== null) instrument.add(value, admitted);
        } catch {
          // Drop telemetry instead of affecting the caller.
        }
      },
    };
    this.#upDownCounters.set(name, safe);
    return safe;
  }

  observableGauge(
    name: RelayObservableGaugeMetricName,
    observer: GaugeObserver,
  ): ObservableGaugeRegistration {
    if (
      !hasMetricKind(name, "observable_gauge") || this.#meter === undefined
    ) {
      return NOOP_REGISTRATION;
    }

    let gauge: ObservableGauge;
    try {
      gauge = this.#meter.createObservableGauge(name, metricOptions(name));
    } catch {
      return NOOP_REGISTRATION;
    }

    const callback: ObservableCallback = (result: ObservableResult) => {
      try {
        observer((value, attributes = {}) => {
          if (!Number.isFinite(value)) return;
          try {
            const admitted = this.#metricAttributes.admit(name, attributes);
            if (admitted !== null) result.observe(value, admitted);
          } catch {
            // One bad observation must not abort collection of other signals.
          }
        });
      } catch {
        // Observable callbacks run in the telemetry collection path; drop errors.
      }
    };

    try {
      gauge.addCallback(callback);
    } catch {
      return NOOP_REGISTRATION;
    }
    return {
      dispose: () => {
        try {
          gauge.removeCallback(callback);
        } catch {
          // Shutdown cleanup remains best effort.
        }
      },
    };
  }

  #admitSpanName(value: string): string {
    const normalized = safeSpanName(value);
    if (normalized === null) return "relay.operation";
    if (this.#spanNames.has(normalized)) return normalized;
    if (this.#spanNames.size >= MAX_SPAN_NAMES) return "relay.operation";
    this.#spanNames.add(normalized);
    return normalized;
  }
}

export function createRelayTelemetry(
  options: RelayTelemetryOptions = {},
): RelayTelemetry {
  return new RelayTelemetry(options);
}
