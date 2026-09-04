import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import {
  ensurePersonalWorkspace,
  personalWorkspaceSlug,
} from "./workspaces.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const privilegedDatabaseUrl = Deno.env.get("AUTH_SECURITY_TEST_DATABASE_URL");
const hasDatabase = databaseUrl !== undefined;
const GRANT_ID_NAMESPACE = "relay:mvp-entitlement:v1";
const GRANT_SOURCE_KIND = "system";
const GRANT_SOURCE_REFERENCE = "relay.mvp.defaults.v1";

interface BootstrapGrantRow {
  id: string;
  entitlement_key: string;
  grant_kind: string;
  capability_enabled: boolean | null;
  limit_amount: string | null;
  unit: string | null;
  period: string | null;
  source_kind: string;
  source_reference: string | null;
  metadata: Record<string, unknown>;
  effective_at: Date;
  created_at: Date;
}

const EXPECTED_BOOTSTRAP_GRANTS = [
  {
    entitlementKey: "images.generated",
    grantKind: "limit",
    capabilityEnabled: null,
    limitAmount: null,
    unit: "image",
    period: "calendar_month",
  },
  {
    entitlementKey: "ocr.requests",
    grantKind: "limit",
    capabilityEnabled: null,
    limitAmount: null,
    unit: "request",
    period: "calendar_month",
  },
  {
    entitlementKey: "tools.execute",
    grantKind: "capability",
    capabilityEnabled: true,
    limitAmount: null,
    unit: null,
    period: null,
  },
] as const;

function testPool(url = databaseUrl!): DatabasePool {
  return createDatabasePool(
    {
      url: new URL(url),
      poolMax: 5,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
    },
    "relay-api",
  );
}

