import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { type AdmitRunInput, admitToolRun } from "./admission.ts";
import { claimJobForDispatch, deferJob, heartbeatJob } from "./dispatch.ts";
import type { ExecutionTicket } from "./tickets.ts";
import {
  type AdmissibleFixture,
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
} from "./test_support.ts";

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

interface AdmittedJob {
  readonly fixture: AdmissibleFixture;
  readonly jobId: string;
  readonly runId: string;
}

async function admitJob(pool: DatabasePool): Promise<AdmittedJob> {
  const fixture = await createAdmissibleFixture(pool);
  const input: AdmitRunInput = {
    workspaceId: fixture.workspaceId,
    toolVersionId: fixture.toolVersionId,
    createdBy: fixture.createdBy,
    input: { prompt: "a cat" },
    idempotencyKey: unique("idem"),
    schedulingClass: "standard",
    schedulingPolicyVersion: 1,
    estimatedCostUnits: 1,
    admissionDeadlineMs: 60_000,
    runDeadlineMs: 300_000,
    limits: { globalTool: 100, workspaceTotal: 100, workspaceTool: 100 },
  };
  const result = await admitToolRun(pool, input);
  if (result.kind !== "admitted") throw new Error("fixture admission failed");
  return { fixture, jobId: result.jobId, runId: result.runId };
}

function ticketFor(jobId: string, dispatchGeneration = 0): ExecutionTicket {
  return { domainJobId: jobId, dispatchGeneration, policyVersion: 1 };
}

Deno.test({
  name:
    "claimJobForDispatch claims a queued job, bumps lease_epoch, and records an attempt",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const jobId = admitted.jobId;

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
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "redelivering the same ticket after a successful claim is a no-op",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const jobId = admitted.jobId;
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
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
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
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const { jobId, runId } = admitted;
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
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "heartbeatJob succeeds only for the current epoch/owner",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const jobId = admitted.jobId;
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
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
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
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const { jobId, runId } = admitted;
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
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
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
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const { jobId, runId } = admitted;
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
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});
