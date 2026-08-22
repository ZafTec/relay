import type { ReadinessCheck } from "@relay/contracts";
import type { DatabasePool } from "./pool.ts";
import type { Migration } from "./migrations/types.ts";

/**
 * Proves only that the pool can reach PostgreSQL and run a trivial query.
 * Never includes connection strings or raw driver errors in the result --
 * those may contain host/credential detail.
 */
export async function checkDatabaseHealth(
  pool: DatabasePool,
): Promise<ReadinessCheck> {
  try {
    await pool.query("select 1");
    return { name: "database", status: "ok" };
  } catch {
    return {
      name: "database",
      status: "error",
      message: "unreachable",
    };
  }
}

interface LedgerIdentityRow {
  readonly id: string;
  readonly checksum_sha256: string;
}

/**
 * `select 1` alone proves connectivity, not that this process's schema
 * expectations match reality: a hand-edited ledger, a rollback to an
 * older schema snapshot, or a deploy that skipped `migrate up` all leave
 * the database reachable while genuinely mismatched with the running
 * app's manifest. Every migration this app knows about, in order, must
 * appear in the ledger with a matching checksum -- the same rule
 * `migrateUp`/`migrateStatus` enforce before touching anything, just
 * read-only here so it can run under `relay_app` (readiness runs in the
 * API process, which never holds `relay_owner`) with no advisory lock or
 * `SET ROLE`. Pending migrations (a ledger shorter than the manifest)
 * count as not ready, not merely "behind" -- this process must not serve
 * traffic against a schema state it wasn't written for.
 */
export async function checkMigrationLedgerHealth(
  pool: DatabasePool,
  manifest: readonly Migration[],
): Promise<ReadinessCheck> {
  try {
    const { rows: ledger } = await pool.query<LedgerIdentityRow>(
      `select id, checksum_sha256 from relay.schema_migrations
       order by applied_at asc, id asc`,
    );

    for (let index = 0; index < ledger.length; index++) {
      const row = ledger[index];
      const migration = manifest[index];
      if (migration === undefined || migration.id !== row.id) {
        return {
          name: "migrations",
          status: "error",
          message:
            "ledger order does not match the expected migration manifest",
        };
      }
      if (migration.checksumSha256 !== row.checksum_sha256) {
        return {
          name: "migrations",
          status: "error",
          message:
            "checksum drift between the ledger and the migration manifest",
        };
      }
    }

    if (ledger.length < manifest.length) {
      return {
        name: "migrations",
        status: "error",
        message: "pending migrations have not been applied",
      };
    }

    return { name: "migrations", status: "ok" };
  } catch {
    return {
      name: "migrations",
      status: "error",
      message: "unable to read the migration ledger",
    };
  }
}
