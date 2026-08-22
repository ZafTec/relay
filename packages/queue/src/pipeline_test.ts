import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { Redis } from "ioredis";
import { type AdmitRunInput, admitToolRun } from "./admission.ts";
import { relayOutboxBatch } from "./outbox-relay.ts";
import { createExecutionQueue, createExecutionWorker } from "./bullmq.ts";
import { ticketId } from "./tickets.ts";
import type { ExecutionTicket } from "./tickets.ts";
import {
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
} from "./test_support.ts";

/**
 * The full write path in one test: an admission creates a durable
 * run/job/outbox row (admission.ts, now also authorizing against a real
 * workspace membership and a real published catalog tool version), the
 * outbox relay claims and publishes it (outbox-relay.ts) as a real
 * BullMQ ticket (bullmq.ts), and a worker receives that exact ticket.
 * Each stage already has its own unit tests; this proves they compose.
 */
const databaseUrl = Deno.env.get("DATABASE_URL");
const redisUrl = Deno.env.get("REDIS_URL");
const hasInfra = databaseUrl !== undefined && redisUrl !== undefined;

function testPool(): DatabasePool {
  return createDatabasePool(
    {
      url: new URL(databaseUrl!),
      poolMax: 5,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
    },
    "relay-worker",
  );
}

function unique(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

Deno.test({
  name:
    "admission -> outbox relay -> BullMQ ticket -> worker delivery, end to end",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);

    const input: AdmitRunInput = {
      workspaceId: fixture.workspaceId,
      toolVersionId: fixture.toolVersionId,
      createdBy: fixture.createdBy,
      input: { prompt: "a cat wearing a hat" },
      idempotencyKey: unique("idem"),
      schedulingClass: "standard",
      schedulingPolicyVersion: 1,
      estimatedCostUnits: 1,
      admissionDeadlineMs: 60_000,
      runDeadlineMs: 300_000,
    };

    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const capacityPoolKey = unique("bullmq-pool");
    const prefix = "relay:test-pipeline";
    const queue = createExecutionQueue(connection, capacityPoolKey, prefix);

    const received: ExecutionTicket[] = [];
    const workerConnection = new Redis(redisUrl!, {
      maxRetriesPerRequest: null,
    });
    const worker = createExecutionWorker(
      workerConnection,
      capacityPoolKey,
      prefix,
      (job) => {
        received.push(job.data);
        return Promise.resolve();
      },
    );

    let admitted: Awaited<ReturnType<typeof admitToolRun>> | undefined;
    try {
      const ready = new Promise<void>((resolve) =>
        worker.once("ready", resolve)
      );
      worker.run();
      await ready;

      admitted = await admitToolRun(pool, input);
      assertEquals(admitted.kind, "admitted");
      if (admitted.kind !== "admitted") throw new Error("unreachable");
      const jobId = admitted.jobId;

      const relayResult = await relayOutboxBatch(
        pool,
        async (event) => {
          const payload = event.payload as {
            domainJobId: string;
            runId: string;
          };
          const ticket: ExecutionTicket = {
            domainJobId: payload.domainJobId,
            dispatchGeneration: 1,
            policyVersion: 1,
          };
          await queue.add("execute", ticket, { jobId: ticketId(ticket) });
        },
        { leaseOwner: "test-pipeline", leaseDurationMs: 30_000, batchSize: 10 },
      );
      assertEquals(
        relayResult.published >= 1,
        true,
        "the outbox relay must publish at least the row this admission created",
      );

      const deadline = Date.now() + 10_000;
      while (
        !received.some((t) => t.domainJobId === jobId) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assertEquals(
        received.some((t) => t.domainJobId === jobId),
        true,
        "the worker must receive a ticket for the job this admission created",
      );
    } finally {
      await worker.close();
      await queue.close();
      await connection.quit();
      await workerConnection.quit();
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});
