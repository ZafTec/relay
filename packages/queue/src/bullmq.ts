import { Queue, Worker } from "bullmq";
import type { ConnectionOptions, Processor, WorkerOptions } from "bullmq";
import type { Redis } from "./redis.ts";
import type { ExecutionTicket } from "./tickets.ts";

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
