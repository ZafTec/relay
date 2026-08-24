import { assertEquals, assertRejects } from "@std/assert";
import pg from "pg";
import {
  type AdmissionReservationInput,
  reserveUsageForAdmission,
} from "./admission.ts";
import { adjustCustomerUsage } from "./adjustments.ts";
import { can, limit } from "./entitlements.ts";
import { recordProviderCostEvent } from "./provider-costs.ts";
import {
  commitUsageReservation,
  expireUsageReservation,
  expireUsageReservations,
  releaseUsageReservation,
} from "./reservations.ts";
import {
  type MeteringTransaction,
  withMeteringTransaction,
} from "./transaction.ts";
import type { MeteringQueryExecutor } from "./types.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const hasDatabase = databaseUrl !== undefined;

type PgPool = InstanceType<typeof pg.Pool>;

interface LiveFixture {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly operatorSessionId: string;
  readonly staleOperatorSessionId: string;
  readonly nonAdminSessionId: string;
  readonly toolVersionId: string;
  readonly providerId: string;
  readonly providerModelId: string;
  readonly capacityPoolId: string;
  readonly bindingId: string;
}

const METER_POLICY_FIXTURE = {
  schemaVersion: 1,
  metric: "fixture.compute_units",
  unit: "fixture_unit",
  period: "calendar_month",
  estimate: {
    base: "0.000000000",
    terms: [{ measure: "requested_units", rate: "1.000000000" }],
  },
  reservation: { multiplier: "1.000000000", minimum: "0.000000000" },
  settlement: {
    success: "commit_actual",
    partial_output: "commit_actual",
    validation_rejected: "release",
    safety_rejected: "commit_actual",
    provider_failure: "release",
    cancelled: "release",
    timed_out: "release",
    storage_failure: "commit_actual",
  },
} as const;

const PRICING_POLICY_FIXTURE = {
  schemaVersion: 1,
  currency: "TST",
  rates: [
    {
      measure: "fixture_tokens",
      unit: "token",
      pricePerUnit: "0.250000000",
    },
  ],
  minimumCost: "0.000000000",
} as const;

