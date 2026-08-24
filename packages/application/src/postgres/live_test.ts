import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import { admitToolRun } from "@relay/queue";
import {
  cleanupAdmissibleFixture,
  createAdmissibleFixture,
  TEST_USAGE_PORT,
} from "../../../queue/src/test_support.ts";
import { PostgresArtifactReadService } from "./artifacts.ts";
import { PostgresWorkspaceEventService } from "./events.ts";
import {
  PostgresRunCancellationService,
  PostgresRunReadService,
} from "./runs.ts";
import { PostgresToolService } from "./tools.ts";
import { PostgresUsageService } from "./usage.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");

function testPool(): DatabasePool {
  return createDatabasePool(
    {
      url: new URL(databaseUrl!),
      poolMax: 5,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
    },
    "relay-api",
  );
}

Deno.test({
  name:
    "application services enforce membership and stable run cursors against PostgreSQL",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const pool = testPool();
    let fixture:
      | Awaited<ReturnType<typeof createAdmissibleFixture>>
      | undefined;
    try {
      fixture = await createAdmissibleFixture(pool);
      const context = {
        workspaceId: fixture.workspaceId,
        actorUserId: fixture.createdBy,
      };
      await pool.query(
        "update relay.tools set lifecycle = 'published' where id = $1",
        [fixture.toolId],
      );
      const admit = (label: string) =>
        admitToolRun(
          pool,
          {
            workspaceId: fixture!.workspaceId,
            toolVersionId: fixture!.toolVersionId,
            createdBy: fixture!.createdBy,
            input: { prompt: label },
            idempotencyKey: `application-${crypto.randomUUID()}`,
            admissionDeadlineMs: 60_000,
            runDeadlineMs: 300_000,
          },
          { handlers: fixture!.handlers, usage: TEST_USAGE_PORT },
        );
      const first = await admit("first");
      const second = await admit("second");
      if (first.kind !== "admitted" || second.kind !== "admitted") {
        throw new Error("fixture admission failed");
      }
      await pool.query(
        `update relay.tool_runs
            set accepted_at = case id
              when $1 then '2026-08-24T10:00:00.000Z'::timestamptz
              when $2 then '2026-08-24T10:01:00.000Z'::timestamptz
            end
          where id = any($3::text[])`,
        [first.runId, second.runId, [first.runId, second.runId]],
      );

      const reads = new PostgresRunReadService(pool);
      const firstPage = await reads.list(context, { cursor: null, limit: 1 });
      assertEquals(firstPage.kind, "ok");
      if (firstPage.kind !== "ok") throw new Error("run list failed");
      assertEquals(firstPage.items[0].id, second.runId);
      assertEquals(firstPage.nextCursor === null, false);

      const concurrent = await admit("concurrent");
      if (concurrent.kind !== "admitted") {
        throw new Error("concurrent fixture admission failed");
      }
      await pool.query(
        "update relay.tool_runs set accepted_at = '2026-08-24T10:02:00.000Z' where id = $1",
        [concurrent.runId],
      );
      const secondPage = await reads.list(context, {
        cursor: firstPage.nextCursor,
        limit: 1,
      });
      assertEquals(secondPage.kind, "ok");
      if (secondPage.kind !== "ok") throw new Error("second run page failed");
      assertEquals(secondPage.items[0].id, first.runId);

      const outsider = await reads.get(
        {
          workspaceId: fixture.workspaceId,
          actorUserId: fixture.catalogActorIds[0],
        },
        second.runId,
      );
      assertEquals(outsider, { kind: "not_found" });

      const cancellation = new PostgresRunCancellationService(pool);
      const deniedCancellation = await cancellation.cancel(
        {
          workspaceId: fixture.workspaceId,
          actorUserId: fixture.catalogActorIds[0],
        },
        second.runId,
      );
      assertEquals(deniedCancellation, { kind: "not_found" });
      const cancelled = await cancellation.cancel(context, second.runId);
      assertEquals(cancelled.kind, "cancelled");

      const tools = new PostgresToolService(pool, fixture.handlers);
      const listedTools = await tools.list(context, {
        cursor: null,
        limit: 25,
      });
      assertEquals(listedTools.kind, "ok");
      if (listedTools.kind !== "ok" || listedTools.items.length === 0) {
        throw new Error("tool list did not expose the available fixture");
      }
      assertEquals(
        (await tools.get(context, listedTools.items[0].key)).kind,
        "found",
      );

      const artifacts = new PostgresArtifactReadService(pool);
      assertEquals(
        await artifacts.list(context, { cursor: null, limit: 25 }),
        { kind: "ok", items: [], nextCursor: null },
      );
      assertEquals(
        await artifacts.get(
          context,
          "art_0123456789abcdef0123456789abcdef",
        ),
        { kind: "not_found" },
      );

      const usage = new PostgresUsageService(
        pool,
        () => new Date("2026-08-24T10:03:00.000Z"),
      );
      assertEquals(await usage.getSummary(context, {}), {
        kind: "ok",
        usage: {
          generatedAt: "2026-08-24T10:03:00.000Z",
          items: [],
          truncated: false,
        },
      });

      const events = await new PostgresWorkspaceEventService(pool).list(
        context,
        { cursor: null, limit: 25 },
      );
      assertEquals(events.kind, "ok");
    } finally {
      if (fixture !== undefined) {
        await pool.query(
          "update relay.tools set lifecycle = 'internal' where id = $1",
          [fixture.toolId],
        );
        await cleanupAdmissibleFixture(pool, fixture);
      }
      await pool.end();
    }
  },
});