function unique(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

async function createUser(pool: DatabasePool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth."user" (id, name, email, "emailVerified")
     values (gen_random_uuid()::text, 'Test', $1, true)
     returning id`,
    [`${unique("user")}@example.com`],
  );
  return rows[0].id;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function expectedBootstrapGrantId(
  workspaceId: string,
  entitlementKey: string,
  grantKind: string,
): Promise<string> {
  const identity =
    `${GRANT_ID_NAMESPACE}:${workspaceId}:${entitlementKey}:${grantKind}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  return `grant_${bytesToHex(new Uint8Array(digest))}`;
}

async function bootstrapGrants(
  pool: DatabasePool,
  workspaceId: string,
): Promise<BootstrapGrantRow[]> {
  const { rows } = await pool.query<BootstrapGrantRow>(
    `select id, entitlement_key, grant_kind, capability_enabled,
            limit_amount::text, unit, period, source_kind, source_reference,
            metadata, effective_at, created_at
       from relay.entitlement_grants
      where workspace_id = $1
        and source_kind = $2
        and source_reference = $3
      order by entitlement_key, grant_kind, id`,
    [workspaceId, GRANT_SOURCE_KIND, GRANT_SOURCE_REFERENCE],
  );
  return rows;
}

async function assertBootstrapGrants(
  pool: DatabasePool,
  workspaceId: string,
): Promise<BootstrapGrantRow[]> {
  const grants = await bootstrapGrants(pool, workspaceId);
  const expected = await Promise.all(
    EXPECTED_BOOTSTRAP_GRANTS.map(async (definition) => ({
      id: await expectedBootstrapGrantId(
        workspaceId,
        definition.entitlementKey,
        definition.grantKind,
      ),
      entitlement_key: definition.entitlementKey,
      grant_kind: definition.grantKind,
      capability_enabled: definition.capabilityEnabled,
      limit_amount: definition.limitAmount,
      unit: definition.unit,
      period: definition.period,
      source_kind: GRANT_SOURCE_KIND,
      source_reference: GRANT_SOURCE_REFERENCE,
      metadata: { seed: GRANT_SOURCE_REFERENCE },
    })),
  );

  assertEquals(
    grants.map((
      { effective_at: _effectiveAt, created_at: _createdAt, ...grant },
    ) => grant),
    expected,
  );
  for (const grant of grants) {
    assertEquals(grant.effective_at, grant.created_at);
  }
  return grants;
}

async function deleteEntitlementGrantsForTest(
  pool: DatabasePool,
  workspaceId: string,
  entitlementKey?: string,
): Promise<number> {
  const privilegedPool = privilegedDatabaseUrl === undefined
    ? pool
    : testPool(privilegedDatabaseUrl);
  const client = await privilegedPool.connect();
  try {
    await client.query("begin");
    try {
      await client.query("set local role relay_owner");
      await client.query(
        `alter table relay.entitlement_grants
         disable trigger entitlement_grants_mutation_guard`,
      );
      const deleted = entitlementKey === undefined
        ? await client.query(
          "delete from relay.entitlement_grants where workspace_id = $1",
          [workspaceId],
        )
        : await client.query(
          `delete from relay.entitlement_grants
            where workspace_id = $1
              and entitlement_key = $2
              and source_kind = $3
              and source_reference = $4`,
          [
            workspaceId,
            entitlementKey,
            GRANT_SOURCE_KIND,
            GRANT_SOURCE_REFERENCE,
          ],
        );
      await client.query(
        `alter table relay.entitlement_grants
         enable trigger entitlement_grants_mutation_guard`,
      );
      await client.query("commit");
      return deleted.rowCount ?? 0;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
    if (privilegedPool !== pool) await privilegedPool.end();
  }
}

async function cleanup(pool: DatabasePool, userId: string): Promise<void> {
  const { rows } = await pool.query<{ organization_id: string | null }>(
    "select organization_id from relay.personal_workspaces where user_id = $1",
    [userId],
  );
  const organizationId = rows[0]?.organization_id;
  if (organizationId) {
    await deleteEntitlementGrantsForTest(pool, organizationId);
  }
  await pool.query('delete from auth."user" where id = $1', [userId]);
  if (organizationId) {
    await pool.query("delete from auth.organization where id = $1", [
      organizationId,
    ]);
  }
}

Deno.test("personal workspace slugs are stable and opaque", async () => {
  const userId = "user-with-sensitive@example.com";
  const first = await personalWorkspaceSlug(userId);
  const second = await personalWorkspaceSlug(userId);

  assertEquals(first, second);
  assertEquals(first.includes(userId), false);
  assertEquals(/^personal-[0-9a-f]{32}$/.test(first), true);
});

Deno.test({
  name:
    "ensurePersonalWorkspace creates an organization, owner membership, and bootstrap grants for a new user",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);
      const organizationId = await ensurePersonalWorkspace(pool, userId);
      assertExists(organizationId);

      const membership = await pool.query<{ role: string }>(
        `select role from auth.member where "organizationId" = $1 and "userId" = $2`,
        [organizationId, userId],
      );
      assertEquals(membership.rows.length, 1);
      assertEquals(membership.rows[0].role, "owner");
      await assertBootstrapGrants(pool, organizationId);
    } finally {
      if (userId) await cleanup(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "ensurePersonalWorkspace is idempotent and does not duplicate grants on repeat",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);

      const first = await ensurePersonalWorkspace(pool, userId);
      const initialGrants = await assertBootstrapGrants(pool, first);
      const second = await ensurePersonalWorkspace(pool, userId);
      assertEquals(second, first);
      assertEquals(await bootstrapGrants(pool, first), initialGrants);

      const members = await pool.query(
        `select id from auth.member where "organizationId" = $1 and "userId" = $2`,
        [first, userId],
      );
      assertEquals(
        members.rows.length,
        1,
        "calling it again must not create a second membership row",
      );
    } finally {
      if (userId) await cleanup(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "concurrent first-sign-in provisioning creates one workspace and exactly-once grants",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);

      const results = await Promise.all(
        Array.from(
          { length: 5 },
          () => ensurePersonalWorkspace(pool, userId!),
        ),
      );

      const organizationIds = new Set(results);
      assertEquals(
        organizationIds.size,
        1,
        "every concurrent call must converge on one organization",
      );

      const members = await pool.query(
        `select id from auth.member where "organizationId" = $1 and "userId" = $2`,
        [results[0], userId],
      );
      assertEquals(members.rows.length, 1);
      await assertBootstrapGrants(pool, results[0]);

      const organizations = await pool.query(
        "select id from auth.organization where slug = $1",
        [await personalWorkspaceSlug(userId)],
      );
      assertEquals(
        organizations.rows.length,
        1,
        "a losing concurrent caller must not leave an orphan organization",
      );
    } finally {
      if (userId) await cleanup(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name: "ensurePersonalWorkspace heals a missing personal-workspace membership",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);
      const organizationId = await ensurePersonalWorkspace(pool, userId);
      await pool.query(
        `delete from auth.member where "organizationId" = $1 and "userId" = $2`,
        [organizationId, userId],
      );

      assertEquals(await ensurePersonalWorkspace(pool, userId), organizationId);

      const membership = await pool.query<{ role: string }>(
        `select role from auth.member where "organizationId" = $1 and "userId" = $2`,
        [organizationId, userId],
      );
      assertEquals(membership.rows, [{ role: "owner" }]);
    } finally {
      if (userId) await cleanup(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name: "ensurePersonalWorkspace repairs a missing bootstrap grant",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);
      const organizationId = await ensurePersonalWorkspace(pool, userId);
      const initialGrants = await assertBootstrapGrants(pool, organizationId);
      const missingGrant = initialGrants.find((grant) =>
        grant.entitlement_key === "ocr.requests"
      );
      assertExists(missingGrant);

      assertEquals(
        await deleteEntitlementGrantsForTest(
          pool,
          organizationId,
          missingGrant.entitlement_key,
        ),
        1,
      );
      assertEquals((await bootstrapGrants(pool, organizationId)).length, 2);

      assertEquals(await ensurePersonalWorkspace(pool, userId), organizationId);
      const repairedGrants = await assertBootstrapGrants(pool, organizationId);
      assertEquals(
        repairedGrants.find((grant) =>
          grant.entitlement_key === missingGrant.entitlement_key
        )?.id,
        missingGrant.id,
        "repair must recreate the deterministic grant ID",
      );
    } finally {
      if (userId) await cleanup(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name: "ensurePersonalWorkspace heals a downgraded personal-workspace owner",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    let userId: string | undefined;
    try {
      userId = await createUser(pool);
      const organizationId = await ensurePersonalWorkspace(pool, userId);
      await pool.query(
        `update auth.member set role = 'member'
         where "organizationId" = $1 and "userId" = $2`,
        [organizationId, userId],
      );

      assertEquals(await ensurePersonalWorkspace(pool, userId), organizationId);

      const membership = await pool.query<{ role: string }>(
        `select role from auth.member where "organizationId" = $1 and "userId" = $2`,
        [organizationId, userId],
      );
      assertEquals(membership.rows, [{ role: "owner" }]);
    } finally {
      if (userId) await cleanup(pool, userId);
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "failed provisioning rolls the organization back instead of orphaning it",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    const missingUserId = unique("missing-user");
    const slug = await personalWorkspaceSlug(missingUserId);
    try {
      await assertRejects(() => ensurePersonalWorkspace(pool, missingUserId));

      const organizations = await pool.query(
        "select 1 from auth.organization where slug = $1",
        [slug],
      );
      assertEquals(organizations.rowCount, 0);
    } finally {
      await pool.query("delete from auth.organization where slug = $1", [slug]);
      await pool.end();
    }
  },
});
