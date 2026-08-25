import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  can,
  limit,
  resolveCapabilityAt,
  resolveLimitAt,
} from "./entitlements.ts";
import type { MeteringQueryExecutor } from "./types.ts";

class EntitlementFixtureQuery implements MeteringQueryExecutor {
  readonly calls: string[] = [];

  constructor(
    private readonly member: boolean,
    private readonly capabilityRows: readonly Record<string, unknown>[] = [],
    private readonly limitRows: readonly Record<string, unknown>[] = [],
  ) {}

  query<Row>(text: string): Promise<{ rows: Row[] }> {
    this.calls.push(text);
    if (text.includes("from auth.member")) {
      return Promise.resolve({
        rows: (this.member ? [{ role: "member" }] : []) as Row[],
      });
    }
    if (text.includes("transaction_timestamp")) {
      return Promise.resolve({
        rows: [{ now: new Date("2026-08-23T12:00:00Z") }] as Row[],
      });
    }
    if (text.includes("grant_kind = 'capability'")) {
      return Promise.resolve({ rows: [...this.capabilityRows] as Row[] });
    }
    if (text.includes("grant_kind = 'limit'")) {
      return Promise.resolve({ rows: [...this.limitRows] as Row[] });
    }
    throw new Error(`unexpected SQL: ${text}`);
  }
}

const GRANT_BASE = {
  source_kind: "manual",
  source_reference: "fixture",
  subscription_snapshot_id: null,
  effective_at: new Date("2026-08-01T00:00:00Z"),
  expires_at: null,
  revoked_at: null,
};

Deno.test("capability lookup does not disclose a workspace to an outsider", async () => {
  const actualWorkspace = new EntitlementFixtureQuery(false);
  const missingWorkspace = new EntitlementFixtureQuery(false);
  const actual = await can(actualWorkspace, {
    actorUserId: "user_outside",
    workspaceId: "org_actual",
    capability: "tools.execute.fixture",
  });
  const missing = await can(missingWorkspace, {
    actorUserId: "user_outside",
    workspaceId: "org_missing",
    capability: "tools.execute.fixture",
  });
  assertEquals(actual, { kind: "workspace_unavailable" });
  assertEquals(missing, actual);
  assertEquals(actualWorkspace.calls.length, 1);
});

Deno.test("capability API asks only capability keys, never plan names", async () => {
  const query = new EntitlementFixtureQuery(true, [{
    ...GRANT_BASE,
    id: "grant_capability",
  }]);
  assertEquals(
    await can(query, {
      actorUserId: "user_member",
      workspaceId: "org_fixture",
      capability: "tools.execute.fixture",
    }),
    { kind: "allowed" },
  );
  assertEquals(query.calls.some((statement) => /plan/i.test(statement)), false);
});

Deno.test("capability resolution honors and snapshots future revocation", async () => {
  const query = new EntitlementFixtureQuery(true, [{
    ...GRANT_BASE,
    id: "grant_future_revocation",
    revoked_at: new Date("2026-09-01T00:00:00Z"),
  }]);
  const resolved = await resolveCapabilityAt(
    query,
    "org_fixture",
    "tools.execute.fixture",
    new Date("2026-08-23T12:00:00Z"),
  );

  assertEquals(resolved, {
    allowed: true,
    capability: "tools.execute.fixture",
    grants: [{
      id: "grant_future_revocation",
      sourceKind: "manual",
      sourceReference: "fixture",
      subscriptionSnapshotId: null,
      effectiveAt: "2026-08-01T00:00:00.000Z",
      expiresAt: null,
      revokedAt: "2026-09-01T00:00:00.000Z",
    }],
  });
  assertStringIncludes(
    query.calls[0],
    "(revoked_at is null or revoked_at > $3)",
  );
});

Deno.test("limit API adds compatible grants exactly", async () => {
  const query = new EntitlementFixtureQuery(true, [], [
    {
      ...GRANT_BASE,
      id: "grant_limit_a",
      limit_amount: "2.500000000",
      unit: "fixture_unit",
      period: "calendar_month",
    },
    {
      ...GRANT_BASE,
      id: "grant_limit_b",
      limit_amount: "3",
      unit: "fixture_unit",
      period: "calendar_month",
    },
  ]);
  assertEquals(
    await limit(query, {
      actorUserId: "user_member",
      workspaceId: "org_fixture",
      metric: "fixture.compute_units",
    }),
    {
      kind: "configured",
      limit: {
        kind: "limited",
        metric: "fixture.compute_units",
        unit: "fixture_unit",
        period: "calendar_month",
        amount: "5.5",
      },
    },
  );
});

Deno.test("an explicit unlimited grant dominates compatible finite grants", async () => {
  const query = new EntitlementFixtureQuery(true, [], [
    {
      ...GRANT_BASE,
      id: "grant_finite",
      limit_amount: "2.000000000",
      unit: "fixture_unit",
      period: "calendar_month",
    },
    {
      ...GRANT_BASE,
      id: "grant_unlimited",
      limit_amount: null,
      unit: "fixture_unit",
      period: "calendar_month",
    },
  ]);

  const resolved = await resolveLimitAt(
    query,
    "org_fixture",
    "fixture.compute_units",
    new Date("2026-08-23T12:00:00Z"),
  );
  assertEquals(resolved.kind, "configured");
  assertEquals(resolved.limit, {
    kind: "unlimited",
    metric: "fixture.compute_units",
    unit: "fixture_unit",
    period: "calendar_month",
  });
  assertEquals(resolved.grants.map((grant) => grant.amount), ["2", null]);
});

Deno.test("limit API fails closed on incompatible units or periods", async () => {
  const query = new EntitlementFixtureQuery(true, [], [
    {
      ...GRANT_BASE,
      id: "grant_limit_a",
      limit_amount: "2",
      unit: "fixture_unit",
      period: "calendar_month",
    },
    {
      ...GRANT_BASE,
      id: "grant_limit_b",
      limit_amount: "3",
      unit: "other_unit",
      period: "calendar_month",
    },
  ]);
  assertEquals(
    await limit(query, {
      actorUserId: "user_member",
      workspaceId: "org_fixture",
      metric: "fixture.compute_units",
    }),
    { kind: "invalid_configuration" },
  );
});
