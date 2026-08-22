import { assert, assertEquals, assertRejects } from "@std/assert";
import type { RuntimeConfig } from "@relay/config";
import type { DurableCapacityLease } from "@relay/queue";
import { Redis } from "ioredis";
import {
  type ClosableWorker,
  gracefullyCloseWorkers,
  restoreDurableRedisLease,
  startWorker,
} from "./worker.ts";

class FakeWorker implements ClosableWorker {
  paused = false;
  closeForce: boolean | undefined;

  pause(doNotWaitActive?: boolean): Promise<void> {
    this.paused = doNotWaitActive === true;
    return Promise.resolve();
  }

  close(force?: boolean): Promise<void> {
    this.closeForce = force;
    return Promise.resolve();
  }
}

Deno.test("graceful shutdown pauses intake and drains before non-forced close", async () => {
  const worker = new FakeWorker();
  let aborted = false;
  const result = await gracefullyCloseWorkers(
    [worker],
    () => Promise.resolve(),
    () => {
      aborted = true;
    },
    100,
  );
  assertEquals(result, { forced: false });
  assertEquals(worker.paused, true);
  assertEquals(worker.closeForce, false);
  assertEquals(aborted, false);
});

Deno.test("shutdown aborts active handlers and force-closes after its deadline", async () => {
  const worker = new FakeWorker();
  let aborted = false;
  const result = await gracefullyCloseWorkers(
    [worker],
    () => new Promise<void>(() => {}),
    () => {
      aborted = true;
    },
    5,
  );
  assertEquals(result, { forced: true });
  assertEquals(worker.paused, true);
  assertEquals(worker.closeForce, true);
  assertEquals(aborted, true);
});

Deno.test("shutdown budget includes a stuck pause operation", async () => {
  class StuckPauseWorker extends FakeWorker {
    override pause(): Promise<void> {
      return new Promise<void>(() => {});
    }
  }

  const worker = new StuckPauseWorker();
  let aborted = false;
  const startedAt = Date.now();
  const result = await gracefullyCloseWorkers(
    [worker],
    () => new Promise<void>(() => {}),
    () => {
      aborted = true;
    },
    20,
  );
  assertEquals(result, { forced: true });
  assertEquals(aborted, true);
  assert(Date.now() - startedAt < 500);
});

const redisUrl = Deno.env.get("REDIS_URL");

Deno.test({
  name: "capacity rehydration keeps a shared scope alive for its latest lease",
  ignore: redisUrl === undefined,
  fn: async () => {
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const environment = `worker-restore-${crypto.randomUUID()}`;
    const scopeKey = `relay:${environment}:{capacity}:active:tool:test`;
    const [seconds, microseconds] = await redis.time();
    const now = Number(seconds) * 1_000 +
      Math.floor(Number(microseconds) / 1_000);
    const lease = (
      jobId: string,
      redisLeaseId: string,
      expiresAt: number,
    ): DurableCapacityLease => ({
      databaseLeaseId: crypto.randomUUID(),
      redisLeaseId,
      redisScopeKeys: [scopeKey],
      expiresAt: new Date(expiresAt),
      ownerId: "worker-restore",
      jobId,
      leaseEpoch: 1,
      units: 1,
    });

    try {
      await restoreDurableRedisLease(
        redis,
        environment,
        lease("job-long", "lease-long", now + 10_000),
      );
      await restoreDurableRedisLease(
        redis,
        environment,
        lease("job-short", "lease-short", now + 5_000),
      );

      assert((await redis.pttl(scopeKey)) > 7_000);
      assertEquals(await redis.zcard(scopeKey), 2);
    } finally {
      const keys = await redis.keys(`relay:${environment}:*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    }
  },
});

Deno.test("worker refuses to start without an injected execution handler", async () => {
  const config: RuntimeConfig = {
    appName: "Relay",
    port: 8000,
    build: { version: "test", revision: "test" },
    database: {
      url: new URL("postgres://unused:unused@localhost/unused"),
      poolMax: 1,
      connectTimeoutMs: 1,
      statementTimeoutMs: 1,
    },
    redis: {
      url: new URL("redis://localhost:6379"),
      connectTimeoutMs: 1,
    },
  };
  await assertRejects(
    () => startWorker(config, { installSignalHandlers: false }),
    Error,
    "executionHandler is required",
  );
});
