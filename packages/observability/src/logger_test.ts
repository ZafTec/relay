import { assertEquals } from "@std/assert";
import { createJsonLogger, type LogRecord, type LogSink } from "./logger.ts";

class MemorySink implements LogSink {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }
}

Deno.test("JSON logger emits a fixed schema with trace correlation", () => {
  const sink = new MemorySink();
  const logger = createJsonLogger({
    sink,
    now: () => new Date("2026-08-23T10:20:30.000Z"),
    traceContext: () => ({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    }),
  });

  const record = logger.info({
    eventName: "http.request.completed",
    message: "Request completed",
    operation: "request",
    outcome: "success",
    httpRoute: "/api/v1/runs/:runId",
    requestId: "request-123",
  });
  const parsed = JSON.parse(sink.lines[0]) as LogRecord;

  assertEquals(parsed, record);
  assertEquals(Object.keys(parsed), [
    "schema.version",
    "timestamp",
    "event.name",
    "severity",
    "message",
    "operation",
    "outcome",
    "error.type",
    "http.route",
    "tool.key",
    "tool.version",
    "provider",
    "model",
    "attempt.number",
    "queue.reason",
    "request.id",
    "trace_id",
    "span_id",
  ]);
  assertEquals(parsed.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
  assertEquals(parsed["http.route"], "/api/v1/runs/:runId");
});

Deno.test("logger leaves omitted optional fields null", () => {
  const sink = new MemorySink();
  const record = createJsonLogger({ sink }).info({
    eventName: "worker.started",
    message: "Worker started",
    operation: undefined,
    outcome: undefined,
    errorType: undefined,
    httpRoute: undefined,
    toolKey: undefined,
    toolVersion: undefined,
    provider: undefined,
    model: undefined,
    attemptNumber: undefined,
    queueReason: undefined,
    requestId: undefined,
  });

  assertEquals(
    [
      record.operation,
      record.outcome,
      record["error.type"],
      record["http.route"],
      record["tool.key"],
      record["tool.version"],
      record.provider,
      record.model,
      record["attempt.number"],
      record["queue.reason"],
      record["request.id"],
    ],
    [null, null, null, null, null, null, null, null, null, null, null],
  );
  assertEquals(sink.lines[0].includes('"outcome":"other"'), false);
  assertEquals(sink.lines[0].includes('"http.route":"/__unknown__"'), false);
});

Deno.test("logger replaces raw errors with safe normalized fields", () => {
  const sink = new MemorySink();
  const logger = createJsonLogger({ sink });
  const secret = "Bearer raw-error-secret-canary";
  const record = logger.error({
    eventName: "provider.failed",
    message: secret,
    error: new Error(secret),
    operation: "submit",
  });

  assertEquals(record.message, "Operation failed");
  assertEquals(record["error.type"], "internal");
  assertEquals(sink.lines[0].includes(secret), false);
  assertEquals(sink.lines[0].includes("stack"), false);
});

Deno.test("logger redacts every sensitive message canary", () => {
  const canaries = [
    "Authorization: Bearer bearer-canary",
    "callback=https://relay.example/oauth?code=oauth-canary&state=state-canary",
    "signed_url=https://s3.example/key?X-Amz-Signature=signed-canary",
    "prompt=private-prompt-canary",
    "object_key=private/object-canary.png",
    "sql_query=select value from secrets where value='sql-canary'",
  ];

  for (const canary of canaries) {
    const sink = new MemorySink();
    createJsonLogger({ sink }).warn({
      eventName: "redaction.canary",
      message: canary,
    });
    assertEquals(sink.lines[0].includes(canary), false);
    assertEquals(sink.lines[0].includes("[redacted]"), true);
  }
});

Deno.test("logger bounds event names and survives hostile event objects", () => {
  const sink = new MemorySink();
  const logger = createJsonLogger({ sink });
  const invalidName = logger.info({
    eventName: "/raw/550e8400-e29b-41d4-a716-446655440000",
    message: "Safe message",
  });
  assertEquals(invalidName["event.name"], "relay.invalid_event");

  const hostile = new Proxy({}, {
    get() {
      throw new Error("Bearer getter-secret-canary");
    },
    getOwnPropertyDescriptor() {
      throw new Error("Bearer descriptor-secret-canary");
    },
  });
  const fallback = logger.warn(hostile as never);
  assertEquals(fallback["event.name"], "relay.invalid_event");
  assertEquals(fallback.message, "Invalid log event");
  assertEquals(fallback.severity, "WARN");
  assertEquals(sink.lines.join("\n").includes("getter-secret-canary"), false);
  assertEquals(
    sink.lines.join("\n").includes("descriptor-secret-canary"),
    false,
  );
});

Deno.test("logger sink failures never escape", () => {
  const logger = createJsonLogger({
    sink: {
      write() {
        throw new Error("collector unavailable");
      },
    },
  });
  const record = logger.info({
    eventName: "business.completed",
    message: "Business operation completed",
  });
  assertEquals(record["event.name"], "business.completed");
});
