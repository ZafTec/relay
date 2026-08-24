import {
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api";

export interface TraceContextCarrier {
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export interface TracePropagationApi {
  inject(
    context: Context,
    carrier: Record<string, string>,
    setter: TextMapSetter<Record<string, string>>,
  ): void;
  extract(
    context: Context,
    carrier: TraceContextCarrier,
    getter: TextMapGetter<TraceContextCarrier>,
  ): Context;
}

const TRACE_CONTEXT_KEYS = new Set(["traceparent", "tracestate"]);
const TRACEPARENT_LIMIT = 512;
const TRACESTATE_LIMIT = 512;
const TRACEPARENT_PATTERN =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)$/;
const SIMPLE_TRACESTATE_KEY = /^[a-z][a-z0-9_*/-]{0,255}$/;
const MULTI_TENANT_TRACESTATE_KEY =
  /^[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13}$/;
const TRACESTATE_VALUE =
  /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

function safeTraceparent(value: unknown): string | undefined {
  if (
    typeof value !== "string" || value.length > TRACEPARENT_LIMIT ||
    /[^\x21-\x7e]/.test(value)
  ) {
    return undefined;
  }
  const match = TRACEPARENT_PATTERN.exec(value);
  if (match === null) return undefined;

  const [, version, traceId, parentId, , suffix] = match;
  if (
    version === "ff" ||
    /^0{32}$/.test(traceId) ||
    /^0{16}$/.test(parentId) ||
    (version === "00"
      ? suffix !== ""
      : suffix !== "" && !suffix.startsWith("-"))
  ) {
    return undefined;
  }
  return value;
}

function safeTracestate(value: unknown): string | undefined {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > TRACESTATE_LIMIT || /[^\x20-\x7e]/.test(value)
  ) {
    return undefined;
  }

  const members = value.split(",");
  if (members.length > 32) return undefined;
  const keys = new Set<string>();
  const normalized: string[] = [];
  for (const rawMember of members) {
    const member = rawMember.trim();
    const separator = member.indexOf("=");
    if (separator <= 0) return undefined;
    const key = member.slice(0, separator);
    const memberValue = member.slice(separator + 1);
    if (
      (!SIMPLE_TRACESTATE_KEY.test(key) &&
        !MULTI_TENANT_TRACESTATE_KEY.test(key)) ||
      !TRACESTATE_VALUE.test(memberValue) || keys.has(key)
    ) {
      return undefined;
    }
    keys.add(key);
    normalized.push(member);
  }
  return normalized.join(",");
}

const setter: TextMapSetter<Record<string, string>> = {
  set(carrier, rawKey, rawValue) {
    const key = rawKey.toLowerCase();
    if (!TRACE_CONTEXT_KEYS.has(key)) return;
    const value = key === "traceparent"
      ? safeTraceparent(rawValue)
      : safeTracestate(rawValue);
    if (value !== undefined) carrier[key] = value;
  },
};

const getter: TextMapGetter<TraceContextCarrier> = {
  keys(carrier) {
    const keys: string[] = [];
    if (carrier.traceparent !== undefined) keys.push("traceparent");
    if (carrier.tracestate !== undefined) keys.push("tracestate");
    return keys;
  },
  get(carrier, rawKey) {
    const key = rawKey.toLowerCase();
    if (key === "traceparent") return carrier.traceparent;
    if (key === "tracestate") return carrier.tracestate;
    return undefined;
  },
};

function readCarrier(input: unknown): TraceContextCarrier {
  if (input === null || typeof input !== "object") return {};

  try {
    const traceparent = input instanceof Headers
      ? safeTraceparent(input.get("traceparent"))
      : Object.prototype.hasOwnProperty.call(input, "traceparent")
      ? safeTraceparent(Reflect.get(input, "traceparent"))
      : undefined;
    if (traceparent === undefined) return {};

    const tracestate = input instanceof Headers
      ? safeTracestate(input.get("tracestate"))
      : Object.prototype.hasOwnProperty.call(input, "tracestate")
      ? safeTracestate(Reflect.get(input, "tracestate"))
      : undefined;
    return {
      traceparent,
      ...(tracestate === undefined ? {} : { tracestate }),
    };
  } catch {
    return {};
  }
}

function activeContext(): Context {
  try {
    return context.active();
  } catch {
    return ROOT_CONTEXT;
  }
}

/**
 * Injects only W3C traceparent/tracestate. Even if a global propagator attempts
 * to write baggage or vendor headers, the setter discards those fields.
 */
export function injectTraceContext(
  source: Context | undefined = undefined,
  propagator: TracePropagationApi = propagation as TextMapPropagator,
): TraceContextCarrier {
  const carrier: Record<string, string> = {};
  try {
    propagator.inject(source ?? activeContext(), carrier, setter);
    return readCarrier(carrier);
  } catch {
    return {};
  }
}

/**
 * Extracts only traceparent/tracestate onto ROOT_CONTEXT. Missing or malformed
 * queue metadata and propagator failures also return ROOT_CONTEXT, preventing an
 * unrelated ambient span from becoming the job's parent.
 */
export function extractTraceContext(
  carrier: unknown,
  propagator: TracePropagationApi = propagation as TextMapPropagator,
): Context {
  const sanitized = readCarrier(carrier);
  if (sanitized.traceparent === undefined) return ROOT_CONTEXT;

  try {
    return propagator.extract(ROOT_CONTEXT, sanitized, getter);
  } catch {
    return ROOT_CONTEXT;
  }
}
