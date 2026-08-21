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
  readonly policyVersion: number;
  readonly traceparent?: string;
  readonly tracestate?: string;
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
