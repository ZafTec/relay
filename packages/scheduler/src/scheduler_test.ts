import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Redis } from "ioredis";
import { type DispatchLease, WeightedFairScheduler } from "./scheduler.ts";
import type { SchedulingClassProfile } from "./profiles.ts";
import { schedulerKeys } from "./keys.ts";

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
      const env = `scheduler-test-${crypto.randomUUID()}`;
      try {
        await fn(redis, env);
      } finally {
        // The scheduler explicitly targets one standalone Redis authority.
        const keys = await redis.keys(`relay:${env}:*`);
        if (keys.length > 0) await redis.del(...keys);
        await redis.quit();
      }
    },
  });
}

function profiles(
  internalMaxShare = 0.25,
): readonly SchedulingClassProfile[] {
  return [
    {
      classKey: "standard",
      weight: 1,
      maxShare: null,
      enabled: true,
      policyVersion: 1,
    },
    {
      classKey: "paid",
      weight: 2,
      maxShare: null,
      enabled: true,
      policyVersion: 1,
    },
    {
      classKey: "enterprise",
      weight: 4,
      maxShare: null,
      enabled: true,
      policyVersion: 1,
    },
    {
      classKey: "internal",
      weight: 1,
      maxShare: internalMaxShare,
      enabled: true,
      policyVersion: 1,
    },
  ];
}

function scheduler(
  redis: Redis,
  env: string,
  dispatchLeaseDurationMs = 5_000,
): WeightedFairScheduler {
  return new WeightedFairScheduler(redis, {
    env,
    dispatchLeaseDurationMs,
    maxCostUnits: 10,
    idleDeficitCapUnits: 10,
    promotionBatchSize: 1_000,
    recoveryBatchSize: 1_000,
  });
}

async function claimRequired(
  scheduler: WeightedFairScheduler,
  ownerId = "scheduler-a",
): Promise<DispatchLease> {
  const result = await scheduler.claimNext(ownerId);
  assertEquals(result.kind, "leased");
  if (result.kind !== "leased") throw new Error("expected a dispatch lease");
  return result.lease;
}

withRedis(
  "scheduler rejects invalid numeric configuration, profiles, jobs, and leases",
  async (redis, env) => {
    assertThrows(
      () =>
        new WeightedFairScheduler(redis, {
          env,
          dispatchLeaseDurationMs: 1.5,
          maxCostUnits: 10,
        }),
      Error,
      "dispatchLeaseDurationMs",
    );
    assertThrows(
      () =>
        new WeightedFairScheduler(redis, {
          env,
          dispatchLeaseDurationMs: 1_000,
          maxCostUnits: 10,
          idleDeficitCapUnits: Number.NaN,
        }),
      Error,
      "idleDeficitCapUnits",
    );

    const fair = scheduler(redis, env);
    const invalidProfiles = profiles().map((profile) =>
      profile.classKey === "paid"
        ? { ...profile, weight: Number.POSITIVE_INFINITY }
        : profile
    );
    await assertRejects(
      () => fair.configureProfiles(invalidProfiles),
      Error,
      "Redis numeric precision",
    );
    await fair.configureProfiles(profiles());
    await assertRejects(
      () =>
        fair.enqueue({
          jobId: "invalid-cost",
          dispatchGeneration: 1,
          policyVersion: 1,
          classKey: "standard",
          workspaceId: "workspace-a",
          costUnits: Number.NaN,
          fifoSequence: 1,
          eligibleAtMs: 0,
        }),
      Error,
      "costUnits",
    );
  },
);

