import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { type AdmitRunInput, admitToolRun } from "./admission.ts";
import { requestJobCancellation } from "./dispatch.ts";
import {
  type AcquiredCapacityLease,
  type CapacityAcquisitionResult,
  type ExecutionCapacityController,
  ExecutionProcessor,
  type ExecutionProcessorOptions,
  type SubmissionPermitResult,
} from "./processor.ts";
import type { ExecutionTicket } from "./tickets.ts";
import {
  type AdmissibleFixture,
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
} from "./test_support.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");

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

interface AdmittedJob {
  readonly fixture: AdmissibleFixture;
  readonly jobId: string;
  readonly runId: string;
  readonly ticket: ExecutionTicket;
}

async function admitJob(pool: DatabasePool): Promise<AdmittedJob> {
  const fixture = await createAdmissibleFixture(pool);
  const input: AdmitRunInput = {
    workspaceId: fixture.workspaceId,
    toolVersionId: fixture.toolVersionId,
    createdBy: fixture.createdBy,
    input: { prompt: "processor test" },
    idempotencyKey: `idem-${crypto.randomUUID()}`,
    schedulingClass: "standard",
    schedulingPolicyVersion: 1,
    estimatedCostUnits: 1,
    admissionDeadlineMs: 60_000,
    runDeadlineMs: 300_000,
  };
  const result = await admitToolRun(pool, input);
  if (result.kind !== "admitted") throw new Error("fixture admission failed");
  const job = await pool.query<{ scheduling_policy_version: number }>(
    "select scheduling_policy_version from relay.execution_jobs where id = $1",
    [result.jobId],
  );
  return {
    fixture,
    jobId: result.jobId,
    runId: result.runId,
    ticket: {
      domainJobId: result.jobId,
      dispatchGeneration: 0,
      policyVersion: job.rows[0].scheduling_policy_version,
    },
  };
}

class FakeCapacityController implements ExecutionCapacityController {
  acquisition: CapacityAcquisitionResult | undefined;
  submissionPermit: SubmissionPermitResult = { kind: "acquired" };
  renewOk = true;
  releaseCount = 0;
  cooldowns: Date[] = [];

  acquire(job: Parameters<ExecutionCapacityController["acquire"]>[0]) {
    if (this.acquisition !== undefined) {
      return Promise.resolve(this.acquisition);
    }
    const lease: AcquiredCapacityLease = {
      leaseId: crypto.randomUUID(),
      scopeKeys: [`scope-${crypto.randomUUID()}`],
      expiresAt: new Date(Date.now() + 30_000),
      ownerId: "processor-test",
      jobId: job.jobId,
      leaseEpoch: job.leaseEpoch,
      units: job.capacityUnits,
      jobKey: `job-${job.jobId}`,
    };
    return Promise.resolve({ kind: "acquired" as const, lease });
  }

  acquireSubmissionPermit(
    _job: Parameters<ExecutionCapacityController["acquireSubmissionPermit"]>[0],
  ): Promise<SubmissionPermitResult> {
    return Promise.resolve(this.submissionPermit);
  }

  setProviderCooldown(
    _job: Parameters<ExecutionCapacityController["setProviderCooldown"]>[0],
    expiresAt: Date,
  ): Promise<void> {
    this.cooldowns.push(expiresAt);
    return Promise.resolve();
  }

  renew(
    _job: Parameters<ExecutionCapacityController["renew"]>[0],
    _lease: AcquiredCapacityLease,
  ): Promise<{ readonly ok: boolean; readonly expiresAt?: Date }> {
    return Promise.resolve(
      this.renewOk
        ? { ok: true, expiresAt: new Date(Date.now() + 30_000) }
        : { ok: false },
    );
  }

  release(
    _job: Parameters<ExecutionCapacityController["release"]>[0],
    _lease: AcquiredCapacityLease,
  ): Promise<void> {
    this.releaseCount += 1;
    return Promise.resolve();
  }
}

