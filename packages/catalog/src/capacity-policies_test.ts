import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import pg from "pg";
import {
  canonicalCapacityPolicyJson,
  CapacityPolicyValidationError,
  getCapacityPolicy,
  listCapacityPolicies,
  reviseCapacityPolicy,
} from "./capacity-policies.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const hasDatabase = databaseUrl !== undefined;

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

function ownerUrl(): URL {
  const url = new URL(databaseUrl!);
  url.username = "relay_migrator";
  url.password = "relay_dev_only";
  return url;
}

async function withOwnerTransaction<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: ownerUrl().toString() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local role relay_owner");
    try {
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await client.end();
  }
}

function unique(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

async function createUser(pool: DatabasePool, label: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth."user" (id, name, email, "emailVerified")
     values (gen_random_uuid()::text, 'Capacity policy test', $1, true)
     returning id`,
    [`${unique(label)}@example.invalid`],
  );
  return rows[0].id;
}

async function createSession(
  pool: DatabasePool,
  userId: string,
  createdAt: Date,
): Promise<string> {
  const sessionId = unique("capacity-session");
  await pool.query(
    `insert into auth.session
       (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
     values ($1, now() + interval '1 hour', $2, $3, now(), $4)`,
    [sessionId, unique("capacity-token"), createdAt, userId],
  );
  return sessionId;
}

async function rejectionCode(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    const code = typeof error === "object" && error !== null
      ? (error as { readonly code?: unknown }).code
      : undefined;
    if (typeof code === "string") return code;
    throw error;
  }
  throw new Error("expected PostgreSQL to reject the operation");
}

async function makeSuperadmin(actorUserId: string): Promise<void> {
  await withOwnerTransaction(async (owner) => {
    await owner.query(
      `insert into relay.system_role_assignments (user_id, role, granted_by)
       values ($1, 'superadmin', $1)`,
      [actorUserId],
    );
  });
}

interface AuditFailureTrigger {
  readonly triggerName: string;
  readonly functionName: string;
}

async function installAuditFailureTrigger(
  requestId: string,
): Promise<AuditFailureTrigger> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const triggerName = `capacity_policy_audit_${suffix}`;
  const functionName = `capacity_policy_audit_${suffix}`;
  const escapedRequestId = requestId.replaceAll("'", "''");
  await withOwnerTransaction(async (owner) => {
    await owner.query(
      `create function relay.${functionName}() returns trigger
       language plpgsql
       set search_path to pg_catalog
       as $body$
       begin
         if new.request_id = '${escapedRequestId}' then
           raise exception 'forced capacity policy audit failure'
             using errcode = 'P0001';
         end if;
         return new;
       end
       $body$`,
    );
    await owner.query(
      `create trigger ${triggerName}
       before insert on relay.audit_events
       for each row execute function relay.${functionName}()`,
    );
  });
  return { triggerName, functionName };
}

async function cleanup(
  userIds: readonly string[],
  scopeIds: readonly string[],
  trigger?: AuditFailureTrigger,
): Promise<void> {
  await withOwnerTransaction(async (owner) => {
    if (trigger !== undefined) {
      await owner.query(
        `drop trigger if exists ${trigger.triggerName} on relay.audit_events`,
      );
      await owner.query(
        `drop function if exists relay.${trigger.functionName}()`,
      );
    }
    if (scopeIds.length > 0) {
      await owner.query(
        `delete from relay.capacity_policies
          where scope_id = any($1::text[])`,
        [[...scopeIds]],
      );
    }
    if (userIds.length > 0) {
      await owner.query(
        `delete from relay.audit_events
          where actor_user_id = any($1::text[])`,
        [[...userIds]],
      );
      await owner.query(
        `alter table relay.governance_operation_idempotency
         disable trigger governance_operation_idempotency_immutable`,
      );
      await owner.query(
        `delete from relay.governance_operation_idempotency
          where operator_user_id = any($1::text[])`,
        [[...userIds]],
      );
      await owner.query(
        `alter table relay.governance_operation_idempotency
         enable trigger governance_operation_idempotency_immutable`,
      );
      await owner.query(
        `delete from relay.system_role_assignments
          where user_id = any($1::text[])`,
        [[...userIds]],
      );
      await owner.query(
        `delete from auth."user" where id = any($1::text[])`,
        [[...userIds]],
      );
    }
  });
}

interface GovernanceRow {
  readonly operation: string;
  readonly idempotency_key_hash: string;
  readonly request_fingerprint: string;
  readonly response: unknown;
  readonly serialized: string;
}

async function governanceRows(actorUserId: string): Promise<GovernanceRow[]> {
  return await withOwnerTransaction(async (owner) => {
    const { rows } = await owner.query<GovernanceRow>(
      `select operation, idempotency_key_hash, request_fingerprint, response,
              pg_catalog.row_to_json(record)::text as serialized
         from relay.governance_operation_idempotency as record
        where operator_user_id = $1
        order by created_at`,
      [actorUserId],
    );
    return rows;
  });
}

function policyConfiguration(providerPerMinute = 60, toolPerMinute = 30) {
  return {
    workspaceTool: 5,
    submissionRateDefaults: {
      toolPerMinute,
      providerPerMinute,
    },
    executionConcurrency: {
      workspaceTotal: 20,
      pool: 10,
    },
    genericExtension: {
      modes: ["standard", "burst"],
      enabled: true,
    },
  };
}

Deno.test("capacity policy JSON is canonical and rejects unsafe values", () => {
  const left = {
    z: [3, { b: true, a: null }],
    a: 1,
  };
  const right = {
    a: 1,
    z: [3, { a: null, b: true }],
  };
  assertEquals(
    canonicalCapacityPolicyJson(left),
    canonicalCapacityPolicyJson(right),
  );
  assertEquals(
    canonicalCapacityPolicyJson(left),
    '{"a":1,"z":[3,{"a":null,"b":true}]}',
  );

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertThrows(
    () => canonicalCapacityPolicyJson(cyclic),
    CapacityPolicyValidationError,
    "must not contain cycles",
  );

  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get: () => {
      throw new Error("getter must not run");
    },
  });
  assertThrows(
    () => canonicalCapacityPolicyJson(accessor),
    CapacityPolicyValidationError,
    "must be an enumerable data value",
  );
});

Deno.test({
  name:
    "session-backed capacity authorization enforces freshness and current role",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const superadminId = await createUser(pool, "capacity-session-admin");
    const regularUserId = await createUser(pool, "capacity-session-regular");
    try {
      await makeSuperadmin(superadminId);
      const freshSessionId = await createSession(
        pool,
        superadminId,
        new Date(),
      );
      const staleSessionId = await createSession(
        pool,
        superadminId,
        new Date(Date.now() - 16 * 60_000),
      );
      const regularSessionId = await createSession(
        pool,
        regularUserId,
        new Date(),
      );

      const authorized = await listCapacityPolicies(
        pool,
        { sessionId: freshSessionId },
        { limit: 1, requestId: unique("capacity-session-authorized") },
      );
      assertEquals(authorized.kind, "ok");
      assertEquals(
        await rejectionCode(
          listCapacityPolicies(pool, { sessionId: staleSessionId }, {
            limit: 1,
          }),
        ),
        "55000",
      );
      assertEquals(
        await rejectionCode(
          listCapacityPolicies(pool, { sessionId: regularSessionId }, {
            limit: 1,
          }),
        ),
        "42501",
      );
    } finally {
      await cleanup([superadminId, regularUserId], []);
      await pool.end();
    }
  },
});

Deno.test({
  name: "capacity policy operations deny non-superadmins and audit the denial",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const actorUserId = await createUser(pool, "capacity-denied");
    const scopeId = unique("capacity-denied-scope");
    try {
      assertEquals(
        await listCapacityPolicies(pool, actorUserId, {
          scopeType: "tool",
          scopeId,
          requestId: unique("capacity-list-denied"),
        }),
        { kind: "denied" },
      );
      assertEquals(
        await getCapacityPolicy(pool, actorUserId, {
          scopeType: "tool",
          scopeId,
          requestId: unique("capacity-get-denied"),
        }),
        { kind: "denied" },
      );
      assertEquals(
        await reviseCapacityPolicy(pool, actorUserId, {
          scopeType: "tool",
          scopeId,
          expectedRevision: 0,
          configuration: policyConfiguration(),
          effectiveAt: new Date(Date.now() - 60_000),
          requestId: unique("capacity-revise-denied"),
        }),
        { kind: "denied", replayed: false },
      );

      const policies = await pool.query<{ count: string }>(
        `select count(*)::text as count
           from relay.capacity_policies
          where scope_type = 'tool' and scope_id = $1`,
        [scopeId],
      );
      assertEquals(policies.rows[0].count, "0");

      const audits = await pool.query<{
        action: string;
        outcome: string;
        reason_code: string;
      }>(
        `select action, outcome, reason_code
           from relay.audit_events
          where actor_user_id = $1 and action like 'capacity_policy.%'
          order by id`,
        [actorUserId],
      );
      assertEquals(audits.rows, [
        {
          action: "capacity_policy.list",
          outcome: "denied",
          reason_code: "superadmin_required",
        },
        {
          action: "capacity_policy.get",
          outcome: "denied",
          reason_code: "superadmin_required",
        },
        {
          action: "capacity_policy.revise",
          outcome: "denied",
          reason_code: "superadmin_required",
        },
      ]);
    } finally {
      await cleanup([actorUserId], [scopeId]);
      await pool.end();
    }
  },
});

Deno.test({
  name: "capacity policy revisions append canonical hashed history",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const actorUserId = await createUser(pool, "capacity-history");
    const scopeId = unique("capacity-history-scope");
    await makeSuperadmin(actorUserId);
    try {
      const firstConfiguration = policyConfiguration();
      const first = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        expectedRevision: 0,
        configuration: firstConfiguration,
        effectiveAt: new Date(Date.now() - 120_000),
        requestId: unique("capacity-history-1"),
      });
      assertEquals(first.kind, "revised");
      if (first.kind !== "revised") throw new Error("unreachable");

      const secondConfiguration = {
        ...policyConfiguration(90, 45),
        operatorNote: "generic policy JSON remains available",
      };
      const second = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        expectedRevision: 1,
        configuration: secondConfiguration,
        effectiveAt: new Date(Date.now() - 60_000),
        requestId: unique("capacity-history-2"),
      });
      assertEquals(second.kind, "revised");
      if (second.kind !== "revised") throw new Error("unreachable");

      assertEquals(first.value.revision, 1);
      assertEquals(second.value.revision, 2);
      assertEquals(
        first.value.canonicalJson,
        canonicalCapacityPolicyJson(firstConfiguration),
      );
      assertEquals(
        second.value.canonicalJson,
        canonicalCapacityPolicyJson(secondConfiguration),
      );
      assertMatch(first.value.immutableHash, /^[0-9a-f]{64}$/u);
      assertMatch(second.value.immutableHash, /^[0-9a-f]{64}$/u);
      assertEquals(
        first.value.immutableHash === second.value.immutableHash,
        false,
      );

      const stored = await pool.query<{
        revision: number;
        configuration: unknown;
      }>(
        `select revision, configuration
           from relay.capacity_policies
          where scope_type = 'tool' and scope_id = $1
          order by revision`,
        [scopeId],
      );
      assertEquals(stored.rows, [
        { revision: 1, configuration: firstConfiguration },
        { revision: 2, configuration: secondConfiguration },
      ]);

      const listed = await listCapacityPolicies(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        includeHistory: true,
        requestId: unique("capacity-history-list"),
      });
      assertEquals(listed.kind, "ok");
      if (listed.kind !== "ok") throw new Error("unreachable");
      assertEquals(
        listed.value.map((policy) => policy.revision),
        [2, 1],
      );
      assertEquals(
        listed.value.map((policy) => policy.immutableHash),
        [second.value.immutableHash, first.value.immutableHash],
      );

      const audits = await pool.query<{ immutable_hash: string }>(
        `select after_snapshot ->> 'immutableHash' as immutable_hash
           from relay.audit_events
          where actor_user_id = $1
            and action = 'capacity_policy.revise'
            and outcome = 'success'
            and target_id = any($2::text[])
          order by id`,
        [actorUserId, [first.value.policyId, second.value.policyId]],
      );
      assertEquals(
        audits.rows.map((row: { immutable_hash: string }) =>
          row.immutable_hash
        ),
        [first.value.immutableHash, second.value.immutableHash],
      );
    } finally {
      await cleanup([actorUserId], [scopeId]);
      await pool.end();
    }
  },
});

Deno.test({
  name: "capacity policy revision conflicts preserve the existing revision",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const actorUserId = await createUser(pool, "capacity-conflict");
    const scopeId = unique("capacity-conflict-scope");
    await makeSuperadmin(actorUserId);
    try {
      const created = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "capacity_pool",
        scopeId,
        expectedRevision: 0,
        configuration: policyConfiguration(),
        effectiveAt: new Date(Date.now() - 60_000),
        requestId: unique("capacity-conflict-create"),
      });
      assertEquals(created.kind, "revised");

      const conflictRequestId = unique("capacity-conflict-stale");
      const conflict = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "capacity_pool",
        scopeId,
        expectedRevision: 0,
        configuration: policyConfiguration(120, 60),
        effectiveAt: new Date(),
        requestId: conflictRequestId,
      });
      assertEquals(conflict, {
        kind: "revision_conflict",
        expectedRevision: 0,
        actualRevision: 1,
        replayed: false,
      });

      const policies = await pool.query<{ count: string }>(
        `select count(*)::text as count
           from relay.capacity_policies
          where scope_type = 'capacity_pool' and scope_id = $1`,
        [scopeId],
      );
      assertEquals(policies.rows[0].count, "1");
      const audit = await pool.query<{
        outcome: string;
        reason_code: string;
      }>(
        `select outcome, reason_code
           from relay.audit_events
          where request_id = $1`,
        [conflictRequestId],
      );
      assertEquals(audit.rows, [{
        outcome: "failure",
        reason_code: "revision_conflict",
      }]);
    } finally {
      await cleanup([actorUserId], [scopeId]);
      await pool.end();
    }
  },
});

Deno.test({
  name: "an audit failure rolls back the appended capacity policy revision",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const actorUserId = await createUser(pool, "capacity-rollback");
    const scopeId = unique("capacity-rollback-scope");
    const requestId = unique("capacity-rollback-request");
    const mutationKey = unique("capacity-rollback-mutation");
    let trigger: AuditFailureTrigger | undefined;
    await makeSuperadmin(actorUserId);
    try {
      trigger = await installAuditFailureTrigger(requestId);
      await assertRejects(
        () =>
          reviseCapacityPolicy(pool, actorUserId, {
            scopeType: "tool",
            scopeId,
            expectedRevision: 0,
            configuration: policyConfiguration(),
            effectiveAt: new Date(Date.now() - 60_000),
            mutationKey,
            requestId,
          }),
        Error,
        "forced capacity policy audit failure",
      );

      const state = await pool.query<{
        policies: string;
        audits: string;
      }>(
        `select
           (select count(*) from relay.capacity_policies
             where scope_type = 'tool' and scope_id = $1)::text as policies,
           (select count(*) from relay.audit_events
             where request_id = $2)::text as audits`,
        [scopeId, requestId],
      );
      assertEquals(state.rows[0], { policies: "0", audits: "0" });
      assertEquals((await governanceRows(actorUserId)).length, 0);
    } finally {
      await cleanup([actorUserId], [scopeId], trigger);
      await pool.end();
    }
  },
});

Deno.test({
  name: "current capacity policy selection excludes future revisions",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const actorUserId = await createUser(pool, "capacity-current");
    const scopeId = unique("capacity-current-scope");
    await makeSuperadmin(actorUserId);
    try {
      const now = Date.now();
      const current = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        expectedRevision: 0,
        configuration: policyConfiguration(60, 30),
        effectiveAt: new Date(now - 60_000),
        requestId: unique("capacity-current-1"),
      });
      assertEquals(current.kind, "revised");

      const futureEffectiveAt = new Date(now + 86_400_000);
      const future = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        expectedRevision: 1,
        configuration: policyConfiguration(120, 60),
        effectiveAt: futureEffectiveAt,
        requestId: unique("capacity-current-2"),
      });
      assertEquals(future.kind, "revised");

      const selected = await getCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        requestId: unique("capacity-current-get"),
      });
      assertEquals(selected.kind, "ok");
      if (selected.kind !== "ok") throw new Error("unreachable");
      assertEquals(selected.value.revision, 1);

      const listed = await listCapacityPolicies(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        requestId: unique("capacity-current-list"),
      });
      assertEquals(listed.kind, "ok");
      if (listed.kind !== "ok") throw new Error("unreachable");
      assertEquals(listed.value.length, 1);
      assertEquals(listed.value[0].revision, 1);

      const futureSelection = await getCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        effectiveAt: new Date(now + 2 * 86_400_000),
        requestId: unique("capacity-future-get"),
      });
      assertEquals(futureSelection.kind, "ok");
      if (futureSelection.kind !== "ok") throw new Error("unreachable");
      assertEquals(futureSelection.value.revision, 2);

      const exactFuture = await getCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        revision: 2,
        requestId: unique("capacity-exact-get"),
      });
      assertEquals(exactFuture.kind, "ok");
      if (exactFuture.kind !== "ok") throw new Error("unreachable");
      assertEquals(exactFuture.value.revision, 2);
    } finally {
      await cleanup([actorUserId], [scopeId]);
      await pool.end();
    }
  },
});

Deno.test({
  name: "capacity policy mutation keys replay the original safe response",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const actorUserId = await createUser(pool, "capacity-replay");
    const scopeId = unique("capacity-replay-scope");
    const mutationKey = unique("capacity-replay-key");
    const effectiveAt = new Date(Date.now() - 60_000);
    await makeSuperadmin(actorUserId);
    try {
      const first = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        expectedRevision: 0,
        configuration: policyConfiguration(),
        effectiveAt,
        mutationKey,
        requestId: unique("capacity-replay-first"),
      });
      assertEquals(first.kind, "revised");
      if (first.kind !== "revised") throw new Error("unreachable");
      assertEquals(first.replayed, false);

      const replay = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        expectedRevision: 0,
        configuration: {
          genericExtension: {
            enabled: true,
            modes: ["standard", "burst"],
          },
          executionConcurrency: { pool: 10, workspaceTotal: 20 },
          submissionRateDefaults: {
            providerPerMinute: 60,
            toolPerMinute: 30,
          },
          workspaceTool: 5,
        },
        effectiveAt,
        mutationKey,
        requestId: unique("capacity-replay-second"),
      });
      assertEquals(replay.kind, "revised");
      if (replay.kind !== "revised") throw new Error("unreachable");
      assertEquals(replay.replayed, true);
      assertEquals(replay.value, first.value);

      const state = await pool.query<{ policies: string; audits: string }>(
        `select
           (select count(*) from relay.capacity_policies
             where scope_type = 'tool' and scope_id = $1)::text as policies,
           (select count(*) from relay.audit_events
             where actor_user_id = $2
               and action = 'capacity_policy.revise'
               and outcome = 'success')::text as audits`,
        [scopeId, actorUserId],
      );
      assertEquals(state.rows[0], { policies: "1", audits: "1" });

      const operations = await governanceRows(actorUserId);
      assertEquals(operations.length, 1);
      assertEquals(operations[0].operation, "capacity_policy.revise");
      assertMatch(operations[0].idempotency_key_hash, /^[0-9a-f]{64}$/u);
      assertMatch(operations[0].request_fingerprint, /^[0-9a-f]{64}$/u);
      assertEquals(operations[0].serialized.includes(mutationKey), false);
      assertEquals(operations[0].response, {
        kind: "revised",
        policyId: first.value.policyId,
        revision: 1,
      });
    } finally {
      await cleanup([actorUserId], [scopeId]);
      await pool.end();
    }
  },
});

Deno.test({
  name: "capacity policy mutation key reuse with another request conflicts",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const actorUserId = await createUser(pool, "capacity-key-conflict");
    const scopeId = unique("capacity-key-conflict-scope");
    const mutationKey = unique("capacity-key-conflict");
    const effectiveAt = new Date(Date.now() - 60_000);
    await makeSuperadmin(actorUserId);
    try {
      const first = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        expectedRevision: 0,
        configuration: policyConfiguration(),
        effectiveAt,
        mutationKey,
        requestId: unique("capacity-key-conflict-first"),
      });
      assertEquals(first.kind, "revised");

      const conflict = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        expectedRevision: 0,
        configuration: policyConfiguration(999, 30),
        effectiveAt,
        mutationKey,
        requestId: unique("capacity-key-conflict-second"),
      });
      assertEquals(conflict, {
        kind: "mutation_key_conflict",
        replayed: false,
      });

      const state = await pool.query<{ policies: string; conflicts: string }>(
        `select
           (select count(*) from relay.capacity_policies
             where scope_type = 'tool' and scope_id = $1)::text as policies,
           (select count(*) from relay.audit_events
             where actor_user_id = $2
               and action = 'capacity_policy.revise'
               and reason_code = 'mutation_key_conflict')::text as conflicts`,
        [scopeId, actorUserId],
      );
      assertEquals(state.rows[0], { policies: "1", conflicts: "1" });
      assertEquals((await governanceRows(actorUserId)).length, 1);
    } finally {
      await cleanup([actorUserId], [scopeId]);
      await pool.end();
    }
  },
});

Deno.test({
  name: "authorization denial does not disclose mutation replay state",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const actorUserId = await createUser(pool, "capacity-replay-denied");
    const scopeId = unique("capacity-replay-denied-scope");
    const mutationKey = unique("capacity-replay-denied-key");
    const effectiveAt = new Date(Date.now() - 60_000);
    await makeSuperadmin(actorUserId);
    try {
      const first = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        expectedRevision: 0,
        configuration: policyConfiguration(),
        effectiveAt,
        mutationKey,
        requestId: unique("capacity-replay-authorized"),
      });
      assertEquals(first.kind, "revised");

      await withOwnerTransaction(async (owner) => {
        await owner.query(
          `delete from relay.system_role_assignments where user_id = $1`,
          [actorUserId],
        );
      });

      const exact = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        expectedRevision: 0,
        configuration: policyConfiguration(),
        effectiveAt,
        mutationKey,
        requestId: unique("capacity-replay-denied-exact"),
      });
      const changed = await reviseCapacityPolicy(pool, actorUserId, {
        scopeType: "tool",
        scopeId,
        expectedRevision: 0,
        configuration: policyConfiguration(999, 999),
        effectiveAt,
        mutationKey,
        requestId: unique("capacity-replay-denied-changed"),
      });
      assertEquals(exact, { kind: "denied", replayed: false });
      assertEquals(changed, { kind: "denied", replayed: false });

      const state = await pool.query<{ policies: string; denials: string }>(
        `select
           (select count(*) from relay.capacity_policies
             where scope_type = 'tool' and scope_id = $1)::text as policies,
           (select count(*) from relay.audit_events
             where actor_user_id = $2
               and action = 'capacity_policy.revise'
               and outcome = 'denied')::text as denials`,
        [scopeId, actorUserId],
      );
      assertEquals(state.rows[0], { policies: "1", denials: "2" });
      assertEquals((await governanceRows(actorUserId)).length, 1);
    } finally {
      await cleanup([actorUserId], [scopeId]);
      await pool.end();
    }
  },
});