withRedis(
  "profile versions fence stale scheduler replicas",
  async (redis, env) => {
    const fair = scheduler(redis, env);
    await fair.configureProfiles(profiles());
    assertEquals(
      await fair.enqueue({
        jobId: "wrong-policy-version",
        dispatchGeneration: 1,
        policyVersion: 2,
        classKey: "standard",
        workspaceId: "workspace-a",
        costUnits: 1,
        fifoSequence: 1,
        eligibleAtMs: 0,
      }),
      { kind: "policy_mismatch", currentVersion: 1 },
    );

    const changedWithoutVersion = profiles().map((profile) =>
      profile.classKey === "paid" ? { ...profile, weight: 9 } : profile
    );
    await assertRejects(
      () => fair.configureProfiles(changedWithoutVersion),
      Error,
      "without a policy version bump",
    );

    const versionTwo = profiles().map((profile) => ({
      ...profile,
      policyVersion: 2,
    }));
    await fair.configureProfiles(versionTwo);
    await assertRejects(
      () => fair.configureProfiles(profiles()),
      Error,
      "stale scheduler profile",
    );

    assertEquals(
      await fair.enqueue({
        jobId: "admitted-under-version-one",
        dispatchGeneration: 1,
        policyVersion: 1,
        classKey: "standard",
        workspaceId: "workspace-a",
        costUnits: 1,
        fifoSequence: 2,
        eligibleAtMs: 0,
      }),
      { kind: "enqueued" },
      "an older durable admission remains valid under the current policy",
    );
    const oldAdmission = await claimRequired(fair);
    assertEquals(oldAdmission.policyVersion, 1);
    assertEquals(await fair.acknowledgeDispatch(oldAdmission), true);
  },
);

withRedis(
  "identical configuration is a no-op and policy changes wait for active dispatches",
  async (redis, env) => {
    const fair = scheduler(redis, env);
    await fair.configureProfiles(profiles());
    for (let index = 0; index < 2; index++) {
      await fair.enqueue({
        jobId: `configuration-job-${index}`,
        dispatchGeneration: 1,
        policyVersion: 1,
        classKey: "paid",
        workspaceId: "workspace-a",
        costUnits: 1,
        fifoSequence: index,
        eligibleAtMs: 0,
      });
    }

    const active = await claimRequired(fair);
    const before = await fair.inspectState();
    assertEquals(before.turnFunded, true);
    assertEquals(before.reservedDeficits.paid, 1);

    await fair.configureProfiles(profiles());
    assertEquals(await fair.inspectState(), before);

    const changed = profiles().map((profile) => ({
      ...profile,
      policyVersion: 2,
      weight: profile.classKey === "paid" ? 3 : profile.weight,
    }));
    await assertRejects(
      () => fair.configureProfiles(changed),
      Error,
      "dispatch leases are active",
    );
    assertEquals(await fair.acknowledgeDispatch(active), true);
    await fair.configureProfiles(changed);
  },
);

withRedis(
  "weighted classes converge to 1:2:4 without starving a positive-weight class",
  async (redis, env) => {
    const fair = scheduler(redis, env);
    await fair.configureProfiles(profiles());

    await Promise.all(
      (["standard", "paid", "enterprise"] as const).flatMap((classKey) =>
        Array.from({ length: 80 }, (_, index) =>
          fair.enqueue({
            jobId: `${classKey}-${String(index).padStart(3, "0")}`,
            dispatchGeneration: 1,
            policyVersion: 1,
            classKey,
            workspaceId: `${classKey}-workspace`,
            costUnits: 1,
            fifoSequence: index,
            eligibleAtMs: 0,
          }))
      ),
    );

    const counts = { standard: 0, paid: 0, enterprise: 0, internal: 0 };
    for (let index = 0; index < 140; index++) {
      const lease = await claimRequired(fair);
      counts[lease.classKey]++;
      assertEquals(await fair.acknowledgeDispatch(lease), true);
    }

    assertEquals(counts, {
      standard: 20,
      paid: 40,
      enterprise: 80,
      internal: 0,
    });
  },
);

