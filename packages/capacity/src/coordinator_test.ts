import { assertEquals } from "@std/assert";
import { Redis } from "ioredis";
import { CapacityCoordinator } from "./coordinator.ts";

/**
 * Live-Redis tests, gated behind REDIS_URL like the rest of the repo
 * gates behind DATABASE_URL -- skipped, not failed, when it's absent.
 */
const REDIS_URL = Deno.env.get("REDIS_URL");

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
        // Coordination keys carry the hash tag `{capacity}`; every key
        // this test creates lands on the same slot, so KEYS is safe here.
        const keys = await redis.keys(`relay:${env}:*`);
        if (keys.length > 0) await redis.del(...keys);
        await redis.quit();
      }
    },
  });
}

withRedis(
  "acquireExecutionLease grants up to the limit then denies, all-or-none",
  async (redis, env) => {
    const coordinator = new CapacityCoordinator(redis, {
      env,
      leaseDurationMs: 30_000,
    });
    const scope = {
      toolKey: "image.generate",
      workspaceId: "ws-1",
      poolId: "pool-a",
    };
    const limits = {
      globalTool: 2,
      pool: 10,
      workspaceTotal: 10,
      workspaceTool: 10,
    };
    const now = Date.now();

    const first = await coordinator.acquireExecutionLease(scope, limits, now);
    const second = await coordinator.acquireExecutionLease(scope, limits, now);
    const third = await coordinator.acquireExecutionLease(scope, limits, now);

    assertEquals(first.ok, true);
    assertEquals(second.ok, true);
    assertEquals(third.ok, false);
    assertEquals(third.blockedScopeIndex, 0); // globalTool is scope index 0

    const counts = await coordinator.inspectCapacity(first.scopeKeys, now);
    assertEquals(counts[first.scopeKeys[0]], 2);
  },
);

withRedis(
  "a denial on a later scope does not consume capacity on an earlier scope",
  async (redis, env) => {
    const coordinator = new CapacityCoordinator(redis, {
      env,
      leaseDurationMs: 30_000,
    });
    const scope = {
      toolKey: "image.generate",
      workspaceId: "ws-1",
      poolId: "pool-a",
    };
    // workspaceTool (scope index 3) is the tight constraint; globalTool is generous.
    const limits = {
      globalTool: 100,
      pool: 100,
      workspaceTotal: 100,
      workspaceTool: 0,
    };
    const now = Date.now();

    const result = await coordinator.acquireExecutionLease(scope, limits, now);
    assertEquals(result.ok, false);
    assertEquals(result.blockedScopeIndex, 3);

    const counts = await coordinator.inspectCapacity(result.scopeKeys, now);
    assertEquals(
      counts[result.scopeKeys[0]],
      0,
      "globalTool must not have been consumed",
    );
    assertEquals(
      counts[result.scopeKeys[1]],
      0,
      "pool must not have been consumed",
    );
  },
);

withRedis(
  "renewExecutionLease extends expiry; release frees the slot",
  async (redis, env) => {
    const coordinator = new CapacityCoordinator(redis, {
      env,
      leaseDurationMs: 5_000,
    });
    const scope = {
      toolKey: "image.generate",
      workspaceId: "ws-1",
      poolId: "pool-a",
    };
    const limits = {
      globalTool: 1,
      pool: 1,
      workspaceTotal: 1,
      workspaceTool: 1,
    };
    const now = Date.now();

    const lease = await coordinator.acquireExecutionLease(scope, limits, now);
    assertEquals(lease.ok, true);

    const blocked = await coordinator.acquireExecutionLease(
      scope,
      limits,
      now + 1_000,
    );
    assertEquals(blocked.ok, false, "slot is occupied until release/expiry");

    const renewed = await coordinator.renewExecutionLease(
      lease.scopeKeys,
      lease.leaseId!,
      now + 2_000,
    );
    assertEquals(renewed.ok, true);

    await coordinator.releaseExecutionLease(lease.scopeKeys, lease.leaseId!);
    const afterRelease = await coordinator.acquireExecutionLease(
      scope,
      limits,
      now + 3_000,
    );
    assertEquals(
      afterRelease.ok,
      true,
      "release must free the slot immediately",
    );
  },
);

withRedis(
  "expired leases are purged and their slots reclaimed",
  async (redis, env) => {
    const coordinator = new CapacityCoordinator(redis, {
      env,
      leaseDurationMs: 100,
    });
    const scope = {
      toolKey: "image.generate",
      workspaceId: "ws-1",
      poolId: "pool-a",
    };
    const limits = {
      globalTool: 1,
      pool: 1,
      workspaceTotal: 1,
      workspaceTool: 1,
    };
    const now = Date.now();

    const lease = await coordinator.acquireExecutionLease(scope, limits, now);
    assertEquals(lease.ok, true);

    // Simulate time passing well beyond the 100ms lease duration without a renew.
    const afterExpiry = await coordinator.acquireExecutionLease(
      scope,
      limits,
      now + 5_000,
    );
    assertEquals(
      afterExpiry.ok,
      true,
      "an expired lease must not hold its slot forever",
    );
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
      emissionIntervalMs: 1_000,
      burstMs: 0,
      cost: 1,
    };
    const now = Date.now();

    const first = await coordinator.acquireSubmissionPermit(
      poolId,
      [check],
      now,
    );
    assertEquals(first.ok, true);

    const second = await coordinator.acquireSubmissionPermit(
      poolId,
      [check],
      now + 100,
    );
    assertEquals(second.ok, false);
    assertEquals(second.blockedReason, "rate");
    assertEquals(second.retryAfterMs! > 0, true);

    const thirdAfterInterval = await coordinator.acquireSubmissionPermit(
      poolId,
      [check],
      now + 1_000,
    );
    assertEquals(thirdAfterInterval.ok, true);
  },
);

withRedis(
  "setProviderCooldown blocks acquireSubmissionPermit and cannot be shortened",
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
    const now = Date.now();

    const extended = await coordinator.setProviderCooldown(
      poolId,
      now + 5_000,
      now,
    );
    assertEquals(extended, true);

    const duringCooldown = await coordinator.acquireSubmissionPermit(poolId, [
      check,
    ], now + 100);
    assertEquals(duringCooldown.ok, false);
    assertEquals(duringCooldown.blockedReason, "cooldown");

    // An older, shorter cooldown must not shrink the one already in effect.
    const shortened = await coordinator.setProviderCooldown(
      poolId,
      now + 1_000,
      now + 100,
    );
    assertEquals(shortened, false);

    const stillCoolingDown = await coordinator.acquireSubmissionPermit(
      poolId,
      [check],
      now + 2_000,
    );
    assertEquals(
      stillCoolingDown.ok,
      false,
      "shortened cooldown must not have taken effect",
    );
  },
);

withRedis("scripts survive SCRIPT FLUSH", async (redis, env) => {
  const coordinator = new CapacityCoordinator(redis, {
    env,
    leaseDurationMs: 5_000,
  });
  const scope = {
    toolKey: "image.generate",
    workspaceId: "ws-1",
    poolId: "pool-a",
  };
  const limits = {
    globalTool: 5,
    pool: 5,
    workspaceTotal: 5,
    workspaceTool: 5,
  };

  const before = await coordinator.acquireExecutionLease(scope, limits);
  assertEquals(before.ok, true);

  await redis.script("FLUSH");

  const after = await coordinator.acquireExecutionLease(scope, limits);
  assertEquals(after.ok, true);
});
