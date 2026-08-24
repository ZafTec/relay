import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  createRelayTelemetry,
  type extractTraceContext,
  type RelaySpanOptions,
  type SafeSpan,
} from "@relay/observability";
import { withExecutionConsumerSpan } from "./processor.ts";
import type { ExecutionTicket } from "./tickets.ts";

const ticket: ExecutionTicket = {
  domainJobId: "job-private-identifier",
  dispatchGeneration: 2,
  policyVersion: 4,
  schedulerToken: "scheduler-token-1234567890",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  tracestate: "vendor=value",
};

Deno.test("worker consumer spans use extracted ticket context and bounded attributes", async () => {
  const parent = {} as ReturnType<typeof extractTraceContext>;
  let receivedCarrier: unknown;
  let receivedName: string | undefined;
  let receivedOptions: RelaySpanOptions | undefined;
  let calls = 0;
  const span: SafeSpan = { setAttributes() {}, addEvent() {} };
  const telemetry = {
    withSpan<T>(
      name: string,
      options: RelaySpanOptions,
      work: (activeSpan: SafeSpan) => T | Promise<T>,
    ): Promise<T> {
      receivedName = name;
      receivedOptions = options;
      return Promise.resolve(work(span));
    },
  };

  const result = await withExecutionConsumerSpan(
    telemetry,
    ticket,
    () => {
      calls += 1;
      return "completed";
    },
    (carrier) => {
      receivedCarrier = carrier;
      return parent;
    },
  );

  assertEquals(result, "completed");
  assertEquals(calls, 1);
  assertStrictEquals(receivedCarrier, ticket);
  assertEquals(receivedName, "bullmq.consume");
  assertStrictEquals(receivedOptions?.parentContext, parent);
  assertEquals(receivedOptions?.attributes, {
    "messaging.system": "bullmq",
    "queue.name": "execution",
  });
  assertEquals(
    JSON.stringify(receivedOptions).includes(ticket.domainJobId),
    false,
  );
});

Deno.test("consumer span startup failure does not rerun or fail work", async () => {
  const telemetry = createRelayTelemetry({
    dependencies: {
      tracer: {
        startSpan() {
          throw new Error("telemetry unavailable");
        },
      } as never,
      meter: null,
    },
  });
  let calls = 0;

  const result = await withExecutionConsumerSpan(telemetry, ticket, () => {
    calls += 1;
    return 42;
  });

  assertEquals(result, 42);
  assertEquals(calls, 1);
});
