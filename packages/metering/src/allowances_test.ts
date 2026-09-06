import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import pg from "pg";
import {
  AllowanceInputError,
  getWorkspaceAllowances,
  type GrantAllowanceInput,
  listAllowanceAudit,
  listAllowanceGrants,
  listAllowanceWorkspaces,
  manageWorkspaceAllowance,
  parseGrantAllowanceInput,
} from "./allowances.ts";
import { can, resolveLimitAt } from "./entitlements.ts";
import { reserveUsageForAdmission } from "./admission.ts";
import { withMeteringTransaction } from "./transaction.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const grant: GrantAllowanceInput = {
  key: "images.generated",
  mode: "finite",
  amount: "20",
  effectiveAt: null,
  expiresAt: null,
  reason: "Approved pilot",
};
Deno.test("allowance input requires explicit whole counts, modes and windows", () => {
  assertEquals(parseGrantAllowanceInput(grant), grant);
  for (
    const change of [
      { amount: null },
      { amount: 20 },
      { amount: "1.5" },
      { amount: "-1" },
      { amount: "1e3" },
      { amount: "1".repeat(30) },
      { mode: "unlimited" },
      { reason: " " },
      { key: "other" },
      { effectiveAt: "today" },
      {
        expiresAt: "2026-01-01T00:00:00Z",
        effectiveAt: "2027-01-01T00:00:00Z",
      },
      { actorUserId: "forged" },
    ]
  ) {
    assertThrows(
      () => parseGrantAllowanceInput({ ...grant, ...change }),
      AllowanceInputError,
    );
  }
  assertThrows(
    () => parseGrantAllowanceInput({ ...grant, expiresAt: undefined }),
    AllowanceInputError,
  );
  assertEquals(
    parseGrantAllowanceInput({ ...grant, mode: "unlimited", amount: null })
      .amount,
    null,
  );
  assertEquals(parseGrantAllowanceInput({ ...grant, amount: "0" }).amount, "0");
});

