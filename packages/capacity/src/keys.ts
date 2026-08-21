/**
 * Redis key layout from
 * docs/implementation-handoff/04-queue-capacity-scheduling.md
 * "Redis keys and leases". The `{capacity}` hash tag keeps every
 * coordination key for one environment in the same Cluster slot -- unused
 * today (Redis Cluster is out of scope for the MVP, per that section) but
 * free to keep now so a later move doesn't have to rewrite every key
 * builder.
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

export function rateToolKey(env: string, toolKey: string): string {
  return `${prefix(env)}:rate:tool:${toolKey}`;
}

export function rateProviderKey(env: string, providerModelId: string): string {
  return `${prefix(env)}:rate:provider:${providerModelId}`;
}

export function cooldownKey(env: string, poolId: string): string {
  return `${prefix(env)}:cooldown:${poolId}`;
}