withRedis(
  "workspaces round-robin while jobs remain FIFO within each workspace",
  async (redis, env) => {
    const fair = scheduler(redis, env);
    await fair.configureProfiles(profiles());
    const jobs = [
      ["a-1", "workspace-a", 1],
      ["a-2", "workspace-a", 3],
      ["a-3", "workspace-a", 5],
      ["b-1", "workspace-b", 2],
      ["b-2", "workspace-b", 4],
      ["b-3", "workspace-b", 6],
    ] as const;
    for (const [jobId, workspaceId, fifoSequence] of jobs) {
      assertEquals(
        (await fair.enqueue({
          jobId,
          workspaceId,
          fifoSequence,
          dispatchGeneration: 1,
          policyVersion: 1,
          classKey: "standard",
          costUnits: 1,
          eligibleAtMs: 0,
        })).kind,
        "enqueued",
      );
    }

    const order: string[] = [];
    for (let index = 0; index < jobs.length; index++) {
      const lease = await claimRequired(fair);
      order.push(lease.jobId);
      assertEquals(await fair.acknowledgeDispatch(lease), true);
    }
    assertEquals(order, ["a-1", "b-1", "a-2", "b-2", "a-3", "b-3"]);
  },
);

withRedis(
  "idle deficit stays capped and a maximum-cost job eventually runs",
  async (redis, env) => {
    const fair = scheduler(redis, env);
    await fair.configureProfiles(profiles());

    for (let index = 0; index < 30; index++) {
      await fair.enqueue({
        jobId: `enterprise-idle-${index}`,
        workspaceId: "enterprise-workspace",
        fifoSequence: index,
        dispatchGeneration: 1,
        policyVersion: 1,
        classKey: "enterprise",
        costUnits: 1,
        eligibleAtMs: 0,
      });
    }
    for (let index = 0; index < 10; index++) {
      const lease = await claimRequired(fair);
      assertEquals(await fair.acknowledgeDispatch(lease), true);
    }
    const idleState = await fair.inspectState();
    assertEquals(idleState.deficits.standard, 0);

    await fair.enqueue({
      jobId: "standard-max-cost",
      workspaceId: "standard-workspace",
      fifoSequence: 1,
      dispatchGeneration: 1,
      policyVersion: 1,
      classKey: "standard",
      costUnits: 10,
      eligibleAtMs: 0,
    });

    let seen = false;
    for (let index = 0; index < 50 && !seen; index++) {
      const lease = await claimRequired(fair);
      seen = lease.jobId === "standard-max-cost";
      assertEquals(await fair.acknowledgeDispatch(lease), true);
    }
    assertEquals(seen, true);
    const finalState = await fair.inspectState();
    for (const deficit of Object.values(finalState.deficits)) {
      assert(deficit <= 10);
    }
  },
);

withRedis(
  "internal traffic cannot exceed its hard share while customers are backlogged",
  async (redis, env) => {
    const fair = scheduler(redis, env);
    const configured = profiles(0.25).map((profile) =>
      profile.classKey === "internal" ? { ...profile, weight: 20 } : profile
    );
    await fair.configureProfiles(configured);

    await Promise.all(
      (["standard", "internal"] as const).flatMap((classKey) =>
        Array.from({ length: 80 }, (_, index) =>
          fair.enqueue({
            jobId: `${classKey}-share-${String(index).padStart(3, "0")}`,
            workspaceId: `${classKey}-workspace`,
            fifoSequence: index,
            dispatchGeneration: 1,
            policyVersion: 1,
            classKey,
            costUnits: 1,
            eligibleAtMs: 0,
          }))
      ),
    );

    let internal = 0;
    let total = 0;
    for (let index = 0; index < 40; index++) {
      const lease = await claimRequired(fair);
      total += lease.costUnits;
      if (lease.classKey === "internal") internal += lease.costUnits;
      assertEquals(await fair.acknowledgeDispatch(lease), true);
      assert(
        internal <= total * 0.25 + 0.000000001,
        "internal share exceeded its hard cap while standard remained backlogged",
      );
    }
    assertEquals(internal, 10);
  },
);