async function fixture() {
  const suffix = crypto.randomUUID();
  const user = `allowance-user-${suffix}`;
  const session = `allowance-session-${suffix}`;
  const workspace = `allowance-ws-${suffix}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  const url = new URL(databaseUrl!);
  url.username = "relay_migrator";
  url.password = "relay_dev_only";
  const owner = new pg.Client({ connectionString: url.toString() });
  await owner.connect();
  await owner.query("begin");
  await owner.query("set local role relay_owner");
  await owner.query(
    `insert into auth."user" (id, name, email, "emailVerified") values ($1, 'Allowance test', $2, true)`,
    [user, `${suffix}@example.invalid`],
  );
  await owner.query(
    `insert into auth.organization (id, name, slug, "createdAt") values ($1, 'Allowance test', $1, now())`,
    [workspace],
  );
  await owner.query(
    `insert into auth.member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $3, 'owner', now())`,
    [suffix, workspace, user],
  );
  await owner.query(
    `insert into auth.session (id, "expiresAt", token, "createdAt", "updatedAt", "userId") values ($1, now() + interval '1 hour', $1, now(), now(), $2)`,
    [session, user],
  );
  await owner.query(
    `insert into relay.system_role_assignments (user_id, role, granted_by) values ($1, 'superadmin', $1)`,
    [user],
  );
  await owner.query("commit");
  const mutate = (input: GrantAllowanceInput, key = crypto.randomUUID()) =>
    manageWorkspaceAllowance(
      pool,
      session,
      workspace,
      "grant",
      input,
      key,
      suffix,
    );
  const revoke = (grantId: string, key = crypto.randomUUID()) =>
    manageWorkspaceAllowance(
      pool,
      session,
      workspace,
      "revoke",
      { grantId, reason: "Pilot ended" },
      key,
      suffix,
    );
  const ownerQuery = async (sql: string, values: unknown[] = []) => {
    await owner.query("begin");
    await owner.query("set local role relay_owner");
    try {
      const result = await owner.query(sql, values);
      await owner.query("commit");
      return result;
    } catch (error) {
      await owner.query("rollback");
      throw error;
    }
  };
  return {
    pool,
    owner,
    user,
    session,
    workspace,
    mutate,
    revoke,
    ownerQuery,
    async close() {
      await owner.query("rollback");
      await owner.query("begin");
      await owner.query("set local role relay_owner");
      for (
        const [table, trigger] of [[
          "entitlement_grants",
          "entitlement_grants_mutation_guard",
        ], [
          "allowance_operation_idempotency",
          "allowance_operation_idempotency_immutable",
        ]]
      ) {
        await owner.query(
          `alter table relay.${table} disable trigger ${trigger}`,
        );
      }
      await owner.query(
        "delete from relay.entitlement_grants where workspace_id = $1",
        [workspace],
      );
      await owner.query(
        "delete from relay.allowance_operation_idempotency where operator_user_id = $1",
        [user],
      );
      await owner.query(
        "delete from relay.audit_events where actor_user_id = $1",
        [user],
      );
      await owner.query(
        "delete from relay.usage_buckets where workspace_id = $1",
        [workspace],
      );
      for (
        const [table, trigger] of [[
          "entitlement_grants",
          "entitlement_grants_mutation_guard",
        ], [
          "allowance_operation_idempotency",
          "allowance_operation_idempotency_immutable",
        ]]
      ) {
        await owner.query(
          `alter table relay.${table} enable trigger ${trigger}`,
        );
      }
      await owner.query(
        "delete from relay.system_role_assignments where user_id = $1",
        [user],
      );
      await owner.query('delete from auth.member where "organizationId" = $1', [
        workspace,
      ]);
      await owner.query("delete from auth.organization where id = $1", [
        workspace,
      ]);
      await owner.query('delete from auth.session where "userId" = $1', [user]);
      await owner.query('delete from auth."user" where id = $1', [user]);
      await owner.query("commit");
      await owner.end();
      await pool.end();
    },
  };
}
async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error("Expected PostgreSQL rejection");
}
Deno.test({
  name:
    "allowances are audited, additive and idempotent; revocation preserves usage",
  ignore: !databaseUrl,
  fn: async () => {
    const f = await fixture();
    try {
      assertEquals(
        (await getWorkspaceAllowances(f.pool, f.session, f.workspace))
          ?.limits[0].state,
        "none",
      );
      const key = crypto.randomUUID();
      const results = await Promise.all([
        f.mutate(grant, key),
        f.mutate(grant, key),
      ]);
      assertEquals(results[0].grantId, results[1].grantId);
      assertEquals(results.filter((r) => r.replayed).length, 1);
      assertEquals(
        await code(f.mutate({ ...grant, amount: "30" }, key)),
        "RG001",
      );
      const extra = await f.mutate({ ...grant, amount: "5" });
      await f.ownerQuery(
        `insert into relay.usage_buckets (workspace_id, metric_key, unit, period, period_start, period_end, consumed_amount, reserved_amount)
      values ($1, 'images.generated', 'image', 'calendar_month', date_trunc('month', now() at time zone 'UTC') at time zone 'UTC', (date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC', 4, 2)`,
        [f.workspace],
      );
      let summary = await getWorkspaceAllowances(
        f.pool,
        f.session,
        f.workspace,
      );
      assertEquals(summary?.limits[0].amount, "25");
      assertEquals(summary?.limits[0].remaining, "19");
      const revokeKey = crypto.randomUUID();
      await f.revoke(results[0].grantId, revokeKey);
      assertEquals(
        (await f.revoke(results[0].grantId, revokeKey)).replayed,
        true,
      );
      assertEquals(await code(f.revoke(results[0].grantId)), "RA409");
      summary = await getWorkspaceAllowances(f.pool, f.session, f.workspace);
      assertEquals(summary?.limits[0].amount, "5");
      assertEquals(summary?.limits[0].remaining, "0");
      assertEquals(summary?.limits[0].consumed, "4");
      await f.revoke(extra.grantId);
      assertEquals(
        (await getWorkspaceAllowances(f.pool, f.session, f.workspace))
          ?.limits[0].state,
        "none",
      );
      assertEquals(
        (await listAllowanceAudit(f.pool, f.session, f.workspace)).items.length,
        4,
      );
      const history = await listAllowanceGrants(f.pool, f.session, f.workspace);
      assertEquals(history.items.length, 2);
      assertEquals(
        history.items.every((g) =>
          g.revokedAt !== null && g.operatorUserId === f.user
        ),
        true,
      );
      assertEquals(
        (await listAllowanceWorkspaces(f.pool, f.session, f.workspace)).items[0]
          .id,
        f.workspace,
      );
    } finally {
      await f.close();
    }
  },
});
Deno.test({
  name:
    "allowances require current fresh superadmin authorization even for replay and reads",
  ignore: !databaseUrl,
  fn: async () => {
    const f = await fixture();
    try {
      const key = crypto.randomUUID();
      await f.mutate(grant, key);
      await f.ownerQuery(
        `update auth.session set "createdAt" = now() - interval '16 minutes' where id = $1`,
        [f.session],
      );
      assertEquals(await code(f.mutate(grant, key)), "55000");
      assertEquals(
        await code(listAllowanceWorkspaces(f.pool, f.session)),
        "55000",
      );
      await f.ownerQuery(
        `update auth.session set "createdAt" = now() where id = $1`,
        [f.session],
      );
      await f.ownerQuery(
        "delete from relay.system_role_assignments where user_id = $1",
        [f.user],
      );
      assertEquals(await code(f.mutate(grant, key)), "42501");
      assertEquals(
        await code(getWorkspaceAllowances(f.pool, f.session, f.workspace)),
        "42501",
      );
      assertEquals(
        await code(listAllowanceAudit(f.pool, f.session, f.workspace)),
        "42501",
      );
      assertEquals(
        await code(listAllowanceGrants(f.pool, "missing", f.workspace)),
        "28000",
      );
      assertEquals(
        await code(
          f.pool.query(
            `insert into relay.entitlement_grants (id) values ('forged')`,
          ),
        ),
        "42501",
      );
      assertEquals(
        await code(
          f.pool.query(
            "update relay.entitlement_grants set revoked_at = now() where workspace_id = $1",
            [f.workspace],
          ),
        ),
        "42501",
      );
    } finally {
      await f.close();
    }
  },
});
Deno.test({
  name:
    "allowance windows and explicit unlimited grants resolve without automatic execution access",
  ignore: !databaseUrl,
  fn: async () => {
    const f = await fixture();
    try {
      const future = new Date(Date.now() + 86400000).toISOString();
      const scheduled = await f.mutate({ ...grant, effectiveAt: future });
      assertEquals(
        (await getWorkspaceAllowances(f.pool, f.session, f.workspace))
          ?.limits[0].state,
        "none",
      );
      await f.revoke(scheduled.grantId);
      const unlimited = await f.mutate({
        ...grant,
        mode: "unlimited",
        amount: null,
      });
      const summary = await getWorkspaceAllowances(
        f.pool,
        f.session,
        f.workspace,
      );
      assertEquals(summary?.limits[0].state, "unlimited");
      assertEquals(summary?.executionAllowed, false);
      assertEquals(
        (await can(f.pool, {
          workspaceId: f.workspace,
          actorUserId: f.user,
          capability: "tools.execute",
        })).kind,
        "denied",
      );
      const capability = await f.mutate({
        ...grant,
        key: "tools.execute",
        mode: "enabled",
        amount: null,
      });
      assertEquals(
        (await getWorkspaceAllowances(f.pool, f.session, f.workspace))
          ?.executionAllowed,
        true,
      );
      await f.revoke(capability.grantId);
      await f.revoke(unlimited.grantId);
      await assertRejects(() =>
        f.mutate({ ...grant, expiresAt: "2020-01-01T00:00:00Z" })
      );
      assertEquals(
        await code(
          f.pool.query(
            "select relay.manage_workspace_allowance($1,$2,'grant',$3::jsonb,$4,$5)",
            [
              f.session,
              f.workspace,
              JSON.stringify({ ...grant, amount: null }),
              "a".repeat(64),
              "invalid-test",
            ],
          ),
        ),
        "22023",
      );
    } finally {
      await f.close();
    }
  },
});
Deno.test({
  name: "allowance audit failure rolls back both grant and replay record",
  ignore: !databaseUrl,
  fn: async () => {
    const f = await fixture();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const trigger = `allowance_audit_test_${suffix}`;
    const key = crypto.randomUUID();
    try {
      await f.ownerQuery(
        `create function relay.${trigger}() returns trigger language plpgsql as $$ begin
      if new.workspace_id = '${f.workspace}' then raise exception 'test audit failure'; end if; return new; end $$;
      create trigger ${trigger} before insert on relay.audit_events for each row execute function relay.${trigger}()`,
      );
      assertEquals(await code(f.mutate(grant, key)), "P0001");
      assertEquals(
        (await listAllowanceGrants(f.pool, f.session, f.workspace)).items
          .length,
        0,
      );
      await f.ownerQuery(
        `drop trigger ${trigger} on relay.audit_events; drop function relay.${trigger}()`,
      );
      assertEquals((await f.mutate(grant, key)).replayed, false);
      assertEquals(
        (await listAllowanceAudit(f.pool, f.session, f.workspace)).items.length,
        1,
      );
    } finally {
      await f.ownerQuery(
        `drop trigger if exists ${trigger} on relay.audit_events; drop function if exists relay.${trigger}()`,
      );
      await f.close();
    }
  },
});

