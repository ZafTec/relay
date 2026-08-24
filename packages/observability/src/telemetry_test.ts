import {
  type Context,
  context,
  type Meter,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { createRelayTelemetry } from "./telemetry.ts";

function fakeSpan(overrides: Record<string, unknown> = {}): Span {
  return {
    setAttribute() {
      return this;
    },
    setAttributes() {
      return this;
    },
    addEvent() {
      return this;
    },
    addLink() {
      return this;
    },
    addLinks() {
      return this;
    },
    setStatus() {
      return this;
    },
    updateName() {
      return this;
    },
    end() {},
    isRecording() {
      return true;
    },
    recordException() {},
    spanContext() {
      return {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: 1,
      };
    },
    ...overrides,
  } as unknown as Span;
}

Deno.test("span creation failure runs business work exactly once", async () => {
  let calls = 0;
  const tracer = {
    startSpan() {
      throw new Error("collector failure");
    },
  } as unknown as Tracer;
  const telemetry = createRelayTelemetry({
    dependencies: { tracer, meter: null },
  });

  const result = await telemetry.withSpan("provider.submit", {}, () => {
    calls += 1;
    return "business-result";
  });
  assertEquals(result, "business-result");
  assertEquals(calls, 1);
});

Deno.test("span method failures never replace a business result", async () => {
  let calls = 0;
  const span = fakeSpan({
    setAttributes() {
      throw new Error("setAttributes failed");
    },
    addEvent() {
      throw new Error("addEvent failed");
    },
    end() {
      throw new Error("end failed");
    },
  });
  const tracer = { startSpan: () => span } as unknown as Tracer;
  const telemetry = createRelayTelemetry({
    dependencies: { tracer, meter: null },
  });

  const result = await telemetry.withSpan("storage.retrieve", {}, (handle) => {
    calls += 1;
    handle.setAttributes({ "storage.system": "s3" });
    handle.addEvent("storage.completed", { outcome: "success" });
    return 7;
  });
  assertEquals(result, 7);
  assertEquals(calls, 1);
});

Deno.test("business errors are preserved while span errors are sanitized", async () => {
  const statuses: unknown[] = [];
  const events: unknown[] = [];
  const span = fakeSpan({
    setStatus(status: unknown) {
      statuses.push(status);
      return this;
    },
    addEvent(name: string, attributes: unknown) {
      events.push({ name, attributes });
      return this;
    },
  });
  const tracer = { startSpan: () => span } as unknown as Tracer;
  const telemetry = createRelayTelemetry({
    dependencies: { tracer, meter: null },
  });
  const error = new Error("Bearer business-error-canary");
  let caught: unknown;

  try {
    await telemetry.withSpan("database.query", {}, () => {
      throw error;
    });
  } catch (thrown) {
    caught = thrown;
  }

  assertStrictEquals(caught, error);
  assertEquals(statuses, [{
    code: SpanStatusCode.ERROR,
    message: "Operation failed",
  }]);
  const serialized = JSON.stringify(events);
  assertEquals(serialized.includes("business-error-canary"), false);
  assertEquals(serialized.includes("exception.stacktrace"), false);
});

Deno.test("extracted parent context is passed to consumer span creation", async () => {
  const parent: Context = context.active().setValue(
    Symbol.for("relay.parent") as never,
    "present",
  );
  let receivedParent: Context | undefined;
  const tracer = {
    startSpan(_name: string, _options: unknown, parentContext?: Context) {
      receivedParent = parentContext;
      return fakeSpan();
    },
  } as unknown as Tracer;
  const telemetry = createRelayTelemetry({
    dependencies: { tracer, meter: null },
  });

  await telemetry.withSpan(
    "bullmq.consume",
    { kind: "consumer", parentContext: parent },
    () => undefined,
  );
  assertStrictEquals(receivedParent, parent);
});

Deno.test("consumer spans without queue metadata start from root context", async () => {
  let receivedParent: Context | undefined;
  const tracer = {
    startSpan(_name: string, _options: unknown, parentContext?: Context) {
      receivedParent = parentContext;
      return fakeSpan();
    },
  } as unknown as Tracer;
  const telemetry = createRelayTelemetry({
    dependencies: { tracer, meter: null },
  });

  await telemetry.withSpan(
    "bullmq.consume",
    { kind: "consumer" },
    () => undefined,
  );
  assertStrictEquals(receivedParent, ROOT_CONTEXT);
});

Deno.test("metric failures are dropped and attributes stay bounded", () => {
  const calls: Array<{ value: number; attributes: unknown }> = [];
  const meter = {
    createCounter() {
      return {
        add(value: number, attributes: unknown) {
          calls.push({ value, attributes });
          if (value === 99) throw new Error("export failure");
        },
      };
    },
  } as unknown as Meter;
  const telemetry = createRelayTelemetry({
    attributes: { maxValuesPerKey: 2 },
    dependencies: { tracer: null, meter },
  });
  const counter = telemetry.counter("relay.provider.outcomes");

  counter.add(1, { provider: "provider-a", outcome: "success" });
  counter.add(1, { provider: "provider-b", outcome: "success" });
  counter.add(1, { provider: "provider-c", outcome: "success" });
  counter.add(99, { provider: "provider-a", outcome: "failure" });
  counter.add(-1, { provider: "provider-a" });

  assertEquals(calls.length, 4);
  assertEquals(calls[2].attributes, {
    provider: "other",
    outcome: "success",
  });
});

Deno.test("metric contracts fix kind, unit, labels, and attribute-set count", () => {
  const creations: Array<{
    kind: string;
    name: string;
    options: unknown;
  }> = [];
  const calls: Array<{ value: number; attributes: unknown }> = [];
  const meter = {
    createCounter(name: string, options: unknown) {
      creations.push({ kind: "counter", name, options });
      return {
        add(value: number, attributes: unknown) {
          calls.push({ value, attributes });
        },
      };
    },
    createHistogram(name: string, options: unknown) {
      creations.push({ kind: "histogram", name, options });
      return { record() {} };
    },
    createObservableGauge(name: string, options: unknown) {
      creations.push({ kind: "observable_gauge", name, options });
      return { addCallback() {}, removeCallback() {} };
    },
    createUpDownCounter(name: string, options: unknown) {
      creations.push({ kind: "up_down_counter", name, options });
      return { add() {} };
    },
  } as unknown as Meter;
  const telemetry = createRelayTelemetry({
    maxMetricAttributeSets: 2,
    dependencies: { tracer: null, meter },
  });

  telemetry.histogram("relay.http.server.request.duration");
  const bytes = telemetry.counter("relay.storage.bytes");
  const outcomes = telemetry.counter("relay.provider.outcomes");
  outcomes.add(1, {
    provider: "provider-a",
    outcome: "success",
    "queue.name": "must-not-be-a-provider-label",
  });
  outcomes.add(1, { provider: "provider-b", outcome: "success" });
  outcomes.add(1, { provider: "provider-c", outcome: "success" });
  bytes.add(2, { "storage.system": "s3", operation: "upload" });
  telemetry.observableGauge("relay.queue.depth", () => {});
  telemetry.upDownCounter("relay.capacity.active");

  assertEquals(creations[0], {
    kind: "histogram",
    name: "relay.http.server.request.duration",
    options: {
      description: "Relay HTTP response-header duration",
      unit: "s",
      advice: {
        explicitBucketBoundaries: [
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
        ],
      },
    },
  });
  assertEquals(creations[1], {
    kind: "counter",
    name: "relay.storage.bytes",
    options: {
      description: "Relay storage bytes transferred",
      unit: "By",
    },
  });
  assertEquals(creations[3], {
    kind: "observable_gauge",
    name: "relay.queue.depth",
    options: {
      description: "Current Relay queue depth",
      unit: "{job}",
    },
  });
  assertEquals(creations[4], {
    kind: "up_down_counter",
    name: "relay.capacity.active",
    options: {
      description: "Active Relay capacity permits",
      unit: "{permit}",
    },
  });
  assertEquals(calls.slice(0, 2), [
    {
      value: 1,
      attributes: { provider: "provider-a", outcome: "success" },
    },
    {
      value: 1,
      attributes: { provider: "provider-b", outcome: "success" },
    },
  ]);
  assertEquals(calls.length, 3);

  const counterCreations = creations.length;
  (telemetry.counter as (name: string) => { add(value: number): void })(
    "relay.queue.depth",
  ).add(1);
  assertEquals(creations.length, counterCreations);
});

Deno.test("metric attribute-set limits are validated", () => {
  assertThrows(
    () => createRelayTelemetry({ maxMetricAttributeSets: 0 }),
    TypeError,
    "between 1 and 4096",
  );
});
