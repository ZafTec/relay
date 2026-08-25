import { assert, assertEquals, assertRejects } from "@std/assert";
import { Redis } from "ioredis";
import { CapacityCoordinator } from "./coordinator.ts";
import { cooldownKey, leaseMetadataKey } from "./keys.ts";

const REDIS_URL = Deno.env.get("REDIS_URL");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withRedis(
  name: string,
  fn: (redis: Redis, env: string) => Promise<void>,
) {
  Deno.test({
    name,
    ignore: REDIS_URL === undefined,
    fn: async () => {
      const redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
      const env = `test-${crypto.randomUUID()}`;
      try {
        await fn(redis, env);
      } finally {
        // Tests intentionally assume the same standalone Redis authority as the
        // production MVP. Every generated key is isolated by this unique env.
        const keys = await redis.keys(`relay:${env}:*`);
        if (keys.length > 0) await redis.del(...keys);
        await redis.quit();
      }
    },
  });
}

const scope = {
  toolKey: "image.generate",
  workspaceId: "ws-1",
  poolId: "pool-a",
} as const;

function limits(value: number) {
  return {
    globalTool: value,
    pool: value,
    workspaceTotal: value,
    workspaceTool: value,
  };
}

function leaseRequest(
  jobId: string,
  units: number,
  ownerId = "worker-a",
  leaseEpoch = 1,
) {
  return { jobId, units, ownerId, leaseEpoch };
}

withRedis(
  "weighted execution leases never overshoot under concurrent acquisition",
  async (redis, env) => {
    const coordinator = new CapacityCoordinator(redis, {
      env,
      leaseDurationMs: 30_000,
    });

    const attempts = await Promise.all(
      Array.from(
        { length: 12 },
        (_, index) =>
          coordinator.acquireExecutionLease(
            scope,
            limits(10),
            leaseRequest(`job-${index}`, 3),
          ),
      ),
    );
    const acquired = attempts.filter((result) => result.ok);
    assertEquals(acquired.length, 3);

    const first = acquired[0];
    assert(first.ok);
    const usage = await coordinator.inspectCapacity(first.lease.scopeKeys);
    for (const key of first.lease.scopeKeys) assertEquals(usage[key], 9);

    for (const denied of attempts.filter((result) => !result.ok)) {
      assertEquals(denied.reason, "capacity");
      if (denied.reason === "capacity") {
        assertEquals(denied.usedUnits, 9);
        assertEquals(denied.limit, 10);
      }
    }
  },
);

withRedis(
  "a weighted denial on a later scope consumes no earlier-scope units",
  async (redis, env) => {
    const coordinator = new CapacityCoordinator(redis, {
      env,
      leaseDurationMs: 30_000,
    });
    const result = await coordinator.acquireExecutionLease(
      scope,
      {
        globalTool: 100,
        pool: 100,
        workspaceTotal: 100,
        workspaceTool: 2,
      },
      leaseRequest("job-denied", 3),
    );

    assertEquals(result.ok, false);
    if (result.ok) throw new Error("expected capacity denial");
    assertEquals(result.reason, "capacity");
    if (result.reason === "capacity") assertEquals(result.blockedScopeIndex, 3);

    const usage = await coordinator.inspectCapacity(result.scopeKeys);
    for (const key of result.scopeKeys) assertEquals(usage[key], 0);
  },
);

withRedis(
  "owner, job, and epoch fencing rejects stale lease mutations",
  async (redis, env) => {
    const coordinator = new CapacityCoordinator(redis, {
      env,
      leaseDurationMs: 30_000,
    });
    const first = await coordinator.acquireExecutionLease(
      scope,
      limits(5),
      leaseRequest("job-fenced", 2, "worker-a", 7),
    );
    assert(first.ok);

    const duplicate = await coordinator.acquireExecutionLease(
      scope,
      limits(5),
      leaseRequest("job-fenced", 2, "worker-a", 7),
    );
    assert(duplicate.ok);
    assertEquals(duplicate.reused, true);
    assertEquals(duplicate.lease.leaseId, first.lease.leaseId);

    const competingOwner = await coordinator.acquireExecutionLease(
      scope,
      limits(5),
      leaseRequest("job-fenced", 2, "worker-b", 7),
    );
    assertEquals(competingOwner.ok, false);
    if (!competingOwner.ok) assertEquals(competingOwner.reason, "fenced");

    const replacement = await coordinator.acquireExecutionLease(
      scope,
      limits(5),
      leaseRequest("job-fenced", 2, "worker-b", 8),
    );
    assert(replacement.ok);
    assertEquals(replacement.reused, false);

    const usage = await coordinator.inspectCapacity(
      replacement.lease.scopeKeys,
    );
    for (const key of replacement.lease.scopeKeys) assertEquals(usage[key], 2);

    assertEquals(
      (await coordinator.renewExecutionLease(first.lease)).ok,
      false,
    );
    assertEquals(await coordinator.releaseExecutionLease(first.lease), false);

    const renewed = await coordinator.renewExecutionLease(replacement.lease);
    assert(renewed.ok);
    assertEquals(await coordinator.releaseExecutionLease(renewed.lease), true);
    const afterRelease = await coordinator.inspectCapacity(
      replacement.lease.scopeKeys,
    );
    for (const key of replacement.lease.scopeKeys) {
      assertEquals(afterRelease[key], 0);
    }
  },
);

