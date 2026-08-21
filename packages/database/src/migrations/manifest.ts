import type { Migration } from "./types.ts";
import { migration as betterAuthCore } from "./0001_better_auth_core.ts";
import { migration as personalWorkspaces } from "./0002_personal_workspaces.ts";
import { migration as systemRoleAssignments } from "./0003_system_role_assignments.ts";
import { migration as betterAuthRateLimit } from "./0004_better_auth_rate_limit.ts";

/**
 * Immutable, statically imported migration history, in application order.
 * One lane owns this file (see docs/implementation-handoff/01-execution-waves.md
 * "Shared ownership rules"): the database owner allocates migration IDs and
 * merges entries here; feature lanes submit migration modules for review
 * rather than editing this array concurrently.
 *
 * The bootstrap ledger table (`relay.schema_migrations`) is managed
 * directly by the migrator, not listed here, because nothing can be
 * applied before it exists.
 */
export const MIGRATIONS: readonly Migration[] = [
  betterAuthCore,
  personalWorkspaces,
  systemRoleAssignments,
  betterAuthRateLimit,
];
