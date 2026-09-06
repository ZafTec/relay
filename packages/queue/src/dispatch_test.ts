import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { type AdmitRunInput, admitToolRun } from "./admission.ts";
import {
  armSchedulerTicket,
  beginJobAttempt,
  claimJobForDispatch,
  completeJobCancellation,
  completeJobSuccessfully,
  deferJob,
  expireQueuedJobs,
  failJob,
  heartbeatJob,
  markAttemptSubmitted,
  markAttemptSubmitting,
  parseSubmissionRatePolicy,
  persistCapacityLease,
  recoverExpiredJobLeases,
  requestJobCancellation,
  retryJob,
} from "./dispatch.ts";
import type { ClaimedJob, JobAttempt } from "./dispatch.ts";
import type { ExecutionTicket } from "./tickets.ts";
import {
  type AdmissibleFixture,
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
  TEST_USAGE_PORT,
} from "./test_support.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const hasDatabase = databaseUrl !== undefined;

Deno.test("submission rate policies parse the seeded MVP rates", () => {
  assertEquals(parseSubmissionRatePolicy(null, null), {
    providerPerMinute: null,
    toolPerMinute: null,
    capacityPoolRevision: null,
    toolRevision: null,
  });
  assertEquals(
    parseSubmissionRatePolicy(
      {
        revision: 2,
        configuration: {
          submissionRateDefaults: {
            providerPerMinute: 12,
            toolPerMinute: 6,
          },
        },
      },
      null,
    ),
    {
      providerPerMinute: 12,
      toolPerMinute: 6,
      capacityPoolRevision: 2,
      toolRevision: null,
    },
  );
  for (const providerPerMinute of [12, 4, 50]) {
    assertEquals(
      parseSubmissionRatePolicy(
        {
          revision: 7,
          configuration: {
            submissionRateDefaults: { providerPerMinute },
          },
        },
        {
          revision: 3,
          configuration: {
            submissionRateDefaults: { toolPerMinute: 4 },
          },
        },
      ),
      {
        providerPerMinute,
        toolPerMinute: 4,
        capacityPoolRevision: 7,
        toolRevision: 3,
      },
    );
  }
});

Deno.test("submission rate policies reject malformed present rates", () => {
  for (const providerPerMinute of [0, -1, 1.5, "12", Number.NaN]) {
    assertThrows(
      () =>
        parseSubmissionRatePolicy(
          {
            revision: 1,
            configuration: {
              submissionRateDefaults: { providerPerMinute },
            },
          },
          null,
        ),
      Error,
      "providerPerMinute must be a positive integer",
    );
  }
  assertThrows(
    () =>
      parseSubmissionRatePolicy(
        {
          revision: 1,
          configuration: {
            submissionRateDefaults: { providerPerMinute: 12 },
          },
        },
        {
          revision: 2,
          configuration: {
            submissionRateDefaults: { toolPerMinute: "4" },
          },
        },
      ),
    Error,
    "toolPerMinute must be a positive integer",
  );
});

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

async function admitJobForFixture(
  pool: DatabasePool,
  fixture: AdmissibleFixture,
): Promise<Omit<AdmittedJob, "fixture">> {
  const input: AdmitRunInput = {
    workspaceId: fixture.workspaceId,
    toolVersionId: fixture.toolVersionId,
    createdBy: fixture.createdBy,
    input: { prompt: "a cat" },
    idempotencyKey: unique("idem"),
    admissionDeadlineMs: 60_000,
    runDeadlineMs: 300_000,
  };
  const result = await admitToolRun(pool, input, {
    handlers: fixture.handlers,
    usage: TEST_USAGE_PORT,
  });
  if (result.kind !== "admitted") throw new Error("fixture admission failed");
  const token = schedulerToken(result.jobId, 0);
  if (await armSchedulerTicket(pool, result.jobId, 0, token) === null) {
    throw new Error("fixture scheduler token arm failed");
  }
  return { jobId: result.jobId, runId: result.runId };
}