withRedis(
  "fairness accounting commits on acknowledgement and rolls back on release",
  async (redis, env) => {
    const fair = scheduler(redis, env);
    await fair.configureProfiles(profiles(0.25));
    await fair.enqueue({
      jobId: "customer-publication",
      dispatchGeneration: 1,
      policyVersion: 1,
      classKey: "standard",
      workspaceId: "customer-workspace",
      costUnits: 3,
      fifoSequence: 1,
      eligibleAtMs: 0,
    });
    await fair.enqueue({
      jobId: "customer-backlog",
      dispatchGeneration: 1,
      policyVersion: 1,
      classKey: "standard",
      workspaceId: "customer-workspace",
      costUnits: 10,
      fifoSequence: 2,
      eligibleAtMs: 0,
    });
    await fair.enqueue({
      jobId: "internal-publication",
      dispatchGeneration: 1,
      policyVersion: 1,
      classKey: "internal",
      workspaceId: "internal-workspace",
      costUnits: 1,
      fifoSequence: 1,
      eligibleAtMs: 0,
    });

    const failedCustomerPublish = await claimRequired(fair);
    assertEquals(failedCustomerPublish.jobId, "customer-publication");
    let state = await fair.inspectState();
    assertEquals(state.reservedDeficits.standard, 3);
    assertEquals(state.internalCredit, 0);
    assertEquals(await fair.releaseDispatchLease(failedCustomerPublish), true);
    state = await fair.inspectState();
    assertEquals(state.reservedDeficits.standard, 0);
    assertEquals(state.internalCredit, 0);

    const publishedCustomer = await claimRequired(fair);
    assertEquals(publishedCustomer.jobId, "customer-publication");
    assertEquals(await fair.acknowledgeDispatch(publishedCustomer), true);
    state = await fair.inspectState();
    assertEquals(state.internalCredit, 1);

    const failedInternalPublish = await claimRequired(fair);
    assertEquals(failedInternalPublish.jobId, "internal-publication");
    state = await fair.inspectState();
    assertEquals(state.internalReservedCredit, 1);
    assertEquals(await fair.releaseDispatchLease(failedInternalPublish), true);
    state = await fair.inspectState();
    assertEquals(state.internalReservedCredit, 0);
    assertEquals(state.internalCredit, 1);

    const publishedInternal = await claimRequired(fair);
    assertEquals(await fair.acknowledgeDispatch(publishedInternal), true);
    state = await fair.inspectState();
    assertEquals(state.internalCredit, 0);
    assertEquals(state.internalReservedCredit, 0);
  },
);

withRedis(
  "customer acknowledgement does not bank internal credit without internal backlog",
  async (redis, env) => {
    const fair = scheduler(redis, env);
    await fair.configureProfiles(profiles(0.25));
    await fair.enqueue({
      jobId: "customer",
      dispatchGeneration: 1,
      policyVersion: 1,
      classKey: "standard",
      workspaceId: "customer-workspace",
      costUnits: 3,
      fifoSequence: 1,
      eligibleAtMs: 0,
    });
    await fair.enqueue({
      jobId: "internal-removed",
      dispatchGeneration: 1,
      policyVersion: 1,
      classKey: "internal",
      workspaceId: "internal-workspace",
      costUnits: 1,
      fifoSequence: 1,
      eligibleAtMs: 0,
    });

    const customer = await claimRequired(fair);
    assertEquals(customer.jobId, "customer");
    assertEquals(await fair.removeJob("internal-removed", 1), true);
    assertEquals(await fair.acknowledgeDispatch(customer), true);
    assertEquals((await fair.inspectState()).internalCredit, 0);
  },
);