withRedis(
  "lease scope, metadata, and fence keys expire without a cleanup caller",
  async (redis, env) => {
    const coordinator = new CapacityCoordinator(redis, {
      env,
      leaseDurationMs: 500,
    });
    const acquired = await coordinator.acquireExecutionLease(
      scope,
      limits(1),
      leaseRequest("job-expiring", 1),
    );
    assert(acquired.ok);

    for (const key of acquired.lease.scopeKeys) {
      assert((await redis.pttl(key)) > 0);
      assert((await redis.pttl(leaseMetadataKey(key))) > 0);
    }
    assert((await redis.pttl(acquired.lease.jobKey)) > 0);

    await sleep(750);
    for (const key of acquired.lease.scopeKeys) {
      assertEquals(await redis.exists(key), 0);
      assertEquals(await redis.exists(leaseMetadataKey(key)), 0);
    }
    assertEquals(await redis.exists(acquired.lease.jobKey), 0);
  },
);

withRedis(
  "renew extends a weighted lease and release immediately frees its units",
  async (redis, env) => {
    const coordinator = new CapacityCoordinator(redis, {
      env,
      leaseDurationMs: 250,
    });
    const acquired = await coordinator.acquireExecutionLease(
      scope,
      limits(2),
      leaseRequest("job-renew", 2),
    );
    assert(acquired.ok);

    await sleep(150);
    const renewed = await coordinator.renewExecutionLease(acquired.lease);
    assert(renewed.ok);
    await sleep(150);

    const blocked = await coordinator.acquireExecutionLease(
      scope,
      limits(2),
      leaseRequest("job-blocked", 1),
    );
    assertEquals(blocked.ok, false);

    assertEquals(await coordinator.releaseExecutionLease(renewed.lease), true);
    const afterRelease = await coordinator.acquireExecutionLease(
      scope,
      limits(2),
      leaseRequest("job-after-release", 2),
    );
    assertEquals(afterRelease.ok, true);
  },
);

withRedis(
  "acquireSubmissionPermit enforces GCRA rate and reports retryAfter",
  async (redis, env) => {
    const coordinator = new CapacityCoordinator(redis, {
      env,
      leaseDurationMs: 30_000,
    });
    const poolId = "pool-a";
    const check = {
      key: coordinator.rateKeys.tool("image.generate"),
      emissionIntervalMs: 300,
      burstMs: 0,
      cost: 1,
    };

    assertEquals(
      (await coordinator.acquireSubmissionPermit(poolId, [check])).ok,
      true,
    );
    const denied = await coordinator.acquireSubmissionPermit(poolId, [check]);
    assertEquals(denied.ok, false);
    assertEquals(denied.blockedReason, "rate");
    assert((denied.retryAfterMs ?? 0) > 0);

    await sleep(350);
    assertEquals(
      (await coordinator.acquireSubmissionPermit(poolId, [check])).ok,
      true,
    );
  },
);

withRedis(
  "provider cooldown is monotonic and expires on Redis time",
  async (redis, env) => {
    const coordinator = new CapacityCoordinator(redis, {
      env,
      leaseDurationMs: 30_000,
    });
    const poolId = "pool-a";
    const check = {
      key: coordinator.rateKeys.provider("openai/gpt-image-2"),
      emissionIntervalMs: 1,
      burstMs: 1_000,
      cost: 1,
    };

    assertEquals(await coordinator.setProviderCooldown(poolId, 400), true);
    const initialTtl = await redis.pttl(cooldownKey(env, poolId));
    assert(initialTtl > 0 && initialTtl <= 400);
    const during = await coordinator.acquireSubmissionPermit(poolId, [check]);
    assertEquals(during.blockedReason, "cooldown");
    assertEquals(await coordinator.setProviderCooldown(poolId, 100), false);

    await sleep(500);
    assertEquals(
      (await coordinator.acquireSubmissionPermit(poolId, [check])).ok,
      true,
    );
  },
);

withRedis("rate policy rejects invalid numeric inputs", async (redis, env) => {
  const coordinator = new CapacityCoordinator(redis, {
    env,
    leaseDurationMs: 30_000,
  });

  await assertRejects(
    () =>
      coordinator.acquireSubmissionPermit("pool-a", [{
        key: coordinator.rateKeys.tool("image.generate"),
        emissionIntervalMs: 0,
        burstMs: 0,
        cost: 1,
      }]),
    Error,
    "emissionIntervalMs",
  );
  await assertRejects(
    () =>
      coordinator.acquireSubmissionPermit("pool-a", [{
        key: coordinator.rateKeys.tool("image.generate"),
        emissionIntervalMs: 1,
        burstMs: -1,
        cost: 1,
      }]),
    Error,
    "burstMs",
  );
  await assertRejects(
    () =>
      coordinator.acquireSubmissionPermit("pool-a", [{
        key: coordinator.rateKeys.tool("image.generate"),
        emissionIntervalMs: 1,
        burstMs: 0,
        cost: Number.NaN,
      }]),
    Error,
    "cost",
  );
  await assertRejects(
    () => coordinator.setProviderCooldown("pool-a", 1.5),
    Error,
    "positive safe integer",
  );
  const duplicateKey = coordinator.rateKeys.tool("image.generate");
  await assertRejects(
    () =>
      coordinator.acquireSubmissionPermit("pool-a", [
        { key: duplicateKey, emissionIntervalMs: 1, burstMs: 0, cost: 1 },
        { key: duplicateKey, emissionIntervalMs: 2, burstMs: 0, cost: 1 },
      ]),
    Error,
    "must be unique",
  );
});

withRedis("weighted lease scripts survive SCRIPT FLUSH", async (redis, env) => {
  const coordinator = new CapacityCoordinator(redis, {
    env,
    leaseDurationMs: 5_000,
  });
  const before = await coordinator.acquireExecutionLease(
    scope,
    limits(5),
    leaseRequest("job-before-flush", 2),
  );
  assert(before.ok);

  await redis.script("FLUSH");

  const after = await coordinator.acquireExecutionLease(
    scope,
    limits(5),
    leaseRequest("job-after-flush", 3),
  );
  assertEquals(after.ok, true);
});
