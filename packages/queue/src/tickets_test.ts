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
    workspaceId: "workspace-123",
    classKey: "paid",
    costUnits: 3,
    fifoSequence: 41,
    eligibleAtMs: 1_700_000_000_000,
    traceparent: "00-trace",
  });
  const ticket = ticketFromOutboxPayload(
    payload,
    "scheduler-token-1234567890",
  );
  assertEquals(ticket, {
    domainJobId: "123",
    dispatchGeneration: 7,
    policyVersion: 19,
    schedulerToken: "scheduler-token-1234567890",
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
      schedulerToken: "scheduler-token-1234567890",
    })
  );
  assertThrows(() =>
    parseExecutionTicket({
      domainJobId: "123",
      dispatchGeneration: 0,
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