withRedis(
  "terminal tombstones reject delayed events while dispatched jobs allow a newer generation",
  async (redis, env) => {
    const fair = scheduler(redis, env);
    await fair.configureProfiles(profiles());
    const cancelled = {
      jobId: "cancelled-before-ready",
      dispatchGeneration: 3,
      policyVersion: 1,
      classKey: "standard" as const,
      workspaceId: "workspace-a",
      costUnits: 1,
      fifoSequence: 1,
      eligibleAtMs: 0,
    };

    assertEquals(await fair.removeJob(cancelled.jobId, 3), true);
    assertEquals(await fair.enqueue(cancelled), {
      kind: "terminal",
      currentGeneration: 3,
    });
    assertEquals(await fair.enqueue({ ...cancelled, dispatchGeneration: 4 }), {
      kind: "terminal",
      currentGeneration: 3,
    });

    const dispatched = {
      ...cancelled,
      jobId: "dispatched",
      dispatchGeneration: 1,
    };
    assertEquals((await fair.enqueue(dispatched)).kind, "enqueued");
    const lease = await claimRequired(fair);
    assertEquals(await fair.acknowledgeDispatch(lease), true);
    assertEquals((await fair.enqueue(dispatched)).kind, "duplicate");
    assertEquals(
      (await fair.enqueue({ ...dispatched, dispatchGeneration: 2 })).kind,
      "enqueued",
    );
    const newer = await claimRequired(fair);
    assertEquals(await fair.acknowledgeDispatch(newer), true);

    const activeCancellation = {
      ...cancelled,
      jobId: "cancelled-while-dispatching",
      dispatchGeneration: 7,
    };
    assertEquals((await fair.enqueue(activeCancellation)).kind, "enqueued");
    const cancelledLease = await claimRequired(fair);
    assertEquals(await fair.removeJob(activeCancellation.jobId, 7), true);
    assertEquals(await fair.acknowledgeDispatch(cancelledLease), false);
    assertEquals(
      (await fair.inspectState()).reservedDeficits.standard,
      0,
    );
    assertEquals(
      (await fair.enqueue({ ...activeCancellation, dispatchGeneration: 8 }))
        .kind,
      "terminal",
    );
  },
);

withRedis(
  "concurrent scheduler replicas lease each job at most once",
  async (redis, env) => {
    const secondRedis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    try {
      const first = scheduler(redis, env);
      const second = scheduler(secondRedis, env);
      await first.configureProfiles(profiles());
      await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          first.enqueue({
            jobId: `replica-job-${String(index).padStart(2, "0")}`,
            workspaceId: `workspace-${index % 3}`,
            fifoSequence: index,
            dispatchGeneration: 1,
            policyVersion: 1,
            classKey: "paid",
            costUnits: 1,
            eligibleAtMs: 0,
          })),
      );

      const claims = await Promise.all(
        Array.from(
          { length: 24 },
          (_, index) =>
            (index % 2 === 0 ? first : second).claimNext(
              `scheduler-${index % 2}`,
            ),
        ),
      );
      const leased = claims.flatMap((result) =>
        result.kind === "leased" ? [result.lease] : []
      );
      assertEquals(leased.length, 24);
      assertEquals(new Set(leased.map((lease) => lease.jobId)).size, 24);
      assertEquals((await first.claimNext("scheduler-a")).kind, "empty");
    } finally {
      await secondRedis.quit();
    }
  },
);

withRedis(
  "an expired dispatch lease is recovered after a scheduler crash",
  async (redis, env) => {
    const secondRedis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    try {
      const first = scheduler(redis, env, 100);
      const recovered = scheduler(secondRedis, env, 1_000);
      await first.configureProfiles(profiles());
      await first.enqueue({
        jobId: "crash-recovery-job",
        workspaceId: "workspace-a",
        fifoSequence: 1,
        dispatchGeneration: 4,
        policyVersion: 1,
        classKey: "standard",
        costUnits: 1,
        eligibleAtMs: 0,
      });

      const abandoned = await claimRequired(first, "scheduler-crashed");
      const keys = schedulerKeys(env);
      assertEquals(await redis.pttl(keys.dispatch), -1);
      assertEquals(await redis.pttl(keys.dispatchMetadata), -1);
      await sleep(250);
      const replacement = await claimRequired(recovered, "scheduler-recovery");
      assertEquals(replacement.jobId, abandoned.jobId);
      assert(replacement.leaseId !== abandoned.leaseId);
      assertEquals(
        (await recovered.inspectState()).reservedDeficits.standard,
        1,
        "recovery must roll back the expired reservation before reserving again",
      );

      assertEquals(await first.acknowledgeDispatch(abandoned), false);
      assertEquals(await recovered.acknowledgeDispatch(replacement), true);
      assertEquals(
        (await recovered.inspectState()).reservedDeficits.standard,
        0,
      );
      assertEquals(
        (await recovered.claimNext("scheduler-recovery")).kind,
        "empty",
      );
    } finally {
      await secondRedis.quit();
    }
  },
);
