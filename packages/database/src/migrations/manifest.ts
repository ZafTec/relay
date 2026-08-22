import type { Migration } from "./types.ts";
import { migration as betterAuthCore } from "./0001_better_auth_core.ts";
import { migration as personalWorkspaces } from "./0002_personal_workspaces.ts";
import { migration as systemRoleAssignments } from "./0003_system_role_assignments.ts";
import { migration as betterAuthRateLimit } from "./0004_better_auth_rate_limit.ts";
import { migration as auditEvents } from "./0005_audit_events.ts";
import { migration as capacityPoolsAndPolicies } from "./0006_capacity_pools_and_policies.ts";
import { migration as toolRuns } from "./0007_tool_runs.ts";
import { migration as idempotencyRecords } from "./0008_idempotency_records.ts";
import { migration as executionJobsAndAttempts } from "./0009_execution_jobs_and_attempts.ts";
import { migration as queueCounters } from "./0010_queue_counters.ts";
import { migration as executionCapacityLeases } from "./0011_execution_capacity_leases.ts";
import { migration as outboxEvents } from "./0012_outbox_events.ts";
import { migration as toolRegistry } from "./0013_tool_registry.ts";
import { migration as providerRegistry } from "./0014_provider_registry.ts";
import { migration as routingPolicies } from "./0015_routing_policies.ts";
import { migration as toolProviderBindings } from "./0016_tool_provider_bindings.ts";
import { migration as routingDecisions } from "./0017_routing_decisions.ts";

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
  auditEvents,
  capacityPoolsAndPolicies,
  toolRuns,
  idempotencyRecords,
  executionJobsAndAttempts,
  queueCounters,
  executionCapacityLeases,
  outboxEvents,
  toolRegistry,
  providerRegistry,
  routingPolicies,
  toolProviderBindings,
  routingDecisions,
];
