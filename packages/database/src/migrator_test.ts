import { assertEquals, assertRejects } from "@std/assert";
import pg from "pg";
import { sql } from "kysely";
import { createDatabasePool } from "./pool.ts";
import { migrateStatus, migrateUp } from "./migrator.ts";
import { sha256Hex } from "./migrations/checksum.ts";
import type { Migration } from "./migrations/types.ts";

/**
 * These are live-PostgreSQL integration tests. They run only when
 * MIGRATOR_TEST_DATABASE_URL is set (see compose.dev.yaml and
 * scripts/dev/postgres-init/002-test-database.sql) and connect as
 * `relay_migrator` so `SET ROLE relay_owner` succeeds, matching production
 * connection identity for the migrate command. They are skipped, not
 * failed, when no database is configured so `deno task check` stays
 * runnable without live infrastructure.
 *
 * This file's tests are unlike every other package's live-database tests:
 * they don't just write scoped, generated-ID rows into real tables, they
 * drop and recreate `relay.schema_migrations` itself and replay the
 * migration manifest against fixture migrations -- exercising the migrator
 * against ledger state, not application data. Pointed at whatever a
 * generic DATABASE_URL happens to resolve to, that drops the real
 * migration ledger; it has actually happened in this repo's history. A
 * dedicated env var plus `assertDisposableTestDatabase` below is the
 * guard: this suite refuses to run rather than silently operate on the
 * wrong database.
 */
const databaseUrl = Deno.env.get("MIGRATOR_TEST_DATABASE_URL");
const hasDatabase = databaseUrl !== undefined;

const APP_VERSION = "test";
const APP_REVISION = "test-revision";

/**
 * Refuses to proceed unless the connection string's database name ends in
 * `_test` -- e.g. the disposable `relay_test` database created by
 * scripts/dev/postgres-init/002-test-database.sql, never `relay` itself.
 * Called before every destructive operation in this file, not just once at
 * module load, so a misconfigured env var fails loudly at the point of
 * damage rather than depending on every test remembering to check.
 */
function assertDisposableTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(
      `refusing to run destructive migrator tests against database "${name}" ` +
        `(from MIGRATOR_TEST_DATABASE_URL) -- its name must end in "_test", ` +
        `e.g. "relay_test", so these tests can never target the real ` +
        `migration ledger`,
    );
  }
}

if (hasDatabase) {
  assertDisposableTestDatabase(databaseUrl!);
}

function appUrlFrom(migratorUrl: string): string {
  const url = new URL(migratorUrl);
  url.username = "relay_app";
  url.password = "relay_dev_only";
  return url.toString();
}

async function resetDatabase(): Promise<void> {
  assertDisposableTestDatabase(databaseUrl!);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("set role relay_owner");
    await client.query(
      "drop table if exists relay.probe_a, relay.probe_b, relay.probe_fail",
    );
    await client.query(
      "drop table if exists relay.schema_migrations",
    );
    await client.query("reset role");
  } finally {
    await client.end();
  }
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  // `to_regclass` resolves an identifier against the catalog regardless of
  // the connecting role's table-level privileges. `information_schema.tables`
  // looks like the obvious choice here but is privilege-filtered per role --
  // relay_migrator (which these tests connect as) is never granted SELECT on
  // tables it creates as relay_owner, so it would silently show nothing for
  // tables that genuinely exist. That cost real debugging time; keep this
  // comment so nobody reintroduces it.
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ reg: string | null }>(
      "select to_regclass($1)::text as reg",
      [`${schema}.${table}`],
    );
    return result.rows[0]?.reg !== null;
  } finally {
    await client.end();
  }
}

async function fixtureMigration(
  id: string,
  tableName: string,
  options: { transactional?: boolean; shouldFail?: boolean } = {},
): Promise<Migration> {
  const canonicalSql = `create table relay.${tableName} (id int primary key)`;

  return {
    id,
    checksumSha256: await sha256Hex(canonicalSql),
    transactional: options.transactional ?? true,
    up: async (db) => {
      await sql.raw(canonicalSql).execute(db);
      if (options.shouldFail) {
        throw new Error(`fixture migration ${id} intentionally failed`);
      }
    },
  };
}