async function admitJob(pool: DatabasePool): Promise<AdmittedJob> {
  const fixture = await createAdmissibleFixture(pool);
  return { fixture, ...await admitJobForFixture(pool, fixture) };
}

function schedulerToken(jobId: string, dispatchGeneration: number): string {
  return `scheduler-test.${jobId}.${dispatchGeneration}`;
}

function ticketFor(jobId: string, dispatchGeneration = 0): ExecutionTicket {
  return {
    domainJobId: jobId,
    dispatchGeneration,
    policyVersion: 1,
    schedulerToken: schedulerToken(jobId, dispatchGeneration),
  };
}

async function attachCapacityAndBeginAttempt(
  pool: DatabasePool,
  job: ClaimedJob,
  owner: string,
): Promise<JobAttempt> {
  const leaseId = await persistCapacityLease(pool, job, owner, {
    redisLeaseId: crypto.randomUUID(),
    redisScopeKeys: [unique("scope")],
    expiresAt: new Date(Date.now() + 30_000),
    units: 1,
  });
  if (leaseId === null) throw new Error("fixture capacity attach failed");
  const attempt = await beginJobAttempt(pool, job, owner);
  if (attempt === null) throw new Error("fixture attempt start failed");
  const submitting = await markAttemptSubmitting(
    pool,
    job.jobId,
    attempt.attemptId,
    job.leaseEpoch,
    owner,
  );
  if (!submitting) throw new Error("fixture attempt submission failed");
  return attempt;
}

async function assertAllCounters(
  pool: DatabasePool,
  fixture: AdmissibleFixture,
  queued: number,
  running: number,
): Promise<void> {
  const tool = await pool.query<
    { queued_count: number; running_count: number }
  >(
    "select queued_count, running_count from relay.tool_queue_counters where tool_id = $1",
    [fixture.toolId],
  );
  const workspace = await pool.query<{
    queued_count: number;
    running_count: number;
  }>(
    "select queued_count, running_count from relay.workspace_queue_counters where workspace_id = $1",
    [fixture.workspaceId],
  );
  const workspaceTool = await pool.query<{
    queued_count: number;
    running_count: number;
  }>(
    "select queued_count, running_count from relay.workspace_tool_queue_counters where workspace_id = $1 and tool_id = $2",
    [fixture.workspaceId, fixture.toolId],
  );
  for (const row of [tool.rows[0], workspace.rows[0], workspaceTool.rows[0]]) {
    assertEquals(row.queued_count, queued);
    assertEquals(row.running_count, running);
  }
}

async function assertSingleLifecycleOutbox(
  pool: DatabasePool,
  jobId: string,
  eventType: "job.started" | "job.terminal",
): Promise<void> {
  const { rows } = await pool.query<{
    aggregate_version: string;
    deduplication_key: string;
    state_version: string;
  }>(
    `select event.aggregate_version::text, event.deduplication_key,
            job.state_version::text
       from relay.outbox_events event
       join relay.execution_jobs job on job.id::text = event.aggregate_id
      where event.aggregate_type = 'execution_job'
        and event.aggregate_id = $1
        and event.event_type = $2`,
    [jobId, eventType],
  );
  const eventName = eventType === "job.started" ? "started" : "terminal";
  assertEquals(rows.length, 1);
  assertEquals(rows[0].aggregate_version, rows[0].state_version);
  assertEquals(
    rows[0].deduplication_key,
    `execution-job.${jobId}.${eventName}.${rows[0].aggregate_version}`,
  );
}

function assertSingleTerminalOutbox(
  pool: DatabasePool,
  jobId: string,
): Promise<void> {
  return assertSingleLifecycleOutbox(pool, jobId, "job.terminal");
}

