import { assertEquals } from "@std/assert";
import { createDatabasePool } from "@relay/database";
import { admitToolRun } from "@relay/queue";
import {
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
  TEST_USAGE_PORT,
} from "../../queue/src/test_support.ts";
import { PostgresRunReadService } from "./postgres/runs.ts";
import { PostgresArtifactReadService } from "./postgres/artifacts.ts";
import { createOverviewService } from "./overview.ts";

const url = Deno.env.get("DATABASE_URL");
Deno.test({
  name: "overview reports stored workspace activity and rejects another user",
  ignore: !url,
  fn: async () => {
    const pool = createDatabasePool({
      url: new URL(url!),
      poolMax: 5,
      connectTimeoutMs: 5000,
      statementTimeoutMs: 30000,
    }, "relay-api");
    let fixture:
      | Awaited<ReturnType<typeof createAdmissibleFixture>>
      | undefined;
    try {
      fixture = await createAdmissibleFixture(pool);
      const context = {
        workspaceId: fixture.workspaceId,
        actorUserId: fixture.createdBy,
      };
      const service = createOverviewService(
        pool,
        new PostgresRunReadService(pool),
        new PostgresArtifactReadService(pool),
      );
      const empty = await service.get(context);
      if (empty.kind !== "ok") throw new Error("Expected overview");
      assertEquals(empty.counts, {
        runs: 0,
        activeRuns: 0,
        failedRuns: 0,
        artifacts: 0,
      });
      const run = await admitToolRun(pool, {
        workspaceId: fixture.workspaceId,
        toolVersionId: fixture.toolVersionId,
        createdBy: fixture.createdBy,
        input: { prompt: "overview" },
        idempotencyKey: crypto.randomUUID(),
        admissionDeadlineMs: 60000,
        runDeadlineMs: 300000,
      }, { handlers: fixture.handlers, usage: TEST_USAGE_PORT });
      if (run.kind !== "admitted") throw new Error("Expected run admission");
      const populated = await service.get(context);
      if (populated.kind !== "ok") throw new Error("Expected overview");
      assertEquals(populated.counts, {
        runs: 1,
        activeRuns: 1,
        failedRuns: 0,
        artifacts: 0,
      });
      assertEquals(populated.recentRuns.items.map((item) => item.id), [
        run.runId,
      ]);
      assertEquals(
        await service.get({
          ...context,
          actorUserId: fixture.catalogActorIds[0],
        }),
        { kind: "not_found" },
      );
    } finally {
      if (fixture) await cleanupAdmissibleFixture(pool, fixture);
      await pool.end();
    }
  },
});