Deno.test({
  name: "migrateUp applies migrations in order and records the ledger",
  ignore: !hasDatabase,
  fn: async () => {
    await resetDatabase();
    const pool = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 5,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-migrate",
    );

    try {
      const migrations = [
        await fixtureMigration("0001_probe_a", "probe_a"),
        await fixtureMigration("0002_probe_b", "probe_b"),
      ];

      const result = await migrateUp(
        pool,
        migrations,
        APP_VERSION,
        APP_REVISION,
      );

      assertEquals(result.applied, ["0001_probe_a", "0002_probe_b"]);
      assertEquals(result.alreadyApplied, []);
      assertEquals(await tableExists("relay", "probe_a"), true);
      assertEquals(await tableExists("relay", "probe_b"), true);

      const status = await migrateStatus(pool, migrations);
      assertEquals(status.pending, []);
      assertEquals(status.applied.map((entry) => entry.id), [
        "0001_probe_a",
        "0002_probe_b",
      ]);
      assertEquals(status.applied[0].appVersion, APP_VERSION);
      assertEquals(status.applied[0].appRevision, APP_REVISION);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "re-running migrateUp against an already-migrated database is a no-op",
  ignore: !hasDatabase,
  fn: async () => {
    await resetDatabase();
    const pool = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 5,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-migrate",
    );

    try {
      const migrations = [await fixtureMigration("0001_probe_a", "probe_a")];

      const first = await migrateUp(
        pool,
        migrations,
        APP_VERSION,
        APP_REVISION,
      );
      assertEquals(first.applied, ["0001_probe_a"]);

      const second = await migrateUp(
        pool,
        migrations,
        APP_VERSION,
        APP_REVISION,
      );
      assertEquals(second.applied, []);
      assertEquals(second.alreadyApplied, ["0001_probe_a"]);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "a changed historical checksum is refused before any DDL runs",
  ignore: !hasDatabase,
  fn: async () => {
    await resetDatabase();
    const pool = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 5,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-migrate",
    );

    try {
      const original = [await fixtureMigration("0001_probe_a", "probe_a")];
      await migrateUp(pool, original, APP_VERSION, APP_REVISION);

      const tampered: Migration[] = [
        { ...original[0], checksumSha256: "0".repeat(64) },
        await fixtureMigration("0002_probe_b", "probe_b"),
      ];

      await assertRejects(
        () => migrateUp(pool, tampered, APP_VERSION, APP_REVISION),
        Error,
        "checksum",
      );

      // The second migration must not have run because validation happens
      // before any pending migration is applied.
      assertEquals(await tableExists("relay", "probe_b"), false);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "a failing transactional migration rolls back its DDL and ledger row",
  ignore: !hasDatabase,
  fn: async () => {
    await resetDatabase();
    const pool = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 5,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-migrate",
    );

    try {
      const migrations = [
        await fixtureMigration("0001_probe_fail", "probe_fail", {
          shouldFail: true,
        }),
      ];

      await assertRejects(
        () => migrateUp(pool, migrations, APP_VERSION, APP_REVISION),
        Error,
        "intentionally failed",
      );

      assertEquals(await tableExists("relay", "probe_fail"), false);

      const status = await migrateStatus(pool, migrations);
      assertEquals(status.applied, []);
      assertEquals(status.pending, ["0001_probe_fail"]);
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "two concurrent migrators converge on one application and one no-op",
  ignore: !hasDatabase,
  fn: async () => {
    await resetDatabase();
    const poolA = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 5,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-migrate",
    );
    const poolB = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 5,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-migrate",
    );

    try {
      const migrations = [await fixtureMigration("0001_probe_a", "probe_a")];

      const [resultA, resultB] = await Promise.all([
        migrateUp(poolA, migrations, APP_VERSION, APP_REVISION),
        migrateUp(poolB, migrations, APP_VERSION, APP_REVISION),
      ]);

      const applied = [...resultA.applied, ...resultB.applied];
      assertEquals(applied, ["0001_probe_a"]);

      const noOp = resultA.applied.length === 0 ? resultA : resultB;
      assertEquals(noOp.alreadyApplied, ["0001_probe_a"]);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  },
});

Deno.test({
  name: "relay_app cannot run migrations (cannot SET ROLE relay_owner)",
  ignore: !hasDatabase,
  fn: async () => {
    await resetDatabase();
    const appPool = createDatabasePool(
      {
        url: new URL(appUrlFrom(databaseUrl!)),
        poolMax: 2,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-migrate",
    );

    try {
      const migrations = [await fixtureMigration("0001_probe_a", "probe_a")];

      await assertRejects(
        () => migrateUp(appPool, migrations, APP_VERSION, APP_REVISION),
        Error,
      );
    } finally {
      await appPool.end();
    }
  },
});

Deno.test({
  name:
    "relay_app cannot insert, update, or delete relay.schema_migrations directly",
  ignore: !hasDatabase,
  fn: async () => {
    await resetDatabase();

    // Run a real migration as relay_migrator first so the ledger table
    // exists (and has the row this test tries to tamper with) exactly as
    // it would in production -- ensureLedgerTable() is what applies the
    // revoke, so this also proves the revoke actually ran, not just that
    // the grants were never present.
    const migratorPool = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 2,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-migrate",
    );
    try {
      const migrations = [await fixtureMigration("0001_probe_a", "probe_a")];
      await migrateUp(migratorPool, migrations, APP_VERSION, APP_REVISION);
    } finally {
      await migratorPool.end();
    }

    const appClient = new pg.Client({
      connectionString: appUrlFrom(databaseUrl!),
    });
    await appClient.connect();
    try {
      await assertRejects(
        () =>
          appClient.query(
            "update relay.schema_migrations set app_version = 'hacked' where id = $1",
            ["0001_probe_a"],
          ),
        Error,
        "permission denied",
      );
      await assertRejects(
        () =>
          appClient.query(
            "delete from relay.schema_migrations where id = $1",
            ["0001_probe_a"],
          ),
        Error,
        "permission denied",
      );
      await assertRejects(
        () =>
          appClient.query(
            `insert into relay.schema_migrations
               (id, checksum_sha256, duration_ms, app_version, app_revision)
             values ('forged', repeat('0', 64), 0, 'x', 'x')`,
          ),
        Error,
        "permission denied",
      );

      // SELECT must still work -- readiness checks and status reporting
      // read this table as relay_app.
      const { rows } = await appClient.query<{ id: string }>(
        "select id from relay.schema_migrations where id = $1",
        ["0001_probe_a"],
      );
      assertEquals(rows.length, 1);
    } finally {
      await appClient.end();
    }
  },
});