Deno.test({
  name:
    "claimJobForDispatch claims a queued job without opening an attempt before capacity",
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
      assertEquals(
        result.job.providerModelId,
        String(admitted.fixture.providerModelId),
      );
      assertEquals(result.job.submissionRatePolicy, {
        providerPerMinute: null,
        toolPerMinute: null,
        capacityPoolRevision: null,
        toolRevision: null,
      });

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
      assertEquals(
        attempts.rows.length,
        0,
        "claim alone must not count capacity waiting as a provider attempt",
      );

      const counters = await pool.query<
        { queued_count: number; running_count: number }
      >(
        "select queued_count, running_count from relay.tool_queue_counters where tool_id = $1",
        [admitted.fixture.toolId],
      );
      assertEquals(
        counters.rows[0].queued_count,
        0,
        "a claimed job must leave the queued counter",
      );
      assertEquals(
        counters.rows[0].running_count,
        1,
        "a claimed job must join the running counter",
      );
      await assertSingleLifecycleOutbox(pool, jobId, "job.started");
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "claim snapshots current validated submission rates and revisions",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      await pool.query(
        `insert into relay.capacity_policies
           (scope_type, scope_id, revision, configuration, effective_at)
         values
           ('capacity_pool', $1, 1, $2, now() - interval '1 second'),
           ('tool', $3, 1, $4, now() - interval '1 second')`,
        [
          admitted.fixture.capacityPoolId,
          JSON.stringify({
            submissionRateDefaults: { providerPerMinute: 12 },
            executionConcurrency: {
              globalTool: 2,
              pool: 3,
              workspaceTotal: 4,
              workspaceTool: 5,
            },
          }),
          admitted.fixture.toolId,
          JSON.stringify({
            submissionRateDefaults: { toolPerMinute: 4 },
          }),
        ],
      );

      const first = await claimJobForDispatch(
        pool,
        ticketFor(admitted.jobId),
        "worker-rate-v1",
        30_000,
      );
      if (first.kind !== "claimed") throw new Error("first claim failed");
      assertEquals(
        first.job.providerModelId,
        String(admitted.fixture.providerModelId),
      );
      assertEquals(first.job.capacityLimits, {
        globalTool: 2,
        pool: 3,
        workspaceTotal: 4,
        workspaceTool: 5,
      });
      assertEquals(first.job.submissionRatePolicy, {
        providerPerMinute: 12,
        toolPerMinute: 4,
        capacityPoolRevision: 1,
        toolRevision: 1,
      });

      await pool.query(
        `insert into relay.capacity_policies
           (scope_type, scope_id, revision, configuration, effective_at)
         values
           ('capacity_pool', $1, 2, $2, now() - interval '1 second'),
           ('capacity_pool', $1, 3, $3, now() + interval '1 day'),
           ('tool', $4, 2, $5, now() - interval '1 second')`,
        [
          admitted.fixture.capacityPoolId,
          JSON.stringify({
            submissionRateDefaults: { providerPerMinute: 50 },
          }),
          JSON.stringify({
            submissionRateDefaults: { providerPerMinute: 999 },
          }),
          admitted.fixture.toolId,
          JSON.stringify({
            submissionRateDefaults: { toolPerMinute: 4 },
          }),
        ],
      );
      const secondJob = await admitJobForFixture(pool, admitted.fixture);
      const second = await claimJobForDispatch(
        pool,
        ticketFor(secondJob.jobId),
        "worker-rate-v2",
        30_000,
      );
      if (second.kind !== "claimed") throw new Error("second claim failed");
      assertEquals(second.job.submissionRatePolicy, {
        providerPerMinute: 50,
        toolPerMinute: 4,
        capacityPoolRevision: 2,
        toolRevision: 2,
      });
    } finally {
      if (admitted) {
        await pool.query(
          "delete from relay.capacity_policies where scope_type = 'capacity_pool' and scope_id = $1",
          [admitted.fixture.capacityPoolId],
        );
        await cleanupAdmissibleFixture(pool, admitted.fixture);
      }
      await pool.end();
    }
  },
});