function processor(
  pool: DatabasePool,
  capacity: FakeCapacityController,
  handler: ConstructorParameters<typeof ExecutionProcessor>[3],
  heartbeatIntervalMs = 10_000,
  overrides: Partial<ExecutionProcessorOptions> = {},
): ExecutionProcessor {
  return new ExecutionProcessor(
    pool,
    capacity,
    {
      isReady: () => Promise.resolve(true),
      readyToken: () => Promise.resolve("ready:test"),
    },
    handler,
    {
      leaseOwner: "processor-test",
      leaseDurationMs: 30_000,
      heartbeatIntervalMs,
      coordinationRetryMs: 10,
      maxDeferralJitterMs: 0,
      maxExecutionAttempts: 3,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      retryJitterRatio: 0,
      maxRetryWaitMs: 1_000,
      ...overrides,
    },
  );
}

Deno.test({
  name: "capacity deferral completes without opening an execution attempt",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const capacity = new FakeCapacityController();
      capacity.acquisition = {
        kind: "deferred",
        reason: "global_tool_concurrency",
        retryAt: new Date(Date.now() + 10),
      };
      let handlerCalls = 0;
      const execution = processor(pool, capacity, () => {
        handlerCalls += 1;
        return Promise.resolve({ kind: "succeeded" });
      });

      assertEquals(await execution.process({ data: admitted.ticket }), {
        kind: "deferred",
      });
      const job = await pool.query<{
        status: string;
        attempt_count: number;
        deferral_count: number;
      }>(
        "select status, attempt_count, deferral_count from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      assertEquals(job.rows[0], {
        status: "queued",
        attempt_count: 0,
        deferral_count: 1,
      });
      assertEquals(handlerCalls, 0);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "submission cooldown deferral does not consume an execution attempt",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const capacity = new FakeCapacityController();
      capacity.submissionPermit = {
        kind: "deferred",
        reason: "provider_cooldown",
        retryAt: new Date(Date.now() + 10),
      };
      const execution = processor(
        pool,
        capacity,
        () => Promise.resolve({ kind: "succeeded" }),
      );

      assertEquals(await execution.process({ data: admitted.ticket }), {
        kind: "deferred",
      });
      const job = await pool.query<{
        attempt_count: number;
        deferral_count: number;
      }>(
        "select attempt_count, deferral_count from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      assertEquals(job.rows[0], { attempt_count: 0, deferral_count: 1 });
      assertEquals(capacity.releaseCount, 1);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "transient provider failure schedules a domain retry",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const capacity = new FakeCapacityController();
      const execution = processor(pool, capacity, () =>
        Promise.resolve({
          kind: "failed",
          retryClassification: "provider_transient",
          error: "temporary provider failure",
        }));

      assertEquals(await execution.process({ data: admitted.ticket }), {
        kind: "retry_scheduled",
      });
      const job = await pool.query<{
        status: string;
        attempt_count: number;
        deferral_count: number;
        dispatch_generation: number;
      }>(
        `select status, attempt_count, deferral_count, dispatch_generation
           from relay.execution_jobs where id = $1`,
        [admitted.jobId],
      );
      assertEquals(job.rows[0], {
        status: "queued",
        attempt_count: 1,
        deferral_count: 0,
        dispatch_generation: 1,
      });
      assertEquals(capacity.releaseCount, 1);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "retryable failure terminalizes after the configured attempt ceiling",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const capacity = new FakeCapacityController();
      const execution = processor(
        pool,
        capacity,
        () =>
          Promise.resolve({
            kind: "failed",
            retryClassification: "provider_transient",
            error: "still unavailable",
          }),
        10_000,
        { maxExecutionAttempts: 1 },
      );

      assertEquals(await execution.process({ data: admitted.ticket }), {
        kind: "failed",
      });
      const job = await pool.query<{
        status: string;
        attempt_count: number;
        dispatch_generation: number;
      }>(
        `select status, attempt_count, dispatch_generation
           from relay.execution_jobs where id = $1`,
        [admitted.jobId],
      );
      assertEquals(job.rows[0], {
        status: "failed",
        attempt_count: 1,
        dispatch_generation: 0,
      });
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "provider rate limiting records cooldown and schedules a retry",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const capacity = new FakeCapacityController();
      let retryAt: Date | undefined;
      const execution = processor(pool, capacity, () => {
        retryAt = new Date(Date.now() + 100);
        return Promise.resolve({
          kind: "failed",
          retryClassification: "provider_rate_limited" as const,
          retryAt,
          error: "retry later",
        });
      });

      assertEquals(await execution.process({ data: admitted.ticket }), {
        kind: "retry_scheduled",
      });
      assertEquals(capacity.cooldowns, [retryAt!]);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "handlers can durably record a provider operation before completion",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const capacity = new FakeCapacityController();
      const execution = processor(
        pool,
        capacity,
        async ({ recordProviderOperation }) => {
          await recordProviderOperation("provider-operation-123");
          return { kind: "succeeded" };
        },
      );

      assertEquals(await execution.process({ data: admitted.ticket }), {
        kind: "succeeded",
      });
      const attempt = await pool.query<{
        provider_operation_id: string | null;
        submission_state: string;
        outcome: string;
      }>(
        `select provider_operation_id, submission_state, outcome
           from relay.job_attempts where job_id = $1`,
        [admitted.jobId],
      );
      assertEquals(attempt.rows[0], {
        provider_operation_id: "provider-operation-123",
        submission_state: "completed",
        outcome: "succeeded",
      });
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "an outbox cancellation aborts an active handler before its heartbeat",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const capacity = new FakeCapacityController();
      let started: (() => void) | undefined;
      const handlerStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const execution = processor(
        pool,
        capacity,
        ({ signal }) =>
          new Promise((_, reject) => {
            started?.();
            signal.addEventListener(
              "abort",
              () => reject(new Error("cancelled")),
              { once: true },
            );
          }),
        60_000,
      );

      const processing = execution.process({ data: admitted.ticket });
      await handlerStarted;
      assertEquals(await requestJobCancellation(pool, admitted.jobId), {
        kind: "requested",
        running: true,
      });
      assertEquals(execution.abortJob(admitted.jobId), true);
      assertEquals(await processing, { kind: "cancelled" });

      const job = await pool.query<{ status: string }>(
        "select status from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      assertEquals(job.rows[0].status, "cancelled");
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "a running job is terminalized when its run deadline expires",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const capacity = new FakeCapacityController();
      let started: (() => void) | undefined;
      const handlerStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const execution = processor(
        pool,
        capacity,
        ({ signal }) =>
          new Promise((_, reject) => {
            started?.();
            signal.addEventListener(
              "abort",
              () => reject(new Error("deadline")),
              { once: true },
            );
          }),
        5,
      );

      const processing = execution.process({ data: admitted.ticket });
      await handlerStarted;
      await pool.query(
        `update relay.execution_jobs
            set run_deadline_at = now() - interval '1 second'
          where id = $1`,
        [admitted.jobId],
      );
      assertEquals(await processing, { kind: "failed" });

      const job = await pool.query<{ status: string }>(
        "select status from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      assertEquals(job.rows[0].status, "failed");
      assertEquals(capacity.releaseCount, 1);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "lost coordination preserves capacity until fenced recovery",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    let admitted: AdmittedJob | undefined;
    try {
      admitted = await admitJob(pool);
      const capacity = new FakeCapacityController();
      capacity.renewOk = false;
      const execution = processor(
        pool,
        capacity,
        ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("lost lease")),
              { once: true },
            );
          }),
        5,
      );

      assertEquals(await execution.process({ data: admitted.ticket }), {
        kind: "lost_lease",
      });
      assertEquals(capacity.releaseCount, 0);
      const lease = await pool.query<{ released_at: Date | null }>(
        "select released_at from relay.execution_capacity_leases where job_id = $1",
        [admitted.jobId],
      );
      assertEquals(lease.rows[0].released_at, null);
    } finally {
      if (admitted) await cleanupAdmissibleFixture(pool, admitted.fixture);
      await pool.end();
    }
  },
});
