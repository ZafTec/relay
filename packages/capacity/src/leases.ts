import type { Redis } from "@relay/queue";

/**
 * Expiring sorted-set concurrency leases, per "Redis keys and leases":
 * "Concurrency uses expiring sorted-set leases. Scripts remove expired
 * entries, check units, add a lease, and return lease ID/expiry."
 *
 * A lease can span several scopes at once (global-tool, capacity-pool,
 * workspace-total, workspace-tool, ...) and every check across those
 * scopes is all-or-none: this script purges expired entries on every key
 * first, then checks every key's count against its limit *before*
 * writing to any of them, so a denial on key 3 never consumes capacity
 * on keys 1-2. `leaseId` itself is the caller's proof of ownership for
 * renew/release -- nothing else authenticates those calls, so it must be
 * an unguessable random token, not a sequential ID.
 */
const ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local lease_id = ARGV[2]
local expires_at = tonumber(ARGV[3])
local n = #KEYS

for i = 1, n do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
end

for i = 1, n do
  local limit = tonumber(ARGV[3 + i])
  local count = redis.call('ZCARD', KEYS[i])
  if count >= limit then
    return {0, i, count, limit}
  end
end

for i = 1, n do
  redis.call('ZADD', KEYS[i], expires_at, lease_id)
end

return {1, lease_id, expires_at}
`.trim();

const RENEW_SCRIPT = `
local now = tonumber(ARGV[1])
local lease_id = ARGV[2]
local new_expires_at = tonumber(ARGV[3])
local n = #KEYS

for i = 1, n do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  local score = redis.call('ZSCORE', KEYS[i], lease_id)
  if not score then
    return {0, i}
  end
end

for i = 1, n do
  redis.call('ZADD', KEYS[i], new_expires_at, lease_id)
end

return {1, new_expires_at}
`.trim();

const RELEASE_SCRIPT = `
local lease_id = ARGV[1]
local n = #KEYS

for i = 1, n do
  redis.call('ZREM', KEYS[i], lease_id)
end

return 1
`.trim();

export interface LeaseClient extends Redis {
  relayAcquireLease(
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<[0, number, number, number] | [1, string, number]>;
  relayRenewLease(
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<[0, number] | [1, number]>;
  relayReleaseLease(
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<number>;
}

/**
 * Registers the lease Lua commands on a connection via ioredis
 * `defineCommand` -- BullMQ/ioredis's normal path for atomic multi-key
 * operations, and how these scripts survive a `SCRIPT FLUSH` (ioredis
 * re-`EVAL`s and re-caches on the next call automatically).
 */
/**
 * `numberOfKeys` is intentionally omitted from every definition below: a
 * fixed count would make ioredis auto-prepend it, but these scripts take
 * a variable number of scope keys per call. Omitting it means ioredis
 * sends `args` to `EVALSHA` unmodified, so the first argument at each
 * call site must be the actual key count -- see `acquireLease` etc.
 * below, which all pass `scopeKeys.length` first.
 */
export function defineLeaseCommands(connection: Redis): LeaseClient {
  const client = connection as LeaseClient;
  if (typeof client.relayAcquireLease !== "function") {
    connection.defineCommand("relayAcquireLease", { lua: ACQUIRE_SCRIPT });
  }
  if (typeof client.relayRenewLease !== "function") {
    connection.defineCommand("relayRenewLease", { lua: RENEW_SCRIPT });
  }
  if (typeof client.relayReleaseLease !== "function") {
    connection.defineCommand("relayReleaseLease", { lua: RELEASE_SCRIPT });
  }
  return client;
}

export interface AcquireLeaseResult {
  readonly ok: boolean;
  readonly leaseId?: string;
  readonly expiresAt?: number;
  readonly blockedScopeIndex?: number;
}

export async function acquireLease(
  client: LeaseClient,
  scopeKeys: readonly string[],
  scopeLimits: readonly number[],
  nowMs: number,
  leaseDurationMs: number,
): Promise<AcquireLeaseResult> {
  if (scopeKeys.length !== scopeLimits.length) {
    throw new Error("scopeKeys and scopeLimits must have equal length");
  }

  const leaseId = crypto.randomUUID();
  const expiresAt = nowMs + leaseDurationMs;
  const result = await client.relayAcquireLease(
    scopeKeys.length,
    ...scopeKeys,
    nowMs,
    leaseId,
    expiresAt,
    ...scopeLimits,
  );

  if (result[0] === 0) {
    return { ok: false, blockedScopeIndex: result[1] - 1 };
  }
  return { ok: true, leaseId: result[1], expiresAt: result[2] };
}

export async function renewLease(
  client: LeaseClient,
  scopeKeys: readonly string[],
  leaseId: string,
  nowMs: number,
  leaseDurationMs: number,
): Promise<{ ok: boolean; expiresAt?: number; blockedScopeIndex?: number }> {
  const newExpiresAt = nowMs + leaseDurationMs;
  const result = await client.relayRenewLease(
    scopeKeys.length,
    ...scopeKeys,
    nowMs,
    leaseId,
    newExpiresAt,
  );

  if (result[0] === 0) {
    return { ok: false, blockedScopeIndex: result[1] - 1 };
  }
  return { ok: true, expiresAt: result[1] };
}

export async function releaseLease(
  client: LeaseClient,
  scopeKeys: readonly string[],
  leaseId: string,
): Promise<void> {
  await client.relayReleaseLease(scopeKeys.length, ...scopeKeys, leaseId);
}
