import { assert, assertEquals } from "@std/assert";
import { createDatabasePool } from "@relay/database";
import { createNotificationService } from "./service.ts";
import { createNotificationDeliveryLoop } from "./delivery.ts";
import { DeliveryError, type NotificationEmail } from "./smtp.ts";

const url = Deno.env.get("DATABASE_URL");
Deno.test({
  name:
    "notification opt-in, terminal trigger, durable retries, lease fencing and opt-out use PostgreSQL",
  ignore: !url || Deno.env.get("RUN_ARTIFACT_CONTRACT_TESTS") !== "1",
  fn: async () => {
    const pool = createDatabasePool({
      url: new URL(url!),
      poolMax: 5,
      connectTimeoutMs: 5000,
      statementTimeoutMs: 10000,
    }, "relay-worker");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const actorUserId = `notify-user-${suffix}`;
    const workspaceId = `notify-workspace-${suffix}`;
    const context = { workspaceId, actorUserId };
    const service = createNotificationService(pool, true);
    const config = {
      hostname: "localhost",
      port: 1025,
      security: "plain" as const,
      from: "relay@example.test",
      appOrigin: "http://localhost:8000",
    };
    const emails: NotificationEmail[] = [];
    let transient = true;
    const loop = createNotificationDeliveryLoop(pool, config, {
      send: (_config, email) => {
        emails.push(email);
        return transient
          ? Promise.reject(new DeliveryError("smtp_transient"))
          : Promise.resolve();
      },
    });
    try {
      await pool.query(
        'insert into auth."user" (id,name,email,"emailVerified") values($1,\'Notification test\',$2,true)',
        [actorUserId, `${suffix}@example.test`],
      );
      await pool.query(
        "insert into auth.organization(id,name,slug,\"createdAt\") values($1,'Notification test',$2,now())",
        [workspaceId, suffix],
      );
      await pool.query(
        'insert into auth.member(id,"organizationId","userId",role,"createdAt") values($1,$2,$3,\'owner\',now())',
        [suffix, workspaceId, actorUserId],
      );
      const version = (await pool.query(
        "select active_version_id from relay.tools where key='image.generate.gpt-image-2'",
      )).rows[0].active_version_id;
      const run = async (status: string) => {
        const id = `run_${crypto.randomUUID().replaceAll("-", "")}`;
        await pool.query(
          "insert into relay.tool_runs(id,workspace_id,tool_version_id,status,input,created_by) values($1,$2,$3,'queued','{}',$4)",
          [id, workspaceId, version, actorUserId],
        );
        await pool.query("update relay.tool_runs set status=$2 where id=$1", [
          id,
          status,
        ]);
        return id;
      };
      const state = await service.get(context);
      assert(state.kind === "ok");
      assertEquals(state.notifications.completed, false);
      assertEquals(
        await service.get({ ...context, actorUserId: "someone-else" }),
        { kind: "not_found" },
      );
      assertEquals(
        await createNotificationService(pool, false).update(context, {
          completed: true,
          failed: true,
        }),
        { kind: "not_configured" },
      );
      await run("succeeded");
      assertEquals(await loop.deliverOnce(), false);
      await service.update(context, { completed: true, failed: false });
      await run("failed");
      assertEquals(await loop.deliverOnce(), false);
      const runId = await run("succeeded");
      await pool.query(
        "update relay.tool_runs set status='succeeded' where id=$1",
        [runId],
      );
      assertEquals(
        (await pool.query(
          "select count(*)::int as count from relay.notification_deliveries where run_id=$1",
          [runId],
        )).rows[0].count,
        1,
      );
      assertEquals(await loop.deliverOnce(), true);
      const retry = (await pool.query(
        "select status,attempts,extract(epoch from available_at-now()) as wait from relay.notification_deliveries where run_id=$1",
        [runId],
      )).rows[0];
      assertEquals(retry.status, "retrying");
      assertEquals(retry.attempts, 1);
      assert(Number(retry.wait) > 55);
      assertEquals(await loop.deliverOnce(), false);
      transient = false;
      await pool.query(
        "update relay.notification_deliveries set available_at=now()-interval '1 second' where run_id=$1",
        [runId],
      );
      assertEquals(await loop.deliverOnce(), true);
      assertEquals(emails[0].messageId, emails[1].messageId);
      assertEquals(emails[1].to, `${suffix}@example.test`);
      assertEquals(
        emails[1].content.includes(`/dashboard/runs/${runId}`),
        true,
      );
      assertEquals(
        (await pool.query(
          "select status from relay.notification_deliveries where run_id=$1",
          [runId],
        )).rows[0].status,
        "sent",
      );
      const revoked = await run("succeeded");
      await service.update(context, { completed: false, failed: false });
      await service.update(context, { completed: true, failed: true });
      assertEquals(
        (await pool.query(
          "select status from relay.notification_deliveries where run_id=$1",
          [revoked],
        )).rows[0].status,
        "cancelled",
      );
      const concurrent = await run("failed");
      let sending!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => sending = resolve);
      const held = new Promise<void>((resolve) => release = resolve);
      const other = createNotificationDeliveryLoop(pool, config, {
        send: async () => {
          sending();
          await held;
        },
      });
      const delivery = other.deliverOnce();
      await started;
      assertEquals(await loop.deliverOnce(), false);
      release();
      await delivery;
      await other.stop();
      assertEquals(
        (await pool.query(
          "select attempts from relay.notification_deliveries where run_id=$1",
          [concurrent],
        )).rows[0].attempts,
        1,
      );
      const stale = await run("failed");
      let staleStarted!: () => void;
      let releaseStale!: () => void;
      const didStart = new Promise<void>((resolve) => staleStarted = resolve);
      const staleHeld = new Promise<void>((resolve) => releaseStale = resolve);
      const staleLoop = createNotificationDeliveryLoop(pool, config, {
        send: async () => {
          staleStarted();
          await staleHeld;
          throw new DeliveryError("smtp_transient");
        },
      });
      const staleAttempt = staleLoop.deliverOnce();
      await didStart;
      try {
        await pool.query(
          "update relay.notification_deliveries set lease_until=now()-interval '1 second' where run_id=$1",
          [stale],
        );
        assertEquals(await loop.deliverOnce(), true);
      } finally {
        releaseStale();
        await staleAttempt;
        await staleLoop.stop();
      }
      assertEquals(
        (await pool.query(
          "select status,attempts,failure_code from relay.notification_deliveries where run_id=$1",
          [stale],
        )).rows[0],
        { status: "sent", attempts: 2, failure_code: null },
      );
      const exhausted = await run("failed");
      await pool.query(
        "update relay.notification_deliveries set status='retrying',attempts=4,available_at=now() where run_id=$1",
        [exhausted],
      );
      transient = true;
      assertEquals(await loop.deliverOnce(), true);
      assertEquals(
        (await pool.query(
          "select status,attempts from relay.notification_deliveries where run_id=$1",
          [exhausted],
        )).rows[0],
        { status: "failed", attempts: 5 },
      );
      assertEquals(await loop.deliverOnce(), false);
      const permanent = await run("failed");
      const permanentLoop = createNotificationDeliveryLoop(pool, config, {
        send: () => Promise.reject(new DeliveryError("smtp_permanent")),
      });
      await permanentLoop.deliverOnce();
      await permanentLoop.stop();
      assertEquals(
        (await pool.query(
          "select status,attempts from relay.notification_deliveries where run_id=$1",
          [permanent],
        )).rows[0],
        { status: "failed", attempts: 1 },
      );
      const abandoned = await run("failed");
      await pool.query(
        "update relay.notification_deliveries set status='sending',attempts=1,lease_until=now()-interval '1 second' where run_id=$1",
        [abandoned],
      );
      await pool.query(
        'delete from auth.member where "organizationId"=$1 and "userId"=$2',
        [workspaceId, actorUserId],
      );
      assertEquals(await loop.deliverOnce(), false);
      assertEquals(
        (await pool.query(
          "select status from relay.notification_deliveries where run_id=$1",
          [abandoned],
        )).rows[0].status,
        "cancelled",
      );
    } finally {
      await loop.stop();
      await pool.query(
        "update relay.notification_deliveries set status='cancelled',lease_until=null where workspace_id=$1 and status in ('pending','retrying','sending')",
        [workspaceId],
      );
      // Immutable run history remains in this disposable integration database.
      await pool.end();
    }
  },
});
