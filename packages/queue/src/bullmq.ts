import { Queue, Worker } from "bullmq";
import type { ConnectionOptions, Processor, WorkerOptions } from "bullmq";
import type { Redis } from "./redis.ts";
import {
  parseExecutionOutboxPayload,
  ticketFromOutboxPayload,
  ticketId,
} from "./tickets.ts";
import type { ExecutionOutboxPayload, ExecutionTicket } from "./tickets.ts";
import type { OutboxEventRow } from "./outbox-relay.ts";

/**
 * One BullMQ queue per capacity pool, not per tier -- see
 * "Queue topology" in 04-queue-capacity-scheduling.md. A capacity pool
 * key already identifies the shared constraint (provider/model/region or
 * a local execution class), so it's also the natural queue name.
 */
export function capacityPoolQueueName(capacityPoolKey: string): string {
  return `pool.${capacityPoolKey}`;
}

export function createExecutionQueue(
  connection: Redis,
  capacityPoolKey: string,
  prefix: string,
): Queue<ExecutionTicket> {
  return new Queue<ExecutionTicket>(capacityPoolQueueName(capacityPoolKey), {
    connection: connection as unknown as ConnectionOptions,
    prefix,
  });
}

export function createExecutionWorker(
  connection: Redis,
  capacityPoolKey: string,
  prefix: string,
  processor: Processor<ExecutionTicket>,
  options: Partial<WorkerOptions> = {},
): Worker<ExecutionTicket> {
  return new Worker<ExecutionTicket>(
    capacityPoolQueueName(capacityPoolKey),
    processor,
    {
      ...options,
      connection: connection as unknown as ConnectionOptions,
      prefix,
      autorun: false,
    },
  );
}

const RUNNABLE_TICKET_STATES = new Set([
  "active",
  "delayed",
  "prioritized",
  "waiting",
  "waiting-children",
]);

export type ExecutionOutboxAction =
  | {
    readonly kind: "dispatch";
    readonly payload: ExecutionOutboxPayload;
  }
  | {
    readonly kind: "cancel";
    readonly payload: ExecutionOutboxPayload;
  }
  | {
    readonly kind: "observe";
    readonly payload: ExecutionOutboxPayload;
  };

export function executionOutboxAction(
  event: OutboxEventRow,
): ExecutionOutboxAction {
  if (event.aggregateType !== "execution_job") {
    throw new Error(
      `Unsupported outbox aggregate type: ${event.aggregateType}`,
    );
  }

  const payload = parseExecutionOutboxPayload(event.payload);
  if (payload.domainJobId !== event.aggregateId) {
    throw new Error("Outbox aggregate ID does not match its execution ticket");
  }

  switch (event.eventType) {
    case "job.ready":
    case "job.deferred":
      return { kind: "dispatch", payload };
    case "job.started":
      return { kind: "observe", payload };
    case "job.cancel_requested":
    case "job.cancelled":
    case "job.terminal":
      return { kind: "cancel", payload };
    default:
      throw new Error(`Unsupported execution outbox event: ${event.eventType}`);
  }
}

/**
 * Lazily owns the producer-side Queue for every capacity pool. Consumer
 * workers use separate Redis connections; sharing one producer connection is
 * safe because Queue does not issue blocking commands.
 */
export class ExecutionQueueRegistry {
  readonly #queues = new Map<string, Queue<ExecutionTicket>>();

  constructor(
    private readonly connection: Redis,
    private readonly prefix: string,
  ) {}

  #queue(capacityPoolKey: string): Queue<ExecutionTicket> {
    let queue = this.#queues.get(capacityPoolKey);
    if (queue === undefined) {
      queue = createExecutionQueue(
        this.connection,
        capacityPoolKey,
        this.prefix,
      );
      this.#queues.set(capacityPoolKey, queue);
    }
    return queue;
  }

  async publish(
    payload: ExecutionOutboxPayload,
    schedulerToken: string,
  ): Promise<void> {
    const queue = this.#queue(payload.capacityPoolKey);
    const ticket = ticketFromOutboxPayload(payload, schedulerToken);
    const id = ticketId(ticket);
    const existing = await queue.getJob(id);
    if (existing !== undefined) {
      const state = await existing.getState();
      if (
        RUNNABLE_TICKET_STATES.has(state) &&
        existing.data.schedulerToken === schedulerToken
      ) return;
      if (state === "active") {
        throw new Error("Active BullMQ ticket has stale scheduler provenance");
      }
      // A completed/failed/stale transport record must not permanently suppress a
      // PostgreSQL job that reconciliation still sees as queued.
      await existing.remove();
    }

    await queue.add("execute", ticket, {
      jobId: id,
      attempts: 1,
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 1_000 },
    });
  }

  async cancel(payload: ExecutionOutboxPayload): Promise<void> {
    const queue = this.#queue(payload.capacityPoolKey);
    const job = await queue.getJob(ticketId(payload));
    if (job === undefined) return;
    const state = await job.getState();
    if (state === "active") return;
    await job.remove();
  }

  async waitingCount(capacityPoolKey: string): Promise<number> {
    return await this.#queue(capacityPoolKey).getWaitingCount();
  }

  async hasRunnableTicket(payload: ExecutionOutboxPayload): Promise<boolean> {
    const job = await this.#queue(payload.capacityPoolKey).getJob(
      ticketId(payload),
    );
    return job !== undefined &&
      RUNNABLE_TICKET_STATES.has(await job.getState());
  }

  async close(): Promise<void> {
    await Promise.all([...this.#queues.values()].map((queue) => queue.close()));
    this.#queues.clear();
  }
}