Deno.test({
  name: "claim fails closed and rolls back for a malformed current rate policy",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      await pool.query(
        `insert into relay.capacity_policies
           (scope_type, scope_id, revision, configuration, effective_at)
         values ('capacity_pool', $1, 1, $2, now() - interval '1 second')`,
        [
          admitted.fixture.capacityPoolId,
          JSON.stringify({
            submissionRateDefaults: { providerPerMinute: 0 },
          }),
        ],
      );

      await assertRejects(
        () =>
          claimJobForDispatch(
            pool,
            ticketFor(admitted!.jobId),
            "worker-malformed-rate",
            30_000,
          ),
        Error,
        "providerPerMinute must be a positive integer",
      );
      const job = await pool.query<{
        status: string;
        lease_epoch: string;
        lease_owner: string | null;
      }>(
        `select status, lease_epoch, lease_owner
           from relay.execution_jobs where id = $1`,
        [admitted.jobId],
      );
      assertEquals(job.rows[0], {
        status: "queued",
        lease_epoch: "0",
        lease_owner: null,
      });
    } finally {
      if (admitted) {
        await pool.query(
          "delete from relay.capacity_policies where scope_type = 'capacity_pool' and scope_id = $1",
          [admitted.fixture.capacityPoolId],
        );
        await cleanupAdmissibleFixture(pool, admitted.fixture);
      }
      await pool.end();
    }
  },
});

