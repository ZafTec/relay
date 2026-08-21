import { assertEquals } from "@std/assert";
import { createDatabasePool, type DatabasePool } from "@relay/database";
import {
  grantSuperadmin,
  isSuperadmin,
  revokeSuperadmin,
} from "./system-roles.ts";

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

async function createUser(pool: DatabasePool, email: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into auth."user" (id, name, email, "emailVerified")
     values (gen_random_uuid()::text, 'Test', $1, true)
     returning id`,
    [email],
  );
  return result.rows[0].id;
}

async function reset(pool: DatabasePool): Promise<void> {
  await pool.query('delete from auth."user"');
}

Deno.test({
  name: "a user with no grant is not superadmin",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      await reset(pool);
      const userId = await createUser(pool, "nobody@example.com");
      assertEquals(await isSuperadmin(pool, userId), false);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "granting superadmin takes effect immediately",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      await reset(pool);
      const userId = await createUser(pool, "grantee@example.com");
      const operatorId = await createUser(pool, "operator@example.com");

      await grantSuperadmin(pool, userId, operatorId);
      assertEquals(await isSuperadmin(pool, userId), true);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "revoking superadmin takes effect immediately, without waiting for expiry",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      await reset(pool);
      const userId = await createUser(pool, "revokee@example.com");
      const operatorId = await createUser(pool, "operator2@example.com");

      await grantSuperadmin(pool, userId, operatorId);
      assertEquals(await isSuperadmin(pool, userId), true);

      await revokeSuperadmin(pool, userId, operatorId);
      assertEquals(await isSuperadmin(pool, userId), false);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "audit sink is invoked on grant and revoke",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = testPool();
    try {
      await reset(pool);
      const userId = await createUser(pool, "audited@example.com");
      const operatorId = await createUser(pool, "operator3@example.com");

      const grants: unknown[] = [];
      const revokes: unknown[] = [];
      const audit = {
        onGrant: (event: unknown) => {
          grants.push(event);
          return Promise.resolve();
        },
        onRevoke: (event: unknown) => {
          revokes.push(event);
          return Promise.resolve();
        },
      };

      await grantSuperadmin(pool, userId, operatorId, audit);
      await revokeSuperadmin(pool, userId, operatorId, audit);

      assertEquals(grants.length, 1);
      assertEquals(revokes.length, 1);
    } finally {
      await pool.end();
    }
  },
});
