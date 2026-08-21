import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { type AdmitRunInput, admitToolRun } from "./admission.ts";
import { claimJobForDispatch, deferJob, heartbeatJob } from "./dispatch.ts";
import type { ExecutionTicket } from "./tickets.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const hasDatabase = databaseUrl !== undefined;

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

interface AdmittedFixture {
  jobId: string;
  runId: string;
  workspaceId: string;
  createdBy: string;
  capacityPoolId: number;
  toolId: string;
}

async function admitJob(pool: DatabasePool): Promise<AdmittedFixture> {
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
    input: { prompt: "a cat" },
    idempotencyKey: unique("idem"),
    capacityPoolId,
    schedulingClass: "standard",
    schedulingPolicyVersion: 1,
    estimatedCostUnits: 1,
    admissionDeadlineMs: 60_000,
    runDeadlineMs: 300_000,
    limits: { globalTool: 100, workspaceTotal: 100, workspaceTool: 100 },
  };
  const result = await admitToolRun(pool, input);
  if (result.kind !== "admitted") throw new Error("fixture admission failed");
  return {
    jobId: result.jobId,
    runId: result.runId,
    workspaceId,
    createdBy,
    capacityPoolId,
    toolId,
  };
}

function ticketFor(jobId: string, dispatchGeneration = 0): ExecutionTicket {
  return { domainJobId: jobId, dispatchGeneration, policyVersion: 1 };
}

/** See the matching comment in admission_test.ts's `cleanupFixture` -- same reasoning, same dependency order. */
async function cleanupFixture(
  pool: DatabasePool,
  f: AdmittedFixture,
): Promise<void> {
  await pool.query("delete from relay.outbox_events where aggregate_id = $1", [
    f.jobId,
  ]);
  await pool.query("delete from relay.job_attempts where job_id = $1", [
    f.jobId,
  ]);
  await pool.query("delete from relay.execution_jobs where id = $1", [
    f.jobId,
  ]);
  await pool.query(
    "delete from relay.idempotency_records where workspace_id = $1",
    [
      f.workspaceId,
    ],
  );
  await pool.query("delete from relay.tool_runs where id = $1", [f.runId]);
  await pool.query(
    "delete from relay.workspace_tool_queue_counters where workspace_id = $1",
    [f.workspaceId],
  );
  await pool.query(
    "delete from relay.workspace_queue_counters where workspace_id = $1",
    [f.workspaceId],
  );
  await pool.query("delete from relay.tool_queue_counters where tool_id = $1", [
    f.toolId,
  ]);
  await pool.query("delete from relay.capacity_pools where id = $1", [
    f.capacityPoolId,
  ]);
  await pool.query("delete from auth.organization where id = $1", [
    f.workspaceId,
  ]);
  await pool.query('delete from auth."user" where id = $1', [f.createdBy]);
}

