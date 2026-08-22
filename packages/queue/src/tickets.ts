/**
 * A BullMQ job payload, per
 * docs/implementation-handoff/04-queue-capacity-scheduling.md "Durable
 * versus transport state": only durable references, never prompts,
 * credentials, provider payloads, signed URLs, or file metadata. The
 * worker re-reads everything it needs from PostgreSQL by `domainJobId`.
 */
export interface ExecutionTicket {
  readonly domainJobId: string;
  readonly dispatchGeneration: number;
  /** Null means no versioned scheduling policy was attached at admission. */
  readonly policyVersion: number | null;
  readonly traceparent?: string;
  readonly tracestate?: string;
}

/** Durable outbox metadata used to route a transport-only ticket. */
export interface ExecutionOutboxPayload extends ExecutionTicket {
  readonly runId: string;
  readonly capacityPoolKey: string;
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

export function parseExecutionTicket(value: unknown): ExecutionTicket {
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
    !(
      policyVersion === null ||
      (Number.isSafeInteger(policyVersion) && Number(policyVersion) >= 0)
    ) ||
    !isOptionalString(payload.traceparent) ||
    !isOptionalString(payload.tracestate)
  ) {
    throw new Error("Execution ticket has invalid dispatch metadata");
  }
  return {
    domainJobId: payload.domainJobId,
    dispatchGeneration: Number(payload.dispatchGeneration),
    policyVersion: policyVersion === null ? null : Number(policyVersion),
    ...(payload.traceparent === undefined
      ? {}
      : { traceparent: payload.traceparent }),
    ...(payload.tracestate === undefined
      ? {}
      : { tracestate: payload.tracestate }),
  };
}

export function parseExecutionOutboxPayload(
  value: unknown,
): ExecutionOutboxPayload {
  const ticket = parseExecutionTicket(value);
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.runId !== "string" ||
    payload.runId.length === 0 ||
    typeof payload.capacityPoolKey !== "string" ||
    payload.capacityPoolKey.length === 0
  ) {
    throw new Error("Execution outbox payload has invalid routing metadata");
  }

  return {
    ...ticket,
    runId: payload.runId,
    capacityPoolKey: payload.capacityPoolKey,
  };
}

export function ticketFromOutboxPayload(
  payload: ExecutionOutboxPayload,
): ExecutionTicket {
  return {
    domainJobId: payload.domainJobId,
    dispatchGeneration: payload.dispatchGeneration,
    policyVersion: payload.policyVersion,
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
export function ticketId(ticket: ExecutionTicket): string {
  return `job.${ticket.domainJobId}.gen.${ticket.dispatchGeneration}`;
}
