import { type Context, context, ROOT_CONTEXT } from "@opentelemetry/api";
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  extractTraceContext,
  injectTraceContext,
  type TraceContextCarrier,
  type TracePropagationApi,
} from "./context.ts";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

Deno.test("trace injection emits only traceparent and tracestate", () => {
  const propagator: TracePropagationApi = {
    inject(source, carrier, setter) {
      assertStrictEquals(source, context.active());
      setter.set(carrier, "traceparent", traceparent);
      setter.set(carrier, "tracestate", "vendor=value");
      setter.set(carrier, "baggage", "prompt=private-canary");
      setter.set(carrier, "x-vendor-secret", "secret-canary");
    },
    extract(base) {
      return base;
    },
  };

  assertEquals(injectTraceContext(context.active(), propagator), {
    traceparent,
    tracestate: "vendor=value",
  });
});

Deno.test("trace extraction exposes only traceparent and tracestate", () => {
  let observedKeys: readonly string[] = [];
  let observedBaggage: unknown = "not-read";
  const propagator: TracePropagationApi = {
    inject() {},
    extract(source, carrier, getter) {
      assertStrictEquals(source, ROOT_CONTEXT);
      observedKeys = getter.keys(carrier);
      observedBaggage = getter.get(carrier, "baggage");
      assertEquals(getter.get(carrier, "traceparent"), traceparent);
      return source;
    },
  };
  const input = {
    traceparent,
    tracestate: "vendor=value",
    baggage: "prompt=private-canary",
    authorization: "Bearer secret-canary",
  } as TraceContextCarrier & Record<string, string>;

  const extracted = extractTraceContext(input, propagator);
  assertStrictEquals(extracted, ROOT_CONTEXT);
  assertEquals(observedKeys, ["traceparent", "tracestate"]);
  assertEquals(observedBaggage, undefined);
});

Deno.test("trace carriers reject malformed W3C values and standalone tracestate", () => {
  const base = context.active();
  let extractionCalls = 0;
  const propagator: TracePropagationApi = {
    inject(_source, carrier, setter) {
      setter.set(
        carrier,
        "traceparent",
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      );
      setter.set(carrier, "tracestate", "vendor=value");
    },
    extract(source) {
      extractionCalls += 1;
      return source;
    },
  };

  assertEquals(injectTraceContext(base, propagator), {});
  assertStrictEquals(
    extractTraceContext({ tracestate: "vendor=value" }, propagator),
    ROOT_CONTEXT,
  );
  assertStrictEquals(
    extractTraceContext(
      {
        traceparent,
        tracestate: "vendor=one,vendor=two",
      },
      propagator,
    ),
    ROOT_CONTEXT,
  );
  assertEquals(extractionCalls, 1);
});

Deno.test("trace propagation failures degrade to empty or root context", () => {
  const base: Context = context.active();
  const propagator: TracePropagationApi = {
    inject() {
      throw new Error("telemetry failure");
    },
    extract() {
      throw new Error("telemetry failure");
    },
  };
  assertEquals(injectTraceContext(base, propagator), {});
  assertStrictEquals(
    extractTraceContext({ traceparent }, propagator),
    ROOT_CONTEXT,
  );
});
