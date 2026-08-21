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
  up(db: Kysely<unknown>): Promise<void>;
}