Deno.test({
  name:
    "claimJobForDispatch claims a queued job, bumps lease_epoch, and records an attempt",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmittedFixture | undefined;
    try {
      f = await admitJob(pool);
      const jobId = f.jobId;

      const result = await claimJobForDispatch(
        pool,
        ticketFor(jobId),
        "worker-a",
        30_000,
      );
      assertEquals(result.kind, "claimed");
      if (result.kind !== "claimed") throw new Error("unreachable");
      assertEquals(result.job.jobId, jobId);
      assertEquals(result.job.leaseEpoch, 1);
      assertEquals(result.job.attemptNumber, 1);

      const job = await pool.query<{ status: string; lease_owner: string }>(
        "select status, lease_owner from relay.execution_jobs where id = $1",
        [jobId],
      );
      assertEquals(job.rows[0].status, "running");
      assertEquals(job.rows[0].lease_owner, "worker-a");

      const attempts = await pool.query<
        { attempt_number: number; lease_epoch: string }
      >(
        "select attempt_number, lease_epoch from relay.job_attempts where job_id = $1",
        [jobId],
      );
      assertEquals(attempts.rows.length, 1);
      assertEquals(attempts.rows[0].attempt_number, 1);
      assertEquals(Number(attempts.rows[0].lease_epoch), 1);
    } finally {
      if (f) await cleanupFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "redelivering the same ticket after a successful claim is a no-op",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmittedFixture | undefined;
    try {
      f = await admitJob(pool);
      const jobId = f.jobId;
      const ticket = ticketFor(jobId);

      const first = await claimJobForDispatch(pool, ticket, "worker-a", 30_000);
      assertEquals(first.kind, "claimed");

      const redelivered = await claimJobForDispatch(
        pool,
        ticket,
        "worker-b",
        30_000,
      );
      assertEquals(redelivered.kind, "no_op");

      const attempts = await pool.query(
        "select id from relay.job_attempts where job_id = $1",
        [jobId],
      );
      assertEquals(
        attempts.rows.length,
        1,
        "a redelivered ticket must not create a second attempt",
      );
    } finally {
      if (f) await cleanupFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "a ticket for a stale dispatch_generation cannot claim a job that moved on",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmittedFixture | undefined;
    try {
      f = await admitJob(pool);
      const { jobId, runId } = f;
      const staleTicket = ticketFor(jobId, 0);

      const claim = await claimJobForDispatch(
        pool,
        staleTicket,
        "worker-a",
        30_000,
      );
      assertEquals(claim.kind, "claimed");
      if (claim.kind !== "claimed") throw new Error("unreachable");

      const deferred = await deferJob(
        pool,
        jobId,
        runId,
        claim.job.leaseEpoch,
        "worker-a",
        new Date(Date.now() + 1_000),
        "provider_rate_limit",
      );
      assertEquals(deferred, true);

      // The original ticket (generation 0) is now stale -- the job moved to
      // generation 1 when it was deferred.
      const staleRedelivery = await claimJobForDispatch(
        pool,
        staleTicket,
        "worker-c",
        30_000,
      );
      assertEquals(staleRedelivery.kind, "no_op");

      const freshTicket = ticketFor(jobId, 1);
      const freshClaim = await claimJobForDispatch(
        pool,
        freshTicket,
        "worker-c",
        30_000,
      );
      assertEquals(freshClaim.kind, "claimed");
    } finally {
      if (f) await cleanupFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name: "heartbeatJob succeeds only for the current epoch/owner",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmittedFixture | undefined;
    try {
      f = await admitJob(pool);
      const jobId = f.jobId;
      const claim = await claimJobForDispatch(
        pool,
        ticketFor(jobId),
        "worker-a",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("unreachable");

      const okHeartbeat = await heartbeatJob(
        pool,
        jobId,
        claim.job.leaseEpoch,
        "worker-a",
        30_000,
      );
      assertEquals(okHeartbeat, true);

      const wrongOwner = await heartbeatJob(
        pool,
        jobId,
        claim.job.leaseEpoch,
        "worker-b",
        30_000,
      );
      assertEquals(wrongOwner, false);

      const wrongEpoch = await heartbeatJob(
        pool,
        jobId,
        claim.job.leaseEpoch + 1,
        "worker-a",
        30_000,
      );
      assertEquals(wrongEpoch, false);
    } finally {
      if (f) await cleanupFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "deferJob returns the job to queued, increments deferral not attempt count, and emits a fresh outbox event",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmittedFixture | undefined;
    try {
      f = await admitJob(pool);
      const { jobId, runId } = f;
      const claim = await claimJobForDispatch(
        pool,
        ticketFor(jobId),
        "worker-a",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("unreachable");

      const eligibleAt = new Date(Date.now() + 2_000);
      const deferred = await deferJob(
        pool,
        jobId,
        runId,
        claim.job.leaseEpoch,
        "worker-a",
        eligibleAt,
        "global_tool_rate",
      );
      assertEquals(deferred, true);

      const job = await pool.query<
        {
          status: string;
          deferral_count: number;
          attempt_count: number;
          dispatch_generation: number;
        }
      >(
        "select status, deferral_count, attempt_count, dispatch_generation from relay.execution_jobs where id = $1",
        [jobId],
      );
      assertEquals(job.rows[0].status, "queued");
      assertEquals(job.rows[0].deferral_count, 1);
      assertEquals(
        job.rows[0].attempt_count,
        1,
        "deferral must not increment attempt_count",
      );
      assertEquals(job.rows[0].dispatch_generation, 1);

      const outbox = await pool.query<{ event_type: string }>(
        "select event_type from relay.outbox_events where aggregate_id = $1 order by created_at",
        [jobId],
      );
      assertEquals(
        outbox.rows.map((row: { event_type: string }) => row.event_type),
        ["job.ready", "job.deferred"],
      );
    } finally {
      if (f) await cleanupFixture(pool, f);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "deferJob fails with a stale epoch/owner instead of silently succeeding",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let f: AdmittedFixture | undefined;
    try {
      f = await admitJob(pool);
      const { jobId, runId } = f;
      const claim = await claimJobForDispatch(
        pool,
        ticketFor(jobId),
        "worker-a",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("unreachable");

      const wrongOwner = await deferJob(
        pool,
        jobId,
        runId,
        claim.job.leaseEpoch,
        "worker-b",
        new Date(Date.now() + 1_000),
        "provider_cooldown",
      );
      assertEquals(wrongOwner, false);

      const job = await pool.query<{ status: string }>(
        "select status from relay.execution_jobs where id = $1",
        [jobId],
      );
      assertEquals(
        job.rows[0].status,
        "running",
        "a fenced-out deferral must not change job state",
      );
    } finally {
      if (f) await cleanupFixture(pool, f);
      await pool.end();
    }
  },
});