function appPool(): PgPool {
  return new pg.Pool({
    connectionString: databaseUrl!,
    max: 5,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
}

async function inTransaction<T>(
  pool: PgPool,
  operation: (transaction: MeteringTransaction) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const result = await withMeteringTransaction(
        client as unknown as MeteringQueryExecutor,
        operation,
      );
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

function unique(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function createFixture(limitAmount: string): Promise<LiveFixture> {
  const ownerUrl = new URL(databaseUrl!);
  ownerUrl.username = "relay_migrator";
  ownerUrl.password = "relay_dev_only";
  const client = new pg.Client({ connectionString: ownerUrl.toString() });
  await client.connect();
  await client.query("begin");
  try {
    await client.query("set local role relay_owner");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const actorUserId = `user_meter_${suffix}`;
    const nonAdminUserId = `user_meter_non_admin_${suffix}`;
    const operatorSessionId = `session_meter_${suffix}`;
    const staleOperatorSessionId = `session_meter_stale_${suffix}`;
    const nonAdminSessionId = `session_meter_non_admin_${suffix}`;
    const workspaceId = `org_meter_${suffix}`;
    const toolId = `tool_meter_${suffix}`;
    const toolVersionId = `tver_meter_${suffix}`;
    const meterPolicyId = `meter_policy_${suffix}`;
    const pricingPolicyId = `pricing_policy_${suffix}`;

    await client.query(
      `insert into auth."user" (id, name, email, "emailVerified")
       values ($1, 'Meter fixture', $2, true),
              ($3, 'Meter non-admin fixture', $4, true)`,
      [
        actorUserId,
        `${suffix}@metering.example`,
        nonAdminUserId,
        `non-admin-${suffix}@metering.example`,
      ],
    );
    await client.query(
      `insert into auth."session" (
         id, "expiresAt", token, "createdAt", "updatedAt", "userId",
         "activeOrganizationId"
       ) values
         ($1, now() + interval '1 hour', $2, now(), now(), $3, $4),
         ($5, now() + interval '1 hour', $6, now() - interval '1 hour',
          now() - interval '1 hour', $3, $4),
         ($7, now() + interval '1 hour', $8, now(), now(), $9, $4)`,
      [
        operatorSessionId,
        `token_${operatorSessionId}`,
        actorUserId,
        workspaceId,
        staleOperatorSessionId,
        `token_${staleOperatorSessionId}`,
        nonAdminSessionId,
        `token_${nonAdminSessionId}`,
        nonAdminUserId,
      ],
    );
    await client.query(
      `insert into relay.system_role_assignments
         (user_id, role, granted_by)
       values ($1, 'superadmin', $1)`,
      [actorUserId],
    );
    await client.query(
      `insert into auth.organization (id, name, slug, "createdAt")
       values ($1, 'Meter fixture', $2, now())`,
      [workspaceId, `meter-${suffix}`],
    );
    await client.query(
      `insert into auth.member
         (id, "organizationId", "userId", role, "createdAt")
       values ($1, $2, $3, 'owner', now())`,
      [`member_meter_${suffix}`, workspaceId, actorUserId],
    );
    await client.query(
      `insert into relay.meter_policies
         (id, policy_key, revision, document, effective_at)
       values ($1, $2, 1, $3, now() - interval '1 second')`,
      [
        meterPolicyId,
        `fixture.meter.${suffix}`,
        JSON.stringify(METER_POLICY_FIXTURE),
      ],
    );
    await client.query(
      `insert into relay.pricing_policies
         (id, policy_key, revision, document, effective_at)
       values ($1, $2, 1, $3, now() - interval '1 second')`,
      [
        pricingPolicyId,
        `fixture.pricing.${suffix}`,
        JSON.stringify(PRICING_POLICY_FIXTURE),
      ],
    );
    await client.query(
      `insert into relay.tools
         (id, key, name, lifecycle, visibility)
       values ($1, $2, 'Meter fixture', 'internal', 'internal')`,
      [toolId, `fixture.tool.${suffix}`],
    );
    await client.query(
      `insert into relay.tool_versions (
         id, tool_id, version, input_schema, output_schema, handler_key,
         input_schema_version, handler_version, execution_mode,
         max_duration_seconds, meter_policy_id, entitlement_key,
         compatibility_metadata, published_at, immutable_hash
       ) values (
         $1, $2, 1, '{}', '{}', 'fixture.meter', 1, '1', 'async', 60,
         $3, 'tools.execute.fixture', null, now(),
         relay.compute_tool_version_immutable_hash(
           $1, $2, 1, '{}', '{}', 'fixture.meter', 1, '1', 'async', 60,
           $3, 'tools.execute.fixture', null
         )
       )`,
      [toolVersionId, toolId, meterPolicyId],
    );
    await client.query(
      `update relay.tools
          set lifecycle = 'published', active_version_id = $2
        where id = $1`,
      [toolId, toolVersionId],
    );
    const provider = await client.query<{ id: string }>(
      `insert into relay.providers (key, name, lifecycle)
       values ($1, 'Meter fixture', 'published')
       returning id::text`,
      [`fixture.provider.${suffix}`],
    );
    const model = await client.query<{ id: string }>(
      `insert into relay.provider_models
         (provider_id, key, display_name, pricing_policy_id, lifecycle)
       values ($1, $2, 'Meter fixture', $3, 'published')
       returning id::text`,
      [provider.rows[0].id, `fixture.model.${suffix}`, pricingPolicyId],
    );
    const pool = await client.query<{ id: string }>(
      `insert into relay.capacity_pools
         (key, provider_model_id, execution_class)
       values ($1, $2, 'standard')
       returning id::text`,
      [`fixture.pool.${suffix}`, model.rows[0].id],
    );
    const binding = await client.query<{ id: string }>(
      `insert into relay.tool_provider_bindings
         (tool_version_id, provider_model_id, capacity_pool_id, routing_order)
       values ($1, $2, $3, 1)
       returning id::text`,
      [toolVersionId, model.rows[0].id, pool.rows[0].id],
    );
    await client.query(
      `insert into relay.entitlement_grants (
         id, workspace_id, entitlement_key, grant_kind, capability_enabled,
         source_kind, source_reference, effective_at
       ) values (
         $1, $2, 'tools.execute.fixture', 'capability', true,
         'manual', 'live-test-fixture', now() - interval '1 second'
       )`,
      [`grant_cap_${suffix}`, workspaceId],
    );
    await client.query(
      `insert into relay.entitlement_grants (
         id, workspace_id, entitlement_key, grant_kind, limit_amount, unit,
         period, source_kind, source_reference, effective_at
       ) values (
         $1, $2, 'fixture.compute_units', 'limit', $3, 'fixture_unit',
         'calendar_month', 'manual', 'live-test-fixture',
         now() - interval '1 second'
       )`,
      [`grant_limit_${suffix}`, workspaceId, limitAmount],
    );
    await client.query("commit");
    return {
      workspaceId,
      actorUserId,
      operatorSessionId,
      staleOperatorSessionId,
      nonAdminSessionId,
      toolVersionId,
      providerId: provider.rows[0].id,
      providerModelId: model.rows[0].id,
      capacityPoolId: pool.rows[0].id,
      bindingId: binding.rows[0].id,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

function reservationInput(
  fixture: LiveFixture,
  amount: string,
  idempotencyKey: string = unique("reserve"),
): AdmissionReservationInput {
  return {
    actorUserId: fixture.actorUserId,
    workspaceId: fixture.workspaceId,
    toolVersionId: fixture.toolVersionId,
    providerModelId: fixture.providerModelId,
    measures: {
      requested_units: {
        minimum: amount,
        expected: amount,
        maximum: amount,
      },
    },
    idempotencyKey,
    reservationTtlSeconds: 300,
  };
}

async function createRunWithRoutingDecision(
  transaction: MeteringTransaction,
  fixture: LiveFixture,
  runId: string,
  reservationId: string | null = null,
): Promise<string> {
  await transaction.query(
    `insert into relay.tool_runs
       (id, workspace_id, tool_version_id, status, input, reservation_id,
        created_by, terminal_at)
     values ($1, $2, $3, 'succeeded', '{}', $4, $5, now())`,
    [
      runId,
      fixture.workspaceId,
      fixture.toolVersionId,
      reservationId,
      fixture.actorUserId,
    ],
  );
  const decision = await transaction.query<{ id: string }>(
    `insert into relay.routing_decisions
       (tool_run_id, selected_binding_id, provider_id, provider_model_id)
     values ($1, $2, $3, $4)
     returning id::text`,
    [
      runId,
      fixture.bindingId,
      fixture.providerId,
      fixture.providerModelId,
    ],
  );
  return decision.rows[0].id;
}

async function createAttempt(
  transaction: MeteringTransaction,
  fixture: LiveFixture,
  runId: string,
  routingDecisionId: string,
): Promise<string> {
  const job = await transaction.query<{ id: string }>(
    `insert into relay.execution_jobs (
       run_id, workspace_id, tool_version_id, capacity_pool_id, status,
       scheduling_class, scheduling_policy_version, estimated_cost_units,
       terminal_at
     ) values ($1, $2, $3, $4, 'failed', 'standard', 1, 1, now())
     returning id::text`,
    [
      runId,
      fixture.workspaceId,
      fixture.toolVersionId,
      fixture.capacityPoolId,
    ],
  );
  const attempt = await transaction.query<{ id: string }>(
    `insert into relay.job_attempts (
       job_id, attempt_number, lease_epoch, submission_state,
       provider_idempotency_key, routing_decision_id
     ) values ($1, 1, 1, 'pending', $2, $3)
     returning id::text`,
    [job.rows[0].id, unique("provider_attempt"), routingDecisionId],
  );
  return attempt.rows[0].id;
}

Deno.test({
  name: "transaction scope rejects an autocommit pool",
  ignore: !hasDatabase,
  sanitizeResources: false,
  fn: async () => {
    const pool = appPool();
    let callbackRan = false;
    try {
      await assertRejects(
        () =>
          withMeteringTransaction(
            pool as unknown as MeteringQueryExecutor,
            () => {
              callbackRan = true;
              return Promise.resolve();
            },
          ),
        Error,
        "SAVEPOINT can only be used in transaction blocks",
      );
      assertEquals(callbackRan, false);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "concurrent PostgreSQL reservations cannot overspend one allowance",
  ignore: !hasDatabase,
  sanitizeResources: false,
  fn: async () => {
    const fixture = await createFixture("10");
    const poolA = appPool();
    const poolB = appPool();
    try {
      const [left, right] = await Promise.all([
        inTransaction(
          poolA,
          (tx) => reserveUsageForAdmission(tx, reservationInput(fixture, "6")),
        ),
        inTransaction(
          poolB,
          (tx) => reserveUsageForAdmission(tx, reservationInput(fixture, "6")),
        ),
      ]);
      assertEquals(
        [left.kind, right.kind].sort(),
        ["allowance_exceeded", "reserved"],
      );
      const winner = left.kind === "reserved" ? left : right;
      if (winner.kind !== "reserved") throw new Error("missing winner");

      const reservationSnapshot = await poolA.query<{
        base: string;
        multiplier: string;
      }>(
        `select meter_policy_snapshot #>> '{estimate,base}' as base,
                meter_policy_snapshot #>> '{reservation,multiplier}' as multiplier
           from relay.usage_reservations
          where workspace_id = $1 and id = $2`,
        [fixture.workspaceId, winner.reservation.reservationId],
      );
      assertEquals(reservationSnapshot.rows[0], {
        base: "0.000000000",
        multiplier: "1.000000000",
      });

      const bucket = await poolA.query<{
        consumed_amount: string;
        reserved_amount: string;
      }>(
        `select consumed_amount, reserved_amount
           from relay.usage_buckets
          where workspace_id = $1 and metric_key = 'fixture.compute_units'`,
        [fixture.workspaceId],
      );
      assertEquals(bucket.rows[0], {
        consumed_amount: "0.000000000",
        reserved_amount: "6.000000000",
      });

      const releaseInput = {
        workspaceId: fixture.workspaceId,
        reservationId: winner.reservation.reservationId,
        idempotencyKey: unique("release"),
        outcome: "provider_failure" as const,
      };
      const [released, releaseReplay] = await Promise.all([
        inTransaction(
          poolA,
          (tx) => releaseUsageReservation(tx, releaseInput),
        ),
        inTransaction(
          poolB,
          (tx) => releaseUsageReservation(tx, releaseInput),
        ),
      ]);
      assertEquals(
        [released.kind, releaseReplay.kind].sort(),
        ["released", "replayed"],
      );

      const second = await inTransaction(
        poolA,
        (tx) => reserveUsageForAdmission(tx, reservationInput(fixture, "4")),
      );
      if (second.kind !== "reserved") throw new Error("second reserve failed");
      const commitInput = {
        workspaceId: fixture.workspaceId,
        reservationId: second.reservation.reservationId,
        idempotencyKey: unique("commit"),
        outcome: "success" as const,
        actualAmount: "3",
      };
      const commitResults = await Promise.all([
        inTransaction(
          poolA,
          (tx) => commitUsageReservation(tx, commitInput),
        ),
        inTransaction(
          poolB,
          (tx) => commitUsageReservation(tx, commitInput),
        ),
      ]);
      assertEquals(
        commitResults.map((result) => result.kind).sort(),
        ["committed", "replayed"],
      );
      const committed = commitResults.find((result) =>
        result.kind === "committed"
      );
      if (
        committed?.kind !== "committed" ||
        committed.receipt.usageEventId === null
      ) {
        throw new Error("usage event was not committed");
      }

      const adjustmentRequest = {
        workspaceId: fixture.workspaceId,
        usageEventId: committed.receipt.usageEventId,
        quantityDelta: "-1",
        reason: "fixture correction",
      };
      assertEquals(
        await inTransaction(
          poolA,
          (tx) =>
            adjustCustomerUsage(tx, {
              ...adjustmentRequest,
              operatorSessionId: fixture.staleOperatorSessionId,
              idempotencyKey: unique("stale-adjust"),
            }),
        ),
        { kind: "reauthentication_required" },
      );
      assertEquals(
        await inTransaction(
          poolA,
          (tx) =>
            adjustCustomerUsage(tx, {
              ...adjustmentRequest,
              operatorSessionId: fixture.nonAdminSessionId,
              idempotencyKey: unique("non-admin-adjust"),
            }),
        ),
        { kind: "denied" },
      );
      const crossWorkspaceAdjustment = await inTransaction(
        poolA,
        (tx) =>
          adjustCustomerUsage(tx, {
            ...adjustmentRequest,
            operatorSessionId: fixture.operatorSessionId,
            workspaceId: `org_other_${crypto.randomUUID()}`,
            idempotencyKey: unique("cross-workspace-adjust"),
          }),
      );
      assertEquals(crossWorkspaceAdjustment, { kind: "not_found" });

      const adjustmentInput = {
        ...adjustmentRequest,
        operatorSessionId: fixture.operatorSessionId,
        idempotencyKey: unique("adjust"),
        requestId: unique("request"),
        traceId: unique("trace"),
      };
      const adjusted = await inTransaction(
        poolA,
        (tx) => adjustCustomerUsage(tx, adjustmentInput),
      );
      const adjustmentReplay = await inTransaction(
        poolB,
        (tx) => adjustCustomerUsage(tx, adjustmentInput),
      );
      assertEquals(adjusted.kind, "adjusted");
      assertEquals(adjustmentReplay.kind, "replayed");
      if (adjusted.kind !== "adjusted") {
        throw new Error("usage adjustment was not recorded");
      }
      assertEquals(adjusted.receipt.adjustedByUserId, fixture.actorUserId);

      const otherUsageReservation = await inTransaction(
        poolA,
        (tx) => reserveUsageForAdmission(tx, reservationInput(fixture, "4")),
      );
      if (otherUsageReservation.kind !== "reserved") {
        throw new Error("second usage event reservation failed");
      }
      const otherUsage = await inTransaction(
        poolA,
        (tx) =>
          commitUsageReservation(tx, {
            workspaceId: fixture.workspaceId,
            reservationId: otherUsageReservation.reservation.reservationId,
            idempotencyKey: unique("second-usage"),
            outcome: "success",
            actualAmount: "4",
          }),
      );
      assertEquals(otherUsage.kind, "committed");

      const belowOriginalEvent = await inTransaction(
        poolA,
        (tx) =>
          adjustCustomerUsage(tx, {
            ...adjustmentRequest,
            operatorSessionId: fixture.operatorSessionId,
            idempotencyKey: unique("below-original-event"),
            quantityDelta: "-3",
          }),
      );
      assertEquals(belowOriginalEvent, { kind: "would_make_usage_negative" });

      await assertRejects(
        () =>
          inTransaction(poolA, async (tx) => {
            const rolledBack = await adjustCustomerUsage(tx, {
              ...adjustmentRequest,
              operatorSessionId: fixture.operatorSessionId,
              idempotencyKey: unique("rolled-back-adjustment"),
              quantityDelta: "1",
            });
            assertEquals(rolledBack.kind, "adjusted");
            throw new Error("force adjustment transaction rollback");
          }),
        Error,
        "force adjustment transaction rollback",
      );

      const finalBucket = await poolA.query<{
        consumed_amount: string;
        reserved_amount: string;
      }>(
        `select consumed_amount, reserved_amount
           from relay.usage_buckets
          where workspace_id = $1 and metric_key = 'fixture.compute_units'`,
        [fixture.workspaceId],
      );
      assertEquals(finalBucket.rows[0], {
        consumed_amount: "6.000000000",
        reserved_amount: "0.000000000",
      });
      const ledgerCounts = await poolA.query<{
        usage_count: string;
        adjustment_count: string;
        adjustment_audit_count: string;
      }>(
        `select
           (select count(*) from relay.usage_events where workspace_id = $1)
             as usage_count,
           (select count(*) from relay.usage_adjustments where workspace_id = $1)
             as adjustment_count,
           (select count(*) from relay.audit_events
             where workspace_id = $1 and action = 'metering.usage.adjust')
             as adjustment_audit_count`,
        [fixture.workspaceId],
      );
      assertEquals(ledgerCounts.rows[0], {
        usage_count: "2",
        adjustment_count: "1",
        adjustment_audit_count: "2",
      });
      await assertRejects(
        () =>
          poolA.query(
            "update relay.usage_events set quantity = quantity where id = $1",
            [committed.receipt.usageEventId],
          ),
        Error,
      );
      await assertRejects(
        () =>
          poolA.query(
            "delete from relay.usage_adjustments where id = $1",
            [adjusted.receipt.adjustmentId],
          ),
        Error,
      );
      await assertRejects(
        () =>
          poolA.query(
            `update relay.usage_reservations
                set finalized_at = finalized_at
              where workspace_id = $1 and id = $2`,
            [fixture.workspaceId, committed.receipt.reservationId],
          ),
        Error,
        "terminal usage reservations are immutable",
      );

      const ownerUrl = new URL(databaseUrl!);
      ownerUrl.username = "relay_migrator";
      ownerUrl.password = "relay_dev_only";
      const owner = new pg.Client({ connectionString: ownerUrl.toString() });
      await owner.connect();
      await owner.query("begin");
      try {
        await owner.query("set local role relay_owner");
        await assertRejects(
          () =>
            owner.query(
              "update relay.usage_events set quantity = quantity where id = $1",
              [committed.receipt.usageEventId],
            ),
          Error,
          "immutable",
        );
      } finally {
        await owner.query("rollback");
        await owner.end();
      }
    } finally {
      await poolA.end();
      await poolB.end();
    }
  },
});

Deno.test({
  name:
    "concurrent duplicate reservation requests charge one bucket exactly once",
  ignore: !hasDatabase,
  sanitizeResources: false,
  fn: async () => {
    const fixture = await createFixture("6");
    const poolA = appPool();
    const poolB = appPool();
    try {
      const input = reservationInput(fixture, "6", unique("same-reserve"));
      const [left, right] = await Promise.all([
        inTransaction(poolA, (tx) => reserveUsageForAdmission(tx, input)),
        inTransaction(poolB, (tx) => reserveUsageForAdmission(tx, input)),
      ]);
      assertEquals([left.kind, right.kind].sort(), ["replayed", "reserved"]);
      const rows = await poolA.query<{
        reservation_count: string;
        reserved_amount: string;
      }>(
        `select count(reservation.id) as reservation_count,
                max(bucket.reserved_amount) as reserved_amount
           from relay.usage_buckets bucket
           left join relay.usage_reservations reservation
             on reservation.bucket_id = bucket.id
          where bucket.workspace_id = $1
          group by bucket.id`,
        [fixture.workspaceId],
      );
      assertEquals(rows.rows[0], {
        reservation_count: "1",
        reserved_amount: "6.000000000",
      });
    } finally {
      await poolA.end();
      await poolB.end();
    }
  },
});

Deno.test({
  name: "expiry and expiry-triggered finalization replay exactly once",
  ignore: !hasDatabase,
  sanitizeResources: false,
  fn: async () => {
    const fixture = await createFixture("10");
    const sweepFixture = await createFixture("10");
    const poolA = appPool();
    const poolB = appPool();
    try {
      const expiring = await inTransaction(
        poolA,
        (tx) =>
          reserveUsageForAdmission(tx, {
            ...reservationInput(fixture, "2"),
            reservationTtlSeconds: 1,
          }),
      );
      if (expiring.kind !== "reserved") {
        throw new Error("expiring reservation was not created");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_250));

      const expiryInput = {
        workspaceId: fixture.workspaceId,
        reservationId: expiring.reservation.reservationId,
        idempotencyKey: unique("expire"),
      };
      const expiryResults = await Promise.all([
        inTransaction(
          poolA,
          (tx) => expireUsageReservation(tx, expiryInput),
        ),
        inTransaction(
          poolB,
          (tx) => expireUsageReservation(tx, expiryInput),
        ),
      ]);
      assertEquals(
        expiryResults.map((result) => result.kind).sort(),
        ["expired", "replayed"],
      );

      const autoExpiring = await inTransaction(
        poolA,
        (tx) =>
          reserveUsageForAdmission(tx, {
            ...reservationInput(fixture, "3"),
            reservationTtlSeconds: 1,
          }),
      );
      if (autoExpiring.kind !== "reserved") {
        throw new Error("auto-expiring reservation was not created");
      }

      const sweepReservationIds: string[] = [];
      for (
        const target of [fixture, sweepFixture, sweepFixture, fixture]
      ) {
        const reserved = await inTransaction(
          poolA,
          (tx) =>
            reserveUsageForAdmission(tx, {
              ...reservationInput(target, "1"),
              reservationTtlSeconds: 1,
            }),
        );
        if (reserved.kind !== "reserved") {
          throw new Error("sweeper reservation was not created");
        }
        sweepReservationIds.push(reserved.reservation.reservationId);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_250));

      const commitInput = {
        workspaceId: fixture.workspaceId,
        reservationId: autoExpiring.reservation.reservationId,
        idempotencyKey: unique("expired-commit"),
        outcome: "success" as const,
        actualAmount: "1",
      };
      const expiredByCommit = await inTransaction(
        poolA,
        (tx) => commitUsageReservation(tx, commitInput),
      );
      const expiredCommitReplay = await inTransaction(
        poolB,
        (tx) => commitUsageReservation(tx, commitInput),
      );
      assertEquals(expiredByCommit.kind, "expired");
      assertEquals(expiredCommitReplay.kind, "replayed");

      const sweepResults = await Promise.all([
        inTransaction(poolA, (tx) => expireUsageReservations(tx, 2)),
        inTransaction(poolB, (tx) => expireUsageReservations(tx, 2)),
      ]);
      assertEquals(
        sweepResults.reduce((total, result) => total + result.expired, 0),
        4,
      );
      const swept = await poolA.query<{ count: string }>(
        `select count(*)::text
           from relay.usage_reservations
          where id = any($1::text[]) and status = 'expired'`,
        [sweepReservationIds],
      );
      assertEquals(swept.rows[0].count, "4");

      const aggregate = await poolA.query<{
        consumed_amount: string;
        reserved_amount: string;
        usage_count: string;
      }>(
        `select bucket.consumed_amount, bucket.reserved_amount,
                count(event.id)::text as usage_count
           from relay.usage_buckets bucket
           left join relay.usage_events event on event.bucket_id = bucket.id
          where bucket.workspace_id = $1
            and bucket.metric_key = 'fixture.compute_units'
          group by bucket.id`,
        [fixture.workspaceId],
      );
      assertEquals(aggregate.rows, [{
        consumed_amount: "0.000000000",
        reserved_amount: "0.000000000",
        usage_count: "0",
      }]);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  },
});

Deno.test({
  name: "workspace APIs and admission are non-disclosing across workspaces",
  ignore: !hasDatabase,
  sanitizeResources: false,
  fn: async () => {
    const fixture = await createFixture("10");
    const otherFixture = await createFixture("10");
    const pool = appPool();
    try {
      const outsider = `user_outside_${crypto.randomUUID()}`;
      const capabilityInput = {
        actorUserId: outsider,
        capability: "tools.execute.fixture",
      };
      assertEquals(
        await can(pool as unknown as MeteringQueryExecutor, {
          ...capabilityInput,
          workspaceId: fixture.workspaceId,
        }),
        await can(pool as unknown as MeteringQueryExecutor, {
          ...capabilityInput,
          workspaceId: `org_missing_${crypto.randomUUID()}`,
        }),
      );
      const limitInput = {
        actorUserId: outsider,
        metric: "fixture.compute_units",
      };
      assertEquals(
        await limit(pool as unknown as MeteringQueryExecutor, {
          ...limitInput,
          workspaceId: fixture.workspaceId,
        }),
        await limit(pool as unknown as MeteringQueryExecutor, {
          ...limitInput,
          workspaceId: `org_missing_${crypto.randomUUID()}`,
        }),
      );
      const actual = await inTransaction(
        pool,
        (tx) =>
          reserveUsageForAdmission(tx, {
            ...reservationInput(fixture, "1"),
            actorUserId: outsider,
          }),
      );
      const missing = await inTransaction(
        pool,
        (tx) =>
          reserveUsageForAdmission(tx, {
            ...reservationInput(fixture, "1"),
            actorUserId: outsider,
            workspaceId: `org_missing_${crypto.randomUUID()}`,
          }),
      );
      assertEquals(actual, { kind: "workspace_unavailable" });
      assertEquals(missing, actual);

      const reserved = await inTransaction(
        pool,
        (tx) => reserveUsageForAdmission(tx, reservationInput(fixture, "1")),
      );
      if (reserved.kind !== "reserved") {
        throw new Error("workspace-isolation reservation was not created");
      }
      const releaseInput = {
        reservationId: reserved.reservation.reservationId,
        idempotencyKey: unique("workspace-release"),
        outcome: "provider_failure" as const,
      };
      await assertRejects(
        () =>
          pool.query(
            `insert into relay.tool_runs
               (id, workspace_id, tool_version_id, status, input,
                reservation_id, created_by)
             values ($1, $2, $3, 'queued', '{}', $4, $5)`,
            [
              unique("cross_workspace_run"),
              otherFixture.workspaceId,
              fixture.toolVersionId,
              reserved.reservation.reservationId,
              otherFixture.actorUserId,
            ],
          ),
        Error,
        "does not match its workspace and tool version",
      );
      await assertRejects(
        () =>
          pool.query(
            `insert into relay.tool_runs
               (id, workspace_id, tool_version_id, status, input,
                reservation_id, created_by)
             values ($1, $2, $3, 'queued', '{}', $4, $5)`,
            [
              unique("wrong_tool_run"),
              fixture.workspaceId,
              otherFixture.toolVersionId,
              reserved.reservation.reservationId,
              fixture.actorUserId,
            ],
          ),
        Error,
        "does not match its workspace and tool version",
      );

      const validRunId = unique("metered_run");
      await inTransaction(
        pool,
        (tx) =>
          createRunWithRoutingDecision(
            tx,
            fixture,
            validRunId,
            reserved.reservation.reservationId,
          ),
      );
      const linked = await pool.query<{
        reservation_provider_model_id: string;
        route_provider_model_id: string;
      }>(
        `select reservation.provider_model_id::text
                  as reservation_provider_model_id,
                decision.provider_model_id::text as route_provider_model_id
           from relay.tool_runs run
           join relay.usage_reservations reservation
             on reservation.id = run.reservation_id
           join relay.routing_decisions decision on decision.tool_run_id = run.id
          where run.id = $1`,
        [validRunId],
      );
      assertEquals(linked.rows, [{
        reservation_provider_model_id: fixture.providerModelId,
        route_provider_model_id: fixture.providerModelId,
      }]);

      const mismatchedReservation = await inTransaction(
        pool,
        (tx) => reserveUsageForAdmission(tx, reservationInput(fixture, "1")),
      );
      if (mismatchedReservation.kind !== "reserved") {
        throw new Error("routing-mismatch reservation was not created");
      }

      const ownerUrl = new URL(databaseUrl!);
      ownerUrl.username = "relay_migrator";
      ownerUrl.password = "relay_dev_only";
      const owner = new pg.Client({ connectionString: ownerUrl.toString() });
      await owner.connect();
      await owner.query("begin");
      let alternateBinding: { rows: { id: string }[] };
      try {
        await owner.query("set local role relay_owner");
        alternateBinding = await owner.query<{ id: string }>(
          `insert into relay.tool_provider_bindings
             (tool_version_id, provider_model_id, capacity_pool_id, routing_order)
           values ($1, $2, $3, 0)
           returning id::text`,
          [
            fixture.toolVersionId,
            otherFixture.providerModelId,
            otherFixture.capacityPoolId,
          ],
        );
        await owner.query("commit");
      } catch (error) {
        await owner.query("rollback");
        throw error;
      } finally {
        await owner.end();
      }

      await assertRejects(
        () =>
          inTransaction(pool, async (tx) => {
            const runId = unique("wrong_route_run");
            await tx.query(
              `insert into relay.tool_runs
                 (id, workspace_id, tool_version_id, status, input,
                  reservation_id, created_by)
               values ($1, $2, $3, 'queued', '{}', $4, $5)`,
              [
                runId,
                fixture.workspaceId,
                fixture.toolVersionId,
                mismatchedReservation.reservation.reservationId,
                fixture.actorUserId,
              ],
            );
            await tx.query(
              `insert into relay.routing_decisions
                 (tool_run_id, selected_binding_id, provider_id,
                  provider_model_id)
               values ($1, $2, $3, $4)`,
              [
                runId,
                alternateBinding.rows[0].id,
                otherFixture.providerId,
                otherFixture.providerModelId,
              ],
            );
          }),
        Error,
        "does not match its usage reservation",
      );

      assertEquals(
        await inTransaction(
          pool,
          (tx) =>
            releaseUsageReservation(tx, {
              ...releaseInput,
              workspaceId: otherFixture.workspaceId,
            }),
        ),
        { kind: "not_found" },
      );
      assertEquals(
        (await inTransaction(
          pool,
          (tx) =>
            releaseUsageReservation(tx, {
              ...releaseInput,
              workspaceId: fixture.workspaceId,
            }),
        )).kind,
        "released",
      );
      assertEquals(
        (await inTransaction(
          pool,
          (tx) =>
            releaseUsageReservation(tx, {
              workspaceId: fixture.workspaceId,
              reservationId: mismatchedReservation.reservation.reservationId,
              idempotencyKey: unique("routing-mismatch-release"),
              outcome: "provider_failure",
            }),
        )).kind,
        "released",
      );
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "provider cost remains a separate append-only ledger",
  ignore: !hasDatabase,
  sanitizeResources: false,
  fn: async () => {
    const fixture = await createFixture("10");
    const pool = appPool();
    try {
      const runId = unique("run");
      const costInput = {
        workspaceId: fixture.workspaceId,
        runId,
        attemptId: null,
        actualModelVersion: "fixture-model-v1",
        normalizedUsage: {
          fixture_tokens: { quantity: "2", unit: "token" },
        },
        idempotencyKey: unique("provider-cost"),
      };
      const unroutedRunId = unique("unrouted_run");
      const unrouted = await inTransaction(pool, async (tx) => {
        await tx.query(
          `insert into relay.tool_runs
             (id, workspace_id, tool_version_id, status, input, created_by)
           values ($1, $2, $3, 'queued', '{}', $4)`,
          [
            unroutedRunId,
            fixture.workspaceId,
            fixture.toolVersionId,
            fixture.actorUserId,
          ],
        );
        return await recordProviderCostEvent(tx, {
          ...costInput,
          runId: unroutedRunId,
          idempotencyKey: unique("unrouted-provider-cost"),
        });
      });
      assertEquals(unrouted, { kind: "not_found" });

      const setup = await inTransaction(pool, async (tx) => {
        const routingDecisionId = await createRunWithRoutingDecision(
          tx,
          fixture,
          runId,
        );
        const attemptId = await createAttempt(
          tx,
          fixture,
          runId,
          routingDecisionId,
        );
        const attemptedCostInput = { ...costInput, attemptId };
        return {
          attemptId,
          routingDecisionId,
          recorded: await recordProviderCostEvent(tx, attemptedCostInput),
        };
      });
      const attemptedCostInput = { ...costInput, attemptId: setup.attemptId };
      const recorded = setup.recorded;
      const replayed = await inTransaction(
        pool,
        (tx) => recordProviderCostEvent(tx, attemptedCostInput),
      );
      const crossWorkspace = await inTransaction(
        pool,
        (tx) =>
          recordProviderCostEvent(tx, {
            ...attemptedCostInput,
            workspaceId: `org_other_${crypto.randomUUID()}`,
            idempotencyKey: unique("cross-workspace-provider-cost"),
          }),
      );

      const mismatchedAttemptId = await inTransaction(pool, async (tx) => {
        const otherRunId = unique("other_routing_run");
        const otherDecisionId = await createRunWithRoutingDecision(
          tx,
          fixture,
          otherRunId,
        );
        return await createAttempt(tx, fixture, runId, otherDecisionId);
      });
      const mismatchedAttempt = await inTransaction(
        pool,
        (tx) =>
          recordProviderCostEvent(tx, {
            ...costInput,
            attemptId: mismatchedAttemptId,
            idempotencyKey: unique("mismatched-attempt-provider-cost"),
          }),
      );

      assertEquals(recorded.kind, "recorded");
      assertEquals(replayed.kind, "replayed");
      assertEquals(crossWorkspace, { kind: "not_found" });
      assertEquals(mismatchedAttempt, { kind: "not_found" });
      if (recorded.kind !== "recorded") {
        throw new Error("cost was not recorded");
      }
      assertEquals(recorded.receipt.attemptId, setup.attemptId);
      assertEquals(recorded.receipt.providerModelId, fixture.providerModelId);
      assertEquals(recorded.receipt.calculation.amount, "0.5");
      assertEquals(recorded.receipt.calculation.currency, "TST");
      const pricingSnapshot = await pool.query<{ price_per_unit: string }>(
        `select pricing_policy_snapshot #>> '{rates,0,pricePerUnit}'
                  as price_per_unit
           from relay.provider_cost_events
          where workspace_id = $1 and id = $2`,
        [fixture.workspaceId, recorded.receipt.providerCostEventId],
      );
      assertEquals(pricingSnapshot.rows[0].price_per_unit, "0.250000000");

      await assertRejects(
        () =>
          pool.query(
            `insert into relay.provider_cost_events (
               id, workspace_id, run_id, attempt_id, provider_model_id,
               actual_model_version, normalized_usage, cost_components,
               cost_amount, currency, pricing_policy_id, pricing_policy_key,
               pricing_policy_revision, pricing_policy_hash,
               pricing_policy_snapshot, idempotency_key_hash, request_hash,
               occurred_at
             )
             select $1, workspace_id, run_id, $2::bigint, provider_model_id,
                    actual_model_version, normalized_usage, cost_components,
                    cost_amount, currency, pricing_policy_id, pricing_policy_key,
                    pricing_policy_revision, pricing_policy_hash,
                    pricing_policy_snapshot, $3, $4, statement_timestamp()
               from relay.provider_cost_events
              where id = $5`,
            [
              unique("provider_cost_mismatch"),
              mismatchedAttemptId,
              "a".repeat(64),
              "b".repeat(64),
              recorded.receipt.providerCostEventId,
            ],
          ),
        Error,
        "provider cost attempt does not match its run routing decision",
      );

      const customerUsage = await pool.query<{ count: string }>(
        "select count(*) from relay.usage_events where workspace_id = $1",
        [fixture.workspaceId],
      );
      assertEquals(customerUsage.rows[0].count, "0");
      await assertRejects(
        () =>
          pool.query(
            `update relay.provider_cost_events
                set cost_amount = cost_amount
              where id = $1`,
            [recorded.receipt.providerCostEventId],
          ),
        Error,
      );
    } finally {
      await pool.end();
    }
  },
});
