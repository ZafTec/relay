import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { Redis } from "ioredis";
import { type AdmitRunInput, admitToolRun } from "./admission.ts";
import { relayOutboxBatch } from "./outbox-relay.ts";
import { createExecutionQueue, createExecutionWorker } from "./bullmq.ts";
import { ticketId } from "./tickets.ts";
import type { ExecutionTicket } from "./tickets.ts";

/**
 * The full write path in one test: an admission creates a durable
 * run/job/outbox row (admission.ts), the outbox relay claims and
 * publishes it (outbox-relay.ts) as a real BullMQ ticket (bullmq.ts),
 * and a worker receives that exact ticket. Each stage already has its
 * own unit tests; this proves they compose.
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

async function createUser(pool: DatabasePool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth."user" (id, name, email, "emailVerified")
     values (gen_random_uuid()::text, 'Test', $1, true)
     returning id`,
    [`${unique("user")}@example.com`],
  );
  return rows[0].id;
}

async function createOrganization(pool: DatabasePool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth.organization (id, name, slug, "createdAt")
     values (gen_random_uuid()::text, 'Test Org', $1, now())
     returning id`,
    [unique("org")],
  );
  return rows[0].id;
}

async function createCapacityPool(pool: DatabasePool): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into relay.capacity_pools (key, execution_class)
     values ($1, 'standard')
     returning id`,
    [unique("pool")],
  );
  return Number(rows[0].id);
}

/**
 * See the matching comment in admission_test.ts's `cleanupFixture`:
 * `packages/auth`'s tests do a full `delete from auth."user"` reset
 * assuming exclusive ownership of that table, which a leftover
 * `relay.tool_runs.created_by` FK reference breaks.
 */
async function cleanupFixture(
  pool: DatabasePool,
  ids: {
    jobId: string;
    runId: string;
    workspaceId: string;
    createdBy: string;
    capacityPoolId: number;
    toolId: string;
  },
): Promise<void> {
  await pool.query("delete from relay.outbox_events where aggregate_id = $1", [
    ids.jobId,
  ]);
  await pool.query("delete from relay.job_attempts where job_id = $1", [
    ids.jobId,
  ]);
  await pool.query("delete from relay.execution_jobs where id = $1", [
    ids.jobId,
  ]);
  await pool.query(
    "delete from relay.idempotency_records where workspace_id = $1",
    [ids.workspaceId],
  );
  await pool.query("delete from relay.tool_runs where id = $1", [ids.runId]);
  await pool.query(
    "delete from relay.workspace_tool_queue_counters where workspace_id = $1",
    [ids.workspaceId],
  );
  await pool.query(
    "delete from relay.workspace_queue_counters where workspace_id = $1",
    [ids.workspaceId],
  );
  await pool.query("delete from relay.tool_queue_counters where tool_id = $1", [
    ids.toolId,
  ]);
  await pool.query("delete from relay.capacity_pools where id = $1", [
    ids.capacityPoolId,
  ]);
  await pool.query("delete from auth.organization where id = $1", [
    ids.workspaceId,
  ]);
  await pool.query('delete from auth."user" where id = $1', [ids.createdBy]);
}

Deno.test({
  name:
    "admission -> outbox relay -> BullMQ ticket -> worker delivery, end to end",
  ignore: !hasInfra,
  fn: async () => {
    const pool = testPool();
    const [workspaceId, createdBy, capacityPoolId] = await Promise.all([
      createOrganization(pool),
      createUser(pool),
      createCapacityPool(pool),
    ]);
    const toolId = unique("tool");

    const input: AdmitRunInput = {
      workspaceId,
      toolId,
      toolVersionId: unique("tool-version"),
      createdBy,
      input: { prompt: "a cat wearing a hat" },
      idempotencyKey: unique("idem"),
      capacityPoolId,
      schedulingClass: "standard",
      schedulingPolicyVersion: 1,
      estimatedCostUnits: 1,
      admissionDeadlineMs: 60_000,
      runDeadlineMs: 300_000,
      limits: { globalTool: 100, workspaceTotal: 100, workspaceTool: 100 },
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
      if (admitted?.kind === "admitted") {
        await cleanupFixture(pool, {
          jobId: admitted.jobId,
          runId: admitted.runId,
          workspaceId,
          createdBy,
          capacityPoolId,
          toolId,
        });
      }
      await pool.end();
    }
  },
});
