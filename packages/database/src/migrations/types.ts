import type { Kysely } from "kysely";

/**
 * `checksumSha256` must be computed from canonical migration content (the
 * literal SQL text the migration runs), never from `up.toString()` or other
 * JavaScript function source serialization -- that breaks across formatting,
 * minification, and engine versions. Each migration module documents and
 * pins the exact SQL it hashes.
 */
export interface Migration {
  readonly id: string;
  readonly checksumSha256: string;
  readonly transactional: boolean;
  /**
   * Required, and must be non-empty, whenever `transactional` is `false`;
   * the migrator (see `validateManifest` in migrator.ts) refuses to run
   * an untransactional migration without one. Per
   * docs/implementation-handoff/02-runtime-database.md "Migration
   * format": "Initially prohibit non-transactional migrations. Add an
   * explicit reviewed mode only when an operation such as
   * `CREATE INDEX CONCURRENTLY` requires it." A bare `transactional:
   * false` is not that explicit reviewed mode -- a mandatory, visible
   * justification string in the migration's own source is.
   */
  readonly nonTransactionalReason?: string;
  up(db: Kysely<unknown>): Promise<void>;
}
