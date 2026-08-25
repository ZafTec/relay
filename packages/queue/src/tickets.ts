import type { SchedulingClassKey } from "@relay/scheduler";

export const MAX_SCHEDULER_COST_UNITS = 10_000;

/**
 * A BullMQ job payload, per
 * docs/implementation-handoff/04-queue-capacity-scheduling.md "Durable
 * versus transport state": only durable references, never prompts,
 * credentials, provider payloads, signed URLs, or file metadata. The
 * worker re-reads everything it needs from PostgreSQL by `domainJobId`.
 */
interface ExecutionDispatchMetadata {
  readonly domainJobId: string;
  readonly dispatchGeneration: number;
  readonly policyVersion: number;
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export interface ExecutionTicket extends ExecutionDispatchMetadata {
  /** One-generation token armed durably by the scheduler bridge. */
  readonly schedulerToken: string;
}

/** Durable outbox metadata used to route a transport-only ticket. */
export interface ExecutionOutboxPayload extends ExecutionDispatchMetadata {
  readonly runId: string;
  readonly capacityPoolKey: string;
  readonly workspaceId: string;
  readonly classKey: SchedulingClassKey;
  readonly costUnits: number;
  readonly fifoSequence: number;
  readonly eligibleAtMs: number;
}

export function dispatchDeduplicationKey(
  domainJobId: string,
  dispatchGeneration: number,
): string {
  return `execution-job.${domainJobId}.dispatch.${dispatchGeneration}`;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function parseDispatchMetadata(value: unknown): ExecutionDispatchMetadata {
  if (value === null || typeof value !== "object") {
    throw new Error("Execution ticket must be an object");
  }
  const payload = value as Record<string, unknown>;
  const policyVersion = payload.policyVersion;
  if (
    typeof payload.domainJobId !== "string" ||
    payload.domainJobId.length === 0 ||
    !Number.isSafeInteger(payload.dispatchGeneration) ||
    Number(payload.dispatchGeneration) < 0 ||
    !Number.isSafeInteger(policyVersion) ||
    Number(policyVersion) <= 0 ||
    !isOptionalString(payload.traceparent) ||
    !isOptionalString(payload.tracestate)
  ) {
    throw new Error("Execution ticket has invalid dispatch metadata");
  }
  return {
    domainJobId: payload.domainJobId,
    dispatchGeneration: Number(payload.dispatchGeneration),
    policyVersion: Number(policyVersion),
    ...(payload.traceparent === undefined
      ? {}
      : { traceparent: payload.traceparent }),
    ...(payload.tracestate === undefined
      ? {}
      : { tracestate: payload.tracestate }),
  };
}

export function parseExecutionTicket(value: unknown): ExecutionTicket {
  const metadata = parseDispatchMetadata(value);
  const schedulerToken = (value as Record<string, unknown>).schedulerToken;
  if (typeof schedulerToken !== "string" || schedulerToken.length < 16) {
    throw new Error("Execution ticket has no scheduler provenance");
  }
  return { ...metadata, schedulerToken };
}

export function parseExecutionOutboxPayload(
  value: unknown,
): ExecutionOutboxPayload {
  const ticket = parseDispatchMetadata(value);
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.runId !== "string" ||
    payload.runId.length === 0 ||
    typeof payload.capacityPoolKey !== "string" ||
    payload.capacityPoolKey.length === 0 ||
    typeof payload.workspaceId !== "string" ||
    payload.workspaceId.length === 0 ||
    !["standard", "paid", "enterprise", "internal"].includes(
      String(payload.classKey),
    ) ||
    typeof payload.costUnits !== "number" ||
    !Number.isFinite(payload.costUnits) ||
    payload.costUnits <= 0 ||
    payload.costUnits > MAX_SCHEDULER_COST_UNITS ||
    !Number.isSafeInteger(payload.fifoSequence) ||
    Number(payload.fifoSequence) <= 0 ||
    !Number.isSafeInteger(payload.eligibleAtMs) ||
    Number(payload.eligibleAtMs) < 0
  ) {
    throw new Error("Execution outbox payload has invalid routing metadata");
  }

  return {
    ...ticket,
    runId: payload.runId,
    capacityPoolKey: payload.capacityPoolKey,
    workspaceId: payload.workspaceId,
    classKey: payload.classKey as SchedulingClassKey,
    costUnits: payload.costUnits,
    fifoSequence: Number(payload.fifoSequence),
    eligibleAtMs: Number(payload.eligibleAtMs),
  };
}

export function ticketFromOutboxPayload(
  payload: ExecutionOutboxPayload,
  schedulerToken: string,
): ExecutionTicket {
  return {
    domainJobId: payload.domainJobId,
    dispatchGeneration: payload.dispatchGeneration,
    policyVersion: payload.policyVersion,
    schedulerToken,
    ...(payload.traceparent === undefined
      ? {}
      : { traceparent: payload.traceparent }),
    ...(payload.tracestate === undefined
      ? {}
      : { tracestate: payload.tracestate }),
  };
}

/**
 * BullMQ job-ID dedup only holds while the job hasn't been removed from
 * Redis yet ("BullMQ job-ID deduplication is not durable after old jobs
 * are removed" -- the doc's own caveat). It's still the right mechanism
 * for the common case: the outbox relay retries a publish after a crash
 * before acknowledging, and this makes that retry a no-op at the BullMQ
 * layer instead of a second ticket. Durable dedup is `dispatch_generation`
 * itself plus PostgreSQL fencing on delivery, not this ID.
 *
 * No `:` in the result -- BullMQ reserves it as its own internal key
 * separator and rejects a custom job ID containing one.
 */
export function ticketId(
  ticket: Pick<ExecutionDispatchMetadata, "domainJobId" | "dispatchGeneration">,
): string {
  return `job.${ticket.domainJobId}.gen.${ticket.dispatchGeneration}`;
}
