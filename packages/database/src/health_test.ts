import { assertEquals } from "@std/assert";
import { createDatabasePool } from "./pool.ts";
import { checkDatabaseHealth, checkMigrationLedgerHealth } from "./health.ts";
import { MIGRATIONS } from "./migrations/manifest.ts";
import type { Migration } from "./migrations/types.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const hasDatabase = databaseUrl !== undefined;

Deno.test({
  name: "checkDatabaseHealth reports ok against a reachable database",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 2,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-api",
    );

    try {
      assertEquals(await checkDatabaseHealth(pool), {
        name: "database",
        status: "ok",
      });
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "checkMigrationLedgerHealth reports ok when the ledger matches the manifest",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 2,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-api",
    );

    try {
      assertEquals(await checkMigrationLedgerHealth(pool, MIGRATIONS), {
        name: "migrations",
        status: "ok",
      });
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name: "checkMigrationLedgerHealth reports an error on checksum drift",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 2,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-api",
    );

    // A manifest that agrees with the real ledger on every id/order but
    // disagrees on the very first migration's checksum -- simulating a
    // ledger row that was hand-edited or came from a different code
    // revision than this process's manifest.
    const driftedManifest: readonly Migration[] = MIGRATIONS.map(
      (migration, index) =>
        index === 0
          ? { ...migration, checksumSha256: "0".repeat(64) }
          : migration,
    );

    try {
      const result = await checkMigrationLedgerHealth(pool, driftedManifest);
      assertEquals(result.name, "migrations");
      assertEquals(result.status, "error");
    } finally {
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "checkMigrationLedgerHealth reports an error when migrations are pending",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 2,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-api",
    );

    // A manifest with one more migration than the real ledger has ever
    // applied -- simulating this process running code newer than what
    // `migrate up` has actually run against the database.
    const manifestWithPending: readonly Migration[] = [
      ...MIGRATIONS,
      {
        id: "9999_not_actually_applied",
        checksumSha256: "0".repeat(64),
        transactional: true,
        up: async () => {},
      },
    ];

    try {
      const result = await checkMigrationLedgerHealth(
        pool,
        manifestWithPending,
      );
      assertEquals(result.name, "migrations");
      assertEquals(result.status, "error");
      assertEquals(result.message, "pending migrations have not been applied");
    } finally {
      await pool.end();
    }
  },
});

Deno.test("checkDatabaseHealth reports a sanitized error against an unreachable database", async () => {
  const pool = createDatabasePool(
    {
      url: new URL("postgres://user:pass@127.0.0.1:1/does-not-exist"),
      poolMax: 1,
      connectTimeoutMs: 300,
      statementTimeoutMs: 1_000,
    },
    "relay-api",
  );

  try {
    const result = await checkDatabaseHealth(pool);
    assertEquals(result.name, "database");
    assertEquals(result.status, "error");
    assertEquals(result.message, "unreachable");
  } finally {
    await pool.end();
  }
});
