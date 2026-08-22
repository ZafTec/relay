import { assertEquals } from "@std/assert";
import { Redis } from "ioredis";
import { CapacityCoordinator } from "./coordinator.ts";

/**
 * Live-Redis tests, gated behind REDIS_URL like the rest of the repo
 * gates behind DATABASE_URL -- skipped, not failed, when it's absent.
 *
 * These use real `sleep`s to observe expiry/rate-limit/cooldown behavior
 * rather than passing a simulated `nowMs` into the coordinator: the
 * scripts under test source "now" from Redis's own `TIME` command
 * internally (see leases.ts/rate-limit.ts/cooldown.ts), not from a
 * caller-supplied timestamp, precisely so worker clock skew can't affect
 * capacity accounting -- so there is no longer a way to simulate time
 * passing without actually waiting.
 */
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

    const first = await coordinator.acquireExecutionLease(scope, limits);
    const second = await coordinator.acquireExecutionLease(scope, limits);
    const third = await coordinator.acquireExecutionLease(scope, limits);

    assertEquals(first.ok, true);
    assertEquals(second.ok, true);
    assertEquals(third.ok, false);
    assertEquals(third.blockedScopeIndex, 0); // globalTool is scope index 0

    const counts = await coordinator.inspectCapacity(first.scopeKeys);
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

    const result = await coordinator.acquireExecutionLease(scope, limits);
    assertEquals(result.ok, false);
    assertEquals(result.blockedScopeIndex, 3);

    const counts = await coordinator.inspectCapacity(result.scopeKeys);
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
      leaseDurationMs: 300,
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

    const lease = await coordinator.acquireExecutionLease(scope, limits);
    assertEquals(lease.ok, true);

    const blocked = await coordinator.acquireExecutionLease(scope, limits);
    assertEquals(blocked.ok, false, "slot is occupied until release/expiry");

    // Renew before the 300ms lease expires -- proves renew actually
    // extends it, since the slot is still occupied well past the
    // original duration.
    await sleep(200);
    const renewed = await coordinator.renewExecutionLease(
      lease.scopeKeys,
      lease.leaseId!,
    );
    assertEquals(renewed.ok, true);

    await sleep(200);
    const stillBlocked = await coordinator.acquireExecutionLease(
      scope,
      limits,
    );
    assertEquals(
      stillBlocked.ok,
      false,
      "the renewed lease must still hold its slot past the original duration",
    );

    await coordinator.releaseExecutionLease(lease.scopeKeys, lease.leaseId!);
    const afterRelease = await coordinator.acquireExecutionLease(
      scope,
      limits,
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

    const lease = await coordinator.acquireExecutionLease(scope, limits);
    assertEquals(lease.ok, true);

    // Let the 100ms lease actually expire without a renew.
    await sleep(200);
    const afterExpiry = await coordinator.acquireExecutionLease(
      scope,
      limits,
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
      emissionIntervalMs: 300,
      burstMs: 0,
      cost: 1,
    };

    const first = await coordinator.acquireSubmissionPermit(poolId, [check]);
    assertEquals(first.ok, true);

    const second = await coordinator.acquireSubmissionPermit(poolId, [
      check,
    ]);
    assertEquals(second.ok, false);
    assertEquals(second.blockedReason, "rate");
    assertEquals(second.retryAfterMs! > 0, true);

    await sleep(350);
    const thirdAfterInterval = await coordinator.acquireSubmissionPermit(
      poolId,
      [check],
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

    const extended = await coordinator.setProviderCooldown(
      poolId,
      Date.now() + 400,
    );
    assertEquals(extended, true);

    const duringCooldown = await coordinator.acquireSubmissionPermit(poolId, [
      check,
    ]);
    assertEquals(duringCooldown.ok, false);
    assertEquals(duringCooldown.blockedReason, "cooldown");

    // An older, shorter cooldown must not shrink the one already in effect.
    const shortened = await coordinator.setProviderCooldown(
      poolId,
      Date.now() + 100,
    );
    assertEquals(shortened, false);

    const stillCoolingDown = await coordinator.acquireSubmissionPermit(
      poolId,
      [check],
    );
    assertEquals(
      stillCoolingDown.ok,
      false,
      "shortened cooldown must not have taken effect",
    );

    await sleep(500);
    const afterCooldown = await coordinator.acquireSubmissionPermit(poolId, [
      check,
    ]);
    assertEquals(
      afterCooldown.ok,
      true,
      "cooldown must actually expire once its real extended duration elapses",
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