Deno.test({
  name: "admission waiting behind revocation uses the new allowance state",
  ignore: !databaseUrl,
  fn: async () => {
    const f = await fixture();
    const admission = await f.pool.connect();
    const mutation = await f.pool.connect();
    let reservation: Promise<unknown> | undefined;
    try {
      const access = await f.mutate({
        ...grant,
        key: "tools.execute",
        mode: "enabled",
        amount: null,
      });
      await f.mutate(grant);
      const tool = (await f.pool.query<{ version: string; model: string }>(
        `select tv.id as version, binding.provider_model_id::text as model
      from relay.tools t join relay.tool_versions tv on tv.id = t.active_version_id
      join relay.tool_provider_bindings binding on binding.tool_version_id = tv.id
      where t.key = 'image.generate.gpt-image-2' limit 1`,
      )).rows[0];
      await admission.query("begin");
      const pid = (await admission.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      )).rows[0].pid;
      await mutation.query("begin");
      await mutation.query(
        "select pg_advisory_xact_lock(hashtextextended('relay.allowance:workspace:' || $1, 0))",
        [f.workspace],
      );
      reservation = withMeteringTransaction(
        admission,
        (transaction) =>
          reserveUsageForAdmission(transaction, {
            actorUserId: f.user,
            workspaceId: f.workspace,
            toolVersionId: tool.version,
            providerModelId: tool.model,
            measures: { requested_units: 1 },
            idempotencyKey: crypto.randomUUID(),
            reservationTtlSeconds: 60,
          }),
      );
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = await f.pool.query<{ blocked: boolean }>(
          "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
          [pid],
        );
        if (activity.rows[0].blocked) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assertEquals(waiting, true);
      await mutation.query(
        "select relay.manage_workspace_allowance($1,$2,'revoke',$3::jsonb,$4,$5)",
        [
          f.session,
          f.workspace,
          JSON.stringify({
            grantId: access.grantId,
            reason: "Revoke before admission",
          }),
          "c".repeat(64),
          "concurrent-allowance-test",
        ],
      );
      await mutation.query("commit");
      assertEquals(await reservation, { kind: "not_entitled" });
    } finally {
      await mutation.query("rollback");
      await reservation?.catch(() => {});
      await admission.query("rollback");
      admission.release();
      mutation.release();
      await f.close();
    }
  },
});

