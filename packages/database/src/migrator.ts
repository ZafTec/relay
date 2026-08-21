import type pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import type { DatabasePool } from "./pool.ts";
import type { Migration } from "./migrations/types.ts";

/**
 * Single fixed advisory-lock key for the whole migration process. Any
 * process attempting to migrate contends for this one lock; a second
 * concurrent migrator blocks until the first releases it, then observes an
 * already-migrated ledger and applies nothing.
 */
const ADVISORY_LOCK_KEY_SQL = sql`hashtext('relay_migrations')::bigint`;

export interface LedgerEntry {
  readonly id: string;
  readonly checksumSha256: string;
  readonly appliedAt: string;
  readonly durationMs: number;
  readonly appVersion: string;
  readonly appRevision: string;
}

export interface MigrateUpResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export interface MigrateStatusResult {
  readonly applied: readonly LedgerEntry[];
  readonly pending: readonly string[];
}

interface LedgerRow {
  readonly id: string;
  readonly checksum_sha256: string;
  readonly applied_at: Date;
  readonly duration_ms: string;
  readonly app_version: string;
  readonly app_revision: string;
}

function validateManifest(manifest: readonly Migration[]): void {
  const seen = new Set<string>();
  for (const migration of manifest) {
    if (seen.has(migration.id)) {
      throw new Error(`duplicate migration id in manifest: ${migration.id}`);
    }
    seen.add(migration.id);
  }
}

function validateLedgerAgainstManifest(
  manifest: readonly Migration[],
  ledger: readonly LedgerRow[],
): void {
  for (let index = 0; index < ledger.length; index++) {
    const row = ledger[index];
    const migration = manifest[index];

    if (migration === undefined) {
      throw new Error(
        `applied migration is missing from the manifest: ${row.id}`,
      );
    }
    if (migration.id !== row.id) {
      throw new Error(
        `manifest order does not match applied history at position ${index}: ` +
          `expected "${migration.id}", already applied "${row.id}"`,
      );
    }
    if (migration.checksumSha256 !== row.checksum_sha256) {
      throw new Error(
        `checksum for already-applied migration "${row.id}" no longer matches the manifest`,
      );
    }
  }
}

/**
 * Binds one Kysely instance to a single already-checked-out `pg` client so
 * the session-level advisory lock, `SET ROLE`, and every migration in this
 * run share one PostgreSQL session. Kysely's own connection lifecycle is
 * neutralized (`release` is a no-op) because the migrator -- not Kysely --
 * owns when this connection returns to the pool.
 */
interface BoundKysely {
  readonly db: Kysely<unknown>;
  /** The client's true `release`, saved before it is neutralized below. */
  readonly releaseClient: (error?: Error) => void;
}

function bindKyselyToClient(client: pg.PoolClient): BoundKysely {
  const releaseClient = client.release.bind(client);

  // Kysely's PostgresDialect acquires and releases a connection around
  // every statement/transaction it runs, which would otherwise hand this
  // client back to the real pool mid-session -- breaking both the
  // session-level advisory lock and SET ROLE, which only hold for this one
  // PostgreSQL session. The migrator, not Kysely, decides when this
  // connection is actually done; only `releaseClient` above may do it.
  client.release = () => {};

  const singleConnectionPool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  } as unknown as pg.Pool;

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: singleConnectionPool }),
  });

  return { db, releaseClient };
}

async function ensureLedgerTable(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table if not exists relay.schema_migrations (
      id text primary key,
      checksum_sha256 char(64) not null,
      applied_at timestamptz not null default now(),
      duration_ms bigint not null,
      app_version text not null,
      app_revision text not null
    )
  `.execute(db);
}

async function readLedger(db: Kysely<unknown>): Promise<LedgerRow[]> {
  const result = await sql<LedgerRow>`
    select id, checksum_sha256, applied_at, duration_ms, app_version, app_revision
    from relay.schema_migrations
    order by applied_at asc, id asc
  `.execute(db);

  return [...result.rows];
}

interface MigratorSession {
  readonly db: Kysely<unknown>;
  readonly ledger: LedgerRow[];
  readonly release: () => Promise<void>;
}

/**
 * Acquires the dedicated connection, the session-level advisory lock, and
 * `relay_owner` privileges (via `SET ROLE`) needed for every migration DDL
 * statement. Callers must always invoke the returned `release` in a
 * `finally` block; it resets role, releases the advisory lock, and returns
 * the connection to the pool even if the caller throws.
 */
async function openMigratorSession(
  pool: DatabasePool,
): Promise<MigratorSession> {
  const client = await pool.connect();
  const { db, releaseClient } = bindKyselyToClient(client);

  let locked = false;
  try {
    await sql`select pg_advisory_lock(${ADVISORY_LOCK_KEY_SQL})`.execute(db);
    locked = true;
    await sql`set role relay_owner`.execute(db);
    await ensureLedgerTable(db);
    const ledger = await readLedger(db);

    return {
      db,
      ledger,
      release: async () => {
        try {
          await sql`reset role`.execute(db);
        } finally {
          try {
            if (locked) {
              await sql`select pg_advisory_unlock(${ADVISORY_LOCK_KEY_SQL})`
                .execute(db);
            }
          } finally {
            releaseClient();
          }
        }
      },
    };
  } catch (error) {
    try {
      if (locked) {
        await sql`select pg_advisory_unlock(${ADVISORY_LOCK_KEY_SQL})`
          .execute(db);
      }
    } finally {
      releaseClient();
    }
    throw error;
  }
}

export async function migrateUp(
  pool: DatabasePool,
  manifest: readonly Migration[],
  appVersion: string,
  appRevision: string,
): Promise<MigrateUpResult> {
  validateManifest(manifest);

  const session = await openMigratorSession(pool);
  try {
    validateLedgerAgainstManifest(manifest, session.ledger);
    const alreadyApplied = session.ledger.map((row) => row.id);
    const pending = manifest.slice(session.ledger.length);
    const applied: string[] = [];

    for (const migration of pending) {
      const startedAt = performance.now();

      const insertLedgerRow = async (db: Kysely<unknown>) => {
        const durationMs = Math.round(performance.now() - startedAt);
        await sql`
          insert into relay.schema_migrations
            (id, checksum_sha256, duration_ms, app_version, app_revision)
          values (${migration.id}, ${migration.checksumSha256}, ${durationMs}, ${appVersion}, ${appRevision})
        `.execute(db);
      };

      if (migration.transactional) {
        await session.db.transaction().execute(async (trx) => {
          await migration.up(trx);
          await insertLedgerRow(trx);
        });
      } else {
        await migration.up(session.db);
        await insertLedgerRow(session.db);
      }

      applied.push(migration.id);
    }

    return { applied, alreadyApplied };
  } finally {
    await session.release();
  }
}

export async function migrateStatus(
  pool: DatabasePool,
  manifest: readonly Migration[],
): Promise<MigrateStatusResult> {
  validateManifest(manifest);

  const session = await openMigratorSession(pool);
  try {
    validateLedgerAgainstManifest(manifest, session.ledger);

    const applied: LedgerEntry[] = session.ledger.map((row) => ({
      id: row.id,
      checksumSha256: row.checksum_sha256,
      appliedAt: row.applied_at.toISOString(),
      durationMs: Number(row.duration_ms),
      appVersion: row.app_version,
      appRevision: row.app_revision,
    }));
    const pending = manifest.slice(session.ledger.length).map((m) => m.id);

    return { applied, pending };
  } finally {
    await session.release();
  }
}
