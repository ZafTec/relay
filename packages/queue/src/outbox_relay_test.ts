import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { createJsonLogger } from "@relay/observability";
import { Redis } from "ioredis";
import { claimOutboxBatch, relayOutboxBatch } from "./outbox-relay.ts";
import { createExecutionQueue, createExecutionWorker } from "./bullmq.ts";
import { ticketFromOutboxPayload, ticketId } from "./tickets.ts";
import { executionOutboxAction } from "./bullmq.ts";
import type { ExecutionTicket } from "./tickets.ts";

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

async function insertOutboxEvent(
  pool: DatabasePool,
  aggregateId: string,
  payload: unknown,
  eventType = "job.ready",
): Promise<void> {
  await pool.query(
    `insert into relay.outbox_events
       (aggregate_type, aggregate_id, aggregate_version, event_type, payload)
     values ('execution_job', $1, 1, $2, $3)`,
    [aggregateId, eventType, JSON.stringify(payload)],
  );
}

Deno.test({
  name:
    "relayOutboxBatch claims an eligible row, publishes a BullMQ ticket, and marks it published",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const capacityPoolKey = unique("pool");
    const prefix = "relay:test-outbox";
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
    const logger = createJsonLogger();
    worker.on("error", (error) =>
      logger.error({
        eventName: "test.worker.error",
        message: "Test worker error",
        operation: "consume",
        outcome: "failure",
        error,
      }));
    worker.on("failed", (_job, error) =>
      logger.error({
        eventName: "test.worker.failed",
        message: "Test worker ticket failed",
        operation: "consume",
        outcome: "failure",
        error,
      }));

    try {
      const ready = new Promise<void>((resolve) =>
        worker.once("ready", resolve)
      );
      worker.run();
      await ready;

      const aggregateId = unique("job");
      await insertOutboxEvent(pool, aggregateId, {
        domainJobId: aggregateId,
        runId: unique("run"),
        capacityPoolKey,
        dispatchGeneration: 7,
        policyVersion: 11,
        workspaceId: unique("workspace"),
        classKey: "standard",
        costUnits: 1,
        fifoSequence: 1,
        eligibleAtMs: Date.now(),
      });

      const result = await relayOutboxBatch(
        pool,
        async (event) => {
          const action = executionOutboxAction(event);
          if (action.kind !== "dispatch") throw new Error("unreachable");
          const ticket = ticketFromOutboxPayload(
            action.payload,
            `outbox-scheduler.${action.payload.domainJobId}`,
          );
          await queue.add("execute", ticket, { jobId: ticketId(ticket) });
        },
        { leaseOwner: "test-relay", leaseDurationMs: 30_000, batchSize: 10 },
      );

      assertEquals(result.claimed >= 1, true);

      // Wait specifically for *this* ticket -- a shared dev table can have
      // other unpublished rows from other tests still in flight, and a
      // single-concurrency worker processes them in some order, so "any
      // item arrived" is not the same as "our item arrived".
      const deadline = Date.now() + 10_000;
      while (
        !received.some((t) => t.domainJobId === aggregateId) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assertEquals(received.some((t) => t.domainJobId === aggregateId), true);

      const { rows } = await pool.query<{ published_at: Date | null }>(
        "select published_at from relay.outbox_events where aggregate_id = $1",
        [aggregateId],
      );
      assertEquals(rows.length, 1);
      assertEquals(rows[0].published_at !== null, true);
    } finally {
      await worker.close();
      await queue.close();
      await connection.quit();
      await workerConnection.quit();
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "relayOutboxBatch marks a failed publish and leaves the row unpublished for retry",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    try {
      const aggregateId = unique("job-fail");
      await insertOutboxEvent(pool, aggregateId, { domainJobId: aggregateId });

      const result = await relayOutboxBatch(
        pool,
        (event) => {
          if (
            (event.payload as { domainJobId: string }).domainJobId ===
              aggregateId
          ) {
            throw new Error("synthetic publish failure");
          }
          return Promise.resolve();
        },
        {
          leaseOwner: "test-relay-fail",
          leaseDurationMs: 30_000,
          batchSize: 10,
        },
      );

      assertEquals(result.failed >= 1, true);

      const { rows } = await pool.query<
        { published_at: Date | null; last_error: string | null }
      >(
        "select published_at, last_error from relay.outbox_events where aggregate_id = $1",
        [aggregateId],
      );
      assertEquals(rows[0].published_at, null);
      assertEquals(rows[0].last_error, "synthetic publish failure");

      // This row is permanently unpublished by design; delete it so it
      // doesn't get greedily claimed by an unrelated test's relay run
      // sharing this dev database.
      await pool.query(
        "delete from relay.outbox_events where aggregate_id = $1",
        [aggregateId],
      );
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "the final failed publication is marked exhausted in PostgreSQL",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const aggregateId = unique("job-exhausted");
    const eventType = unique("test.exhausted");
    try {
      await insertOutboxEvent(pool, aggregateId, {}, eventType);
      await pool.query(
        "update relay.outbox_events set attempt_count = 7 where aggregate_id = $1",
        [aggregateId],
      );

      const result = await relayOutboxBatch(
        pool,
        () => Promise.reject(new Error("last publish failed")),
        {
          leaseOwner: "test-final-failure",
          maxAttempts: 8,
          eventTypes: [eventType],
        },
      );
      assertEquals(result.exhausted, 1);

      const { rows } = await pool.query<{
        failed_at: Date | null;
        attempt_count: number;
      }>(
        "select failed_at, attempt_count from relay.outbox_events where aggregate_id = $1",
        [aggregateId],
      );
      assertEquals(rows[0].failed_at !== null, true);
      assertEquals(rows[0].attempt_count, 8);
    } finally {
      await pool.query(
        "delete from relay.outbox_events where aggregate_id = $1",
        [aggregateId],
      );
      await pool.end();
    }
  },
});

Deno.test({
  name: "an expired final claim is terminalized before another claim pass",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const aggregateId = unique("job-expired-final-claim");
    const eventType = unique("test.expired-final-claim");
    let publications = 0;
    try {
      await insertOutboxEvent(pool, aggregateId, {}, eventType);
      await pool.query(
        `update relay.outbox_events
            set attempt_count = 8,
                lease_owner = 'crashed-relay',
                lease_expires_at = now() - interval '1 second'
          where aggregate_id = $1`,
        [aggregateId],
      );

      const result = await relayOutboxBatch(
        pool,
        () => {
          publications += 1;
          return Promise.resolve();
        },
        {
          leaseOwner: "replacement-relay",
          maxAttempts: 8,
          eventTypes: [eventType],
        },
      );
      assertEquals(result.exhausted, 1);
      assertEquals(result.claimed, 0);
      assertEquals(publications, 0);

      const { rows } = await pool.query<{ failed_at: Date | null }>(
        "select failed_at from relay.outbox_events where aggregate_id = $1",
        [aggregateId],
      );
      assertEquals(rows[0].failed_at !== null, true);
    } finally {
      await pool.query(
        "delete from relay.outbox_events where aggregate_id = $1",
        [aggregateId],
      );
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "a leased-but-unpublished row is not claimed again until its lease expires",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    try {
      const aggregateId = unique("job-lease");
      await insertOutboxEvent(pool, aggregateId, { domainJobId: aggregateId });

      const leaseDurationMs = 300;
      const firstClaim = await claimOutboxBatch(
        pool,
        "relay-a",
        leaseDurationMs,
        10,
      );
      assertEquals(
        firstClaim.some((e) => e.aggregateId === aggregateId),
        true,
      );

      const immediateSecondClaim = await claimOutboxBatch(
        pool,
        "relay-b",
        leaseDurationMs,
        10,
      );
      assertEquals(
        immediateSecondClaim.some((e) => e.aggregateId === aggregateId),
        false,
        "the row is still leased by relay-a and must not be reclaimed",
      );

      await new Promise((resolve) =>
        setTimeout(resolve, leaseDurationMs + 100)
      );

      const afterExpiryClaim = await claimOutboxBatch(
        pool,
        "relay-b",
        leaseDurationMs,
        10,
      );
      assertEquals(
        afterExpiryClaim.some((e) => e.aggregateId === aggregateId),
        true,
        "after the lease expires, the row must become claimable again",
      );

      // Never published by this test; delete it so it doesn't get
      // greedily claimed by an unrelated test's relay run.
      await pool.query(
        "delete from relay.outbox_events where aggregate_id = $1",
        [aggregateId],
      );
    } finally {
      await pool.end();
    }
  },
});