Deno.test({
  name:
    "allowance expiry and history pagination use explicit windows and stable cursors",
  ignore: !databaseUrl,
  fn: async () => {
    const f = await fixture();
    try {
      const start = new Date(Date.now() + 86400000);
      const end = new Date(start.getTime() + 3600000);
      await f.mutate({
        ...grant,
        effectiveAt: start.toISOString(),
        expiresAt: end.toISOString(),
      });
      assertEquals(
        (await resolveLimitAt(f.pool, f.workspace, "images.generated", start))
          .kind,
        "configured",
      );
      assertEquals(
        (await resolveLimitAt(f.pool, f.workspace, "images.generated", end))
          .kind,
        "none",
      );
      for (let i = 0; i < 30; i++) await f.mutate({ ...grant, amount: "0" });
      const first = await listAllowanceGrants(f.pool, f.session, f.workspace);
      const second = await listAllowanceGrants(
        f.pool,
        f.session,
        f.workspace,
        first.nextCursor,
      );
      assertEquals(first.items.length, 30);
      assertEquals(second.items.length, 1);
      assertEquals(
        new Set([...first.items, ...second.items].map((g) => g.id)).size,
        31,
      );
      const audit = await listAllowanceAudit(f.pool, f.session, f.workspace);
      const older = await listAllowanceAudit(
        f.pool,
        f.session,
        f.workspace,
        audit.nextCursor,
      );
      assertEquals(audit.items.length, 30);
      assertEquals(older.items.length, 1);
      assertEquals(older.nextCursor, null);
    } finally {
      await f.close();
    }
  },
});
