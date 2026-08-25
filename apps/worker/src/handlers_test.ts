import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import {
  type AdmitRunInput,
  admitToolRun,
  armSchedulerTicket,
  claimJobForDispatch,
} from "@relay/queue";
import {
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
  TEST_USAGE_PORT,
} from "../../../packages/queue/src/test_support.ts";
import {
  createExecutionHandlerRegistry,
  createRegistryBackedExecutionHandler,
} from "./handlers.ts";

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

Deno.test("execution handler registry exposes exact catalog compatibility", () => {
  const registry = createExecutionHandlerRegistry([{
    key: "image.generate",
    inputSchemaVersion: 2,
    handlerVersion: "2026.09",
    execute: () => Promise.resolve({ kind: "succeeded" }),
  }]);
  assertEquals(
    registry.catalogHandlers.isCompatible("image.generate", {
      inputSchemaVersion: 2,
      handlerVersion: "2026.09",
    }),
    true,
  );
  assertEquals(registry.keys, new Set(["image.generate"]));
});

Deno.test({
  name:
    "registry-backed handler revalidates kill switches immediately before work",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);
    let handlerCalls = 0;
    const registry = createExecutionHandlerRegistry([{
      key: fixture.handlerKey,
      inputSchemaVersion: 1,
      handlerVersion: "1",
      execute: () => {
        handlerCalls += 1;
        return Promise.resolve({ kind: "succeeded" });
      },
    }]);
    try {
      const input: AdmitRunInput = {
        workspaceId: fixture.workspaceId,
        toolVersionId: fixture.toolVersionId,
        createdBy: fixture.createdBy,
        input: { prompt: "validate route" },
        idempotencyKey: `handler-${crypto.randomUUID()}`,
        admissionDeadlineMs: 60_000,
        runDeadlineMs: 300_000,
      };
      const admitted = await admitToolRun(pool, input, {
        handlers: registry.catalogHandlers,
        usage: TEST_USAGE_PORT,
      });
      if (admitted.kind !== "admitted") throw new Error("admission failed");
      const jobRow = await pool.query<{
        scheduling_policy_version: number;
      }>(
        "select scheduling_policy_version from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      const schedulerToken = `handler-scheduler.${admitted.jobId}`;
      await armSchedulerTicket(pool, admitted.jobId, 0, schedulerToken);
      const claim = await claimJobForDispatch(
        pool,
        {
          domainJobId: admitted.jobId,
          dispatchGeneration: 0,
          policyVersion: jobRow.rows[0].scheduling_policy_version,
          schedulerToken,
        },
        "handler-test",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("claim failed");

      const handler = createRegistryBackedExecutionHandler(pool, registry);
      const context = {
        job: claim.job,
        attempt: {
          attemptId: "1",
          attemptNumber: 1,
          providerIdempotencyKey: "provider-key",
        },
        signal: new AbortController().signal,
        recordProviderOperation: () => Promise.resolve(),
      };
      assertEquals(await handler(context), { kind: "succeeded" });
      assertEquals(handlerCalls, 1);

      await pool.query(
        "update relay.tool_provider_bindings set enabled = false where tool_version_id = $1",
        [fixture.toolVersionId],
      );
      const blocked = await handler(context);
      assertEquals(blocked.kind, "failed");
      if (blocked.kind === "failed") {
        assertEquals(blocked.retryClassification, "schema_or_policy_failure");
      }
      assertEquals(handlerCalls, 1);
    } finally {
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});

Deno.test({
  name: "removing a deployed handler fails closed without fake execution",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    const fixture = await createAdmissibleFixture(pool);
    let handlerCalls = 0;
    const registry = createExecutionHandlerRegistry([{
      key: fixture.handlerKey,
      inputSchemaVersion: 1,
      handlerVersion: "1",
      execute: () => {
        handlerCalls += 1;
        return Promise.resolve({ kind: "succeeded" });
      },
    }]);
    try {
      const admitted = await admitToolRun(
        pool,
        {
          workspaceId: fixture.workspaceId,
          toolVersionId: fixture.toolVersionId,
          createdBy: fixture.createdBy,
          input: {},
          idempotencyKey: `missing-handler-${crypto.randomUUID()}`,
          admissionDeadlineMs: 60_000,
          runDeadlineMs: 300_000,
        },
        {
          handlers: registry.catalogHandlers,
          usage: TEST_USAGE_PORT,
        },
      );
      if (admitted.kind !== "admitted") throw new Error("admission failed");
      registry.unregister(fixture.handlerKey);
      const jobRow = await pool.query<{ scheduling_policy_version: number }>(
        "select scheduling_policy_version from relay.execution_jobs where id = $1",
        [admitted.jobId],
      );
      const schedulerToken = `missing-handler-scheduler.${admitted.jobId}`;
      await armSchedulerTicket(pool, admitted.jobId, 0, schedulerToken);
      const claim = await claimJobForDispatch(
        pool,
        {
          domainJobId: admitted.jobId,
          dispatchGeneration: 0,
          policyVersion: jobRow.rows[0].scheduling_policy_version,
          schedulerToken,
        },
        "missing-handler-test",
        30_000,
      );
      if (claim.kind !== "claimed") throw new Error("claim failed");
      const result = await createRegistryBackedExecutionHandler(pool, registry)(
        {
          job: claim.job,
          attempt: {
            attemptId: "1",
            attemptNumber: 1,
            providerIdempotencyKey: "provider-key",
          },
          signal: new AbortController().signal,
          recordProviderOperation: () => Promise.resolve(),
        },
      );
      assertEquals(result.kind, "failed");
      assertEquals(handlerCalls, 0);
    } finally {
      await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});
