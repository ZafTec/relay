/**
 * Redis key layout from
 * docs/implementation-handoff/04-queue-capacity-scheduling.md. The MVP uses a
 * single standalone Redis authority. The `{capacity}` tag keeps the layout
 * ready for a future, explicitly-designed cluster protocol without pretending
 * that today's cross-scope scripts support independently-sharded authorities.
 */
function prefix(env: string): string {
  return `relay:${env}:{capacity}`;
}

export function activeToolKey(env: string, toolKey: string): string {
  return `${prefix(env)}:active:tool:${toolKey}`;
}

export function activeWorkspaceKey(env: string, workspaceId: string): string {
  return `${prefix(env)}:active:workspace:${workspaceId}`;
}

export function activeWorkspaceToolKey(
  env: string,
  workspaceId: string,
  toolKey: string,
): string {
  return `${prefix(env)}:active:workspace:${workspaceId}:tool:${toolKey}`;
}

export function activePoolKey(env: string, poolId: string): string {
  return `${prefix(env)}:active:pool:${poolId}`;
}

/** Companion hash containing weighted/fenced metadata for a scope ZSET. */
export function leaseMetadataKey(scopeKey: string): string {
  return `${scopeKey}:leases`;
}

/** One live lease fence per durable job. */
export function executionLeaseJobKey(env: string, jobId: string): string {
  return `${prefix(env)}:lease:job:${encodeURIComponent(jobId)}`;
}

export function rateToolKey(env: string, toolKey: string): string {
  return `${prefix(env)}:rate:tool:${toolKey}`;
}

export function rateProviderKey(env: string, providerModelId: string): string {
  return `${prefix(env)}:rate:provider:${providerModelId}`;
}

export function cooldownKey(env: string, poolId: string): string {
  return `${prefix(env)}:cooldown:${poolId}`;
}
