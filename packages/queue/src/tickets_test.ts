import { assertEquals, assertThrows } from "@std/assert";
import {
  dispatchDeduplicationKey,
  parseExecutionOutboxPayload,
  parseExecutionTicket,
  ticketFromOutboxPayload,
  ticketId,
} from "./tickets.ts";

Deno.test("outbox metadata produces the exact generation and policy ticket", () => {
  const payload = parseExecutionOutboxPayload({
    domainJobId: "123",
    runId: "run_123",
    capacityPoolKey: "images-us-east",
    dispatchGeneration: 7,
    policyVersion: 19,
    traceparent: "00-trace",
  });
  const ticket = ticketFromOutboxPayload(payload);
  assertEquals(ticket, {
    domainJobId: "123",
    dispatchGeneration: 7,
    policyVersion: 19,
    traceparent: "00-trace",
  });
  assertEquals(ticketId(ticket), "job.123.gen.7");
  assertEquals(
    dispatchDeduplicationKey("123", 7),
    "execution-job.123.dispatch.7",
  );
});

Deno.test("ticket validation rejects missing or malformed durable metadata", () => {
  assertThrows(() =>
    parseExecutionTicket({
      domainJobId: "123",
      dispatchGeneration: -1,
      policyVersion: 1,
    })
  );
  assertThrows(() =>
    parseExecutionOutboxPayload({
      domainJobId: "123",
      dispatchGeneration: 0,
      policyVersion: 1,
      runId: "run_123",
    })
  );
});