Deno.test({
  name: "BullMQ delivery without the armed scheduler provenance is a no-op",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const rejected = await claimJobForDispatch(
        pool,
        {
          ...ticketFor(admitted.jobId),
          schedulerToken: "legacy-publisher-token-0001",
        },
        "legacy-worker",
        30_000,
      );
      assertEquals(rejected.kind, "no_op");
      const job = await pool.query<{ status: string }>(
        "select status from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      assertEquals(job.rows[0].status, "queued");

      const accepted = await claimJobForDispatch(
        pool,
        ticketFor(admitted.jobId),
        "scheduler-worker",
        30_000,
      );
      assertEquals(accepted.kind, "claimed");
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
        0,
        "claim and redelivery must not open a provider attempt before capacity",
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
        new Date(0),
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
      await armSchedulerTicket(
        pool,
        jobId,
        1,
        freshTicket.schedulerToken,
      );
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
        0,
        "capacity waiting is not an attempt -- deferral must reverse claim's provisional increment",
      );
      assertEquals(job.rows[0].dispatch_generation, 1);

      const attempts = await pool.query(
        "select id from relay.job_attempts where job_id = $1",
        [jobId],
      );
      assertEquals(
        attempts.rows.length,
        0,
        "a deferred claim's attempt row must be removed, freeing its attempt_number for reuse",
      );

      const outbox = await pool.query<
        { event_type: string; eligible_at: Date }
      >(
        "select event_type, eligible_at from relay.outbox_events where aggregate_id = $1 order by created_at",
        [jobId],
      );
      assertEquals(
        outbox.rows.map((row: { event_type: string }) => row.event_type),
        ["job.ready", "job.started", "job.deferred"],
      );
      assertEquals(
        outbox.rows[2].eligible_at.getTime(),
        eligibleAt.getTime(),
        "the deferred outbox event must not be eligible for relay before the job itself is",
      );

      const counters = await pool.query<
        { queued_count: number; running_count: number }
      >(
        "select queued_count, running_count from relay.tool_queue_counters where tool_id = $1",
        [admitted.fixture.toolId],
      );
      assertEquals(counters.rows[0].queued_count, 1);
      assertEquals(counters.rows[0].running_count, 0);
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

Deno.test({
  name: "terminal success is fenced and decrements every running counter",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const claim = await claimJobForDispatch(
        pool,
        ticketFor(admitted.jobId),
        "worker-success",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("unreachable");
      const attempt = await attachCapacityAndBeginAttempt(
        pool,
        claim.job,
        "worker-success",
      );

      assertEquals(
        await completeJobSuccessfully(
          pool,
          admitted.jobId,
          attempt.attemptId,
          claim.job.leaseEpoch,
          "worker-success",
        ),
        true,
      );
      assertEquals(
        await completeJobSuccessfully(
          pool,
          admitted.jobId,
          attempt.attemptId,
          claim.job.leaseEpoch,
          "worker-success",
        ),
        false,
        "redelivery cannot terminalize or decrement twice",
      );

      const job = await pool.query<{
        status: string;
        capacity_lease_id: string | null;
      }>(
        "select status, capacity_lease_id from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      const run = await pool.query<{ status: string }>(
        "select status from relay.tool_runs where id = $1",
        [admitted.runId],
      );
      const attemptRow = await pool.query<{
        outcome: string;
        submission_state: string;
      }>(
        "select outcome, submission_state from relay.job_attempts where id = $1",
        [attempt.attemptId],
      );
      const lease = await pool.query<{ released_at: Date | null }>(
        "select released_at from relay.execution_capacity_leases where job_id = $1",
        [admitted.jobId],
      );
      assertEquals(job.rows[0], {
        status: "succeeded",
        capacity_lease_id: null,
      });
      assertEquals(run.rows[0].status, "succeeded");
      assertEquals(attemptRow.rows[0], {
        outcome: "succeeded",
        submission_state: "completed",
      });
      assertEquals(lease.rows[0].released_at !== null, true);
      await assertSingleTerminalOutbox(pool, admitted.jobId);
      await assertAllCounters(pool, admitted.fixture, 0, 0);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "terminal failure is owner fenced and decrements running counters once",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const claim = await claimJobForDispatch(
        pool,
        ticketFor(admitted.jobId),
        "worker-failure",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("unreachable");
      const attempt = await attachCapacityAndBeginAttempt(
        pool,
        claim.job,
        "worker-failure",
      );
      assertEquals(
        await failJob(
          pool,
          admitted.jobId,
          attempt.attemptId,
          claim.job.leaseEpoch,
          "stale-worker",
          "provider_transient",
          "must not win",
        ),
        false,
      );
      assertEquals(
        await failJob(
          pool,
          admitted.jobId,
          attempt.attemptId,
          claim.job.leaseEpoch,
          "worker-failure",
          "schema_or_policy_failure",
          "Authorization: Bearer secret-value",
        ),
        true,
      );
      assertEquals(
        await failJob(
          pool,
          admitted.jobId,
          attempt.attemptId,
          claim.job.leaseEpoch,
          "worker-failure",
          "schema_or_policy_failure",
          "redelivered",
        ),
        false,
      );
      const attemptRow = await pool.query<{
        sanitized_error: string;
        retry_classification: string;
      }>(
        "select sanitized_error, retry_classification from relay.job_attempts where id = $1",
        [attempt.attemptId],
      );
      assertEquals(
        attemptRow.rows[0].retry_classification,
        "schema_or_policy_failure",
      );
      assertEquals(
        attemptRow.rows[0].sanitized_error.includes("secret-value"),
        false,
      );
      await assertSingleTerminalOutbox(pool, admitted.jobId);
      await assertAllCounters(pool, admitted.fixture, 0, 0);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "queued cancellation terminalizes without allowing a later ticket claim",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      assertEquals(
        await requestJobCancellation(pool, admitted.jobId),
        { kind: "requested", running: false },
      );
      assertEquals(
        await requestJobCancellation(pool, admitted.jobId),
        { kind: "terminal_or_missing" },
      );
      assertEquals(
        (await claimJobForDispatch(
          pool,
          ticketFor(admitted.jobId),
          "worker-after-cancel",
          30_000,
        )).kind,
        "no_op",
      );
      await assertSingleTerminalOutbox(pool, admitted.jobId);
      await assertAllCounters(pool, admitted.fixture, 0, 0);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "running cancellation is completed by the fenced owner and releases capacity",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const claim = await claimJobForDispatch(
        pool,
        ticketFor(admitted.jobId),
        "worker-cancel",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("unreachable");
      const attempt = await attachCapacityAndBeginAttempt(
        pool,
        claim.job,
        "worker-cancel",
      );
      assertEquals(
        await requestJobCancellation(pool, admitted.jobId),
        { kind: "requested", running: true },
      );
      assertEquals(
        await completeJobCancellation(
          pool,
          admitted.jobId,
          attempt.attemptId,
          claim.job.leaseEpoch,
          "worker-cancel",
        ),
        true,
      );
      assertEquals(
        await completeJobCancellation(
          pool,
          admitted.jobId,
          attempt.attemptId,
          claim.job.leaseEpoch,
          "worker-cancel",
        ),
        false,
      );
      await assertSingleTerminalOutbox(pool, admitted.jobId);
      await assertAllCounters(pool, admitted.fixture, 0, 0);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "successful completion wins after cancellation and emits one terminal event",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const claim = await claimJobForDispatch(
        pool,
        ticketFor(admitted.jobId),
        "worker-completion-wins",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("unreachable");
      const attempt = await attachCapacityAndBeginAttempt(
        pool,
        claim.job,
        "worker-completion-wins",
      );
      assertEquals(
        await requestJobCancellation(pool, admitted.jobId),
        { kind: "requested", running: true },
      );
      assertEquals(
        await completeJobSuccessfully(
          pool,
          admitted.jobId,
          attempt.attemptId,
          claim.job.leaseEpoch,
          "worker-completion-wins",
        ),
        true,
      );
      assertEquals(
        await completeJobSuccessfully(
          pool,
          admitted.jobId,
          attempt.attemptId,
          claim.job.leaseEpoch,
          "worker-completion-wins",
        ),
        false,
      );

      const job = await pool.query<{ status: string }>(
        "select status from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      const run = await pool.query<{ status: string }>(
        "select status from relay.tool_runs where id = $1",
        [admitted.runId],
      );
      assertEquals(job.rows[0].status, "succeeded");
      assertEquals(run.rows[0].status, "succeeded");
      const events = await pool.query<{ event_type: string }>(
        `select event_type
           from relay.outbox_events
          where aggregate_type = 'execution_job' and aggregate_id = $1
          order by id`,
        [admitted.jobId],
      );
      assertEquals(
        events.rows.map((event: { event_type: string }) => event.event_type),
        [
          "job.ready",
          "job.started",
          "job.cancel_requested",
          "job.terminal",
        ],
      );
      await assertSingleTerminalOutbox(pool, admitted.jobId);
      await assertAllCounters(pool, admitted.fixture, 0, 0);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "stalled recovery requeues a submitted operation for safe reconciliation",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const claim = await claimJobForDispatch(
        pool,
        ticketFor(admitted.jobId),
        "worker-crashed",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("unreachable");
      const attempt = await attachCapacityAndBeginAttempt(
        pool,
        claim.job,
        "worker-crashed",
      );
      assertEquals(
        await markAttemptSubmitted(
          pool,
          admitted.jobId,
          attempt.attemptId,
          claim.job.leaseEpoch,
          "worker-crashed",
          "provider-operation-stalled",
        ),
        true,
      );
      await pool.query(
        "update relay.execution_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
        [admitted.jobId],
      );

      const recovery = await recoverExpiredJobLeases(pool);
      assertEquals(
        {
          recovered: recovery.recovered,
          cancelled: recovery.cancelled,
          failed: recovery.failed,
          leases: recovery.capacityLeasesToRelease.length,
        },
        { recovered: 1, cancelled: 0, failed: 0, leases: 1 },
      );
      const staleSuccess = await completeJobSuccessfully(
        pool,
        admitted.jobId,
        attempt.attemptId,
        claim.job.leaseEpoch,
        "worker-crashed",
      );
      assertEquals(staleSuccess, false);
      const job = await pool.query<{
        status: string;
        dispatch_generation: number;
        lease_epoch: string;
      }>(
        "select status, dispatch_generation, lease_epoch from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      assertEquals(job.rows[0].status, "queued");
      assertEquals(job.rows[0].dispatch_generation, 1);
      assertEquals(Number(job.rows[0].lease_epoch), claim.job.leaseEpoch + 1);
      await assertAllCounters(pool, admitted.fixture, 1, 0);
      const freshTicket = ticketFor(admitted.jobId, 1);
      await armSchedulerTicket(
        pool,
        admitted.jobId,
        1,
        freshTicket.schedulerToken,
      );
      const fresh = await claimJobForDispatch(
        pool,
        freshTicket,
        "worker-redelivery",
        30_000,
      );
      assertEquals(fresh.kind, "claimed");
      if (fresh.kind !== "claimed") throw new Error("unreachable");
      assertEquals(
        fresh.job.previousRetryClassification,
        "submission_confirmed",
      );
      assertEquals(
        fresh.job.previousProviderOperationId,
        "provider-operation-stalled",
      );
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "stalled recovery terminalizes a submitting attempt without provider evidence",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const claim = await claimJobForDispatch(
        pool,
        ticketFor(admitted.jobId),
        "worker-ambiguous",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("unreachable");
      const attempt = await attachCapacityAndBeginAttempt(
        pool,
        claim.job,
        "worker-ambiguous",
      );
      await pool.query(
        "update relay.execution_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
        [admitted.jobId],
      );

      const recovery = await recoverExpiredJobLeases(pool);
      assertEquals(
        {
          recovered: recovery.recovered,
          cancelled: recovery.cancelled,
          failed: recovery.failed,
          leases: recovery.capacityLeasesToRelease.length,
        },
        { recovered: 0, cancelled: 0, failed: 1, leases: 1 },
      );
      const job = await pool.query<{
        status: string;
        dispatch_generation: number;
        lease_epoch: string;
      }>(
        `select status, dispatch_generation, lease_epoch
           from relay.execution_jobs where id = $1`,
        [admitted.jobId],
      );
      assertEquals(job.rows[0], {
        status: "failed",
        dispatch_generation: 0,
        lease_epoch: String(claim.job.leaseEpoch + 1),
      });
      const attemptRow = await pool.query<{
        submission_state: string;
        outcome: string;
        retry_classification: string;
        failure_code: string;
        provider_operation_id: string | null;
      }>(
        `select submission_state, outcome, retry_classification,
                failure_code, provider_operation_id
           from relay.job_attempts where id = $1`,
        [attempt.attemptId],
      );
      assertEquals(attemptRow.rows[0], {
        submission_state: "ambiguous",
        outcome: "failed",
        retry_classification: "submission_ambiguous",
        failure_code: "provider_submission_ambiguous",
        provider_operation_id: null,
      });
      await assertSingleTerminalOutbox(pool, admitted.jobId);
      await assertAllCounters(pool, admitted.fixture, 0, 0);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "beginJobAttempt is idempotent for one lease epoch",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const claim = await claimJobForDispatch(
        pool,
        ticketFor(admitted.jobId),
        "worker-idempotent-attempt",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("unreachable");
      const leaseId = await persistCapacityLease(
        pool,
        claim.job,
        "worker-idempotent-attempt",
        {
          redisLeaseId: crypto.randomUUID(),
          redisScopeKeys: [unique("scope")],
          expiresAt: new Date(Date.now() + 30_000),
        },
      );
      if (leaseId === null) throw new Error("capacity attach failed");

      const first = await beginJobAttempt(
        pool,
        claim.job,
        "worker-idempotent-attempt",
      );
      const second = await beginJobAttempt(
        pool,
        claim.job,
        "worker-idempotent-attempt",
      );
      assertEquals(second, first);

      const job = await pool.query<{ attempt_count: number }>(
        "select attempt_count from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      const attempts = await pool.query<{ id: string }>(
        "select id from relay.job_attempts where job_id = $1",
        [admitted.jobId],
      );
      assertEquals(job.rows[0].attempt_count, 1);
      assertEquals(attempts.rows.length, 1);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "retryJob finishes one attempt and queues a fresh generation",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const claim = await claimJobForDispatch(
        pool,
        ticketFor(admitted.jobId),
        "worker-retry",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("unreachable");
      const attempt = await attachCapacityAndBeginAttempt(
        pool,
        claim.job,
        "worker-retry",
      );
      const eligibleAt = new Date(Date.now() + 1_000);
      const attemptDeadlineAt = new Date(Date.now() + 60_000);
      assertEquals(
        await retryJob(
          pool,
          admitted.jobId,
          admitted.runId,
          attempt.attemptId,
          claim.job.leaseEpoch,
          "worker-retry",
          eligibleAt,
          attemptDeadlineAt,
          "provider_transient",
          "retry me",
        ),
        true,
      );

      const job = await pool.query<{
        status: string;
        attempt_count: number;
        deferral_count: number;
        dispatch_generation: number;
        attempt_deadline_at: Date;
      }>(
        `select status, attempt_count, deferral_count, dispatch_generation,
                attempt_deadline_at
           from relay.execution_jobs where id = $1`,
        [admitted.jobId],
      );
      assertEquals(job.rows[0].status, "queued");
      assertEquals(job.rows[0].attempt_count, 1);
      assertEquals(job.rows[0].deferral_count, 0);
      assertEquals(job.rows[0].dispatch_generation, 1);
      assertEquals(
        job.rows[0].attempt_deadline_at.getTime(),
        attemptDeadlineAt.getTime(),
      );
      const attemptRow = await pool.query<{
        outcome: string;
        retry_classification: string;
      }>(
        "select outcome, retry_classification from relay.job_attempts where id = $1",
        [attempt.attemptId],
      );
      assertEquals(attemptRow.rows[0], {
        outcome: "retry_scheduled",
        retry_classification: "provider_transient",
      });
      await assertAllCounters(pool, admitted.fixture, 1, 0);

      await pool.query(
        `update relay.execution_jobs
            set attempt_deadline_at = now() - interval '1 second'
          where id = $1`,
        [admitted.jobId],
      );
      await expireQueuedJobs(pool);
      const expired = await pool.query<{ status: string }>(
        "select status from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      assertEquals(expired.rows[0].status, "failed");
      await assertAllCounters(pool, admitted.fixture, 0, 0);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "terminal transition rolls back when its attempt row is missing",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const claim = await claimJobForDispatch(
        pool,
        ticketFor(admitted.jobId),
        "worker-terminal-invariant",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("unreachable");
      await attachCapacityAndBeginAttempt(
        pool,
        claim.job,
        "worker-terminal-invariant",
      );

      await assertRejects(
        () =>
          completeJobSuccessfully(
            pool,
            admitted!.jobId,
            "9223372036854775807",
            claim.job.leaseEpoch,
            "worker-terminal-invariant",
          ),
        Error,
        "finish terminal job attempt affected 0 rows",
      );
      const job = await pool.query<{ status: string }>(
        "select status from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      assertEquals(job.rows[0].status, "running");
      await assertAllCounters(pool, admitted.fixture, 0, 1);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "queued deadline expiry terminalizes the run and decrements counters",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      await pool.query(
        `update relay.execution_jobs
            set admission_deadline_at = now() - interval '1 second'
          where id = $1`,
        [admitted.jobId],
      );
      await expireQueuedJobs(pool);

      const job = await pool.query<
        { status: string; terminal_at: Date | null }
      >(
        "select status, terminal_at from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      const run = await pool.query<
        { status: string; terminal_at: Date | null }
      >(
        "select status, terminal_at from relay.tool_runs where id = $1",
        [admitted.runId],
      );
      assertEquals(job.rows[0].status, "failed");
      assertEquals(job.rows[0].terminal_at !== null, true);
      assertEquals(run.rows[0].status, "failed");
      assertEquals(run.rows[0].terminal_at !== null, true);
      await assertSingleTerminalOutbox(pool, admitted.jobId);
      await assertAllCounters(pool, admitted.fixture, 0, 0);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});
