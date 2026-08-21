import type { Migration } from "./types.ts";

/**
 * Immutable, statically imported migration history, in application order.
 * One lane owns this file (see docs/implementation-handoff/01-execution-waves.md
 * "Shared ownership rules"): the database owner allocates migration IDs and
 * merges entries here; feature lanes submit migration modules for review
 * rather than editing this array concurrently.
 *
 * Intentionally empty as of Wave 1 -- no domain or Better Auth schema has
 * been reviewed yet. The bootstrap ledger table
 * (`relay.schema_migrations`) is managed directly by the migrator, not
 * listed here, because nothing can be applied before it exists.
 */
export const MIGRATIONS: readonly Migration[] = [];
