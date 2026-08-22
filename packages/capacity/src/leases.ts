import type { Redis } from "ioredis";

const LEASE_SCRIPT_HELPERS = `
local function metadata_key(scope_key)
  return scope_key .. ':leases'
end

local function refresh_scope_ttl(scope_key)
  local metadata = metadata_key(scope_key)
  local latest = redis.call('ZREVRANGE', scope_key, 0, 0, 'WITHSCORES')
  if #latest == 0 then
    redis.call('DEL', scope_key)
    redis.call('DEL', metadata)
    return
  end

  local expires_at = math.ceil(tonumber(latest[2]))
  redis.call('PEXPIREAT', scope_key, expires_at)
  redis.call('PEXPIREAT', metadata, expires_at)
end

local function cleanup_scope(scope_key, now)
  local metadata = metadata_key(scope_key)
  local expired = redis.call('ZRANGEBYSCORE', scope_key, '-inf', now)
  for _, lease_id in ipairs(expired) do
    redis.call('ZREM', scope_key, lease_id)
    redis.call('HDEL', metadata, lease_id)
  end
  refresh_scope_ttl(scope_key)
end

local function remove_lease(scope_key, lease_id, now)
  cleanup_scope(scope_key, now)
  redis.call('ZREM', scope_key, lease_id)
  redis.call('HDEL', metadata_key(scope_key), lease_id)
  refresh_scope_ttl(scope_key)
end

local function scope_usage(scope_key)
  local usage = 0
  local values = redis.call('HVALS', metadata_key(scope_key))
  for _, raw in ipairs(values) do
    local lease = cjson.decode(raw)
    if lease.units == nil then
      error('weighted lease metadata is missing units')
    end
    usage = usage + tonumber(lease.units)
  end
  return usage
end

local function same_scope_list(left, right)
  if #left ~= #right then
    return false
  end
  for i = 1, #left do
    if left[i] ~= right[i] then
      return false
    end
  end
  return true
end

local function metadata_matches(raw, units, owner_id, job_id, lease_epoch)
  if not raw then
    return false
  end
  local lease = cjson.decode(raw)
  return tonumber(lease.units) == units
    and lease.ownerId == owner_id
    and lease.jobId == job_id
    and tonumber(lease.leaseEpoch) == lease_epoch
end
`.trim();

/**
 * Weighted, expiring semaphore acquisition across every configured scope.
 *
 * The first key is a per-job fence and the remaining keys are scope expiry
 * sorted sets. Each scope has a companion hash (`<scope>:leases`) holding the
 * units and fence identity for every member. Expired members are removed before
 * usage is summed, all limits are checked before any write, and every key gets
 * an absolute TTL equal to its latest lease expiry. Redis `TIME` is the only
 * clock used by the script.
 *
 * A newer lease epoch atomically supersedes the same job's older lease. The old
 * scope list is read from the trusted fence record and cleaned even if routing
 * changed between epochs. That dynamic-key cleanup deliberately relies on the
 * documented standalone-Redis MVP; all Relay keys still share `{capacity}` for
 * a future explicitly-designed cluster protocol.
 */
const ACQUIRE_SCRIPT = `
${LEASE_SCRIPT_HELPERS}

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local job_key = KEYS[1]
local lease_id = ARGV[1]
local lease_duration_ms = tonumber(ARGV[2])
local units = tonumber(ARGV[3])
local owner_id = ARGV[4]
local job_id = ARGV[5]
local lease_epoch = tonumber(ARGV[6])
local requested_scopes = cjson.decode(ARGV[7])
local expires_at = now + lease_duration_ms
local scope_count = #KEYS - 1

for i = 2, #KEYS do
  cleanup_scope(KEYS[i], now)
end

local existing_raw = redis.call('GET', job_key)
if existing_raw then
  local existing = cjson.decode(existing_raw)
  if tonumber(existing.expiresAt) <= now then
    redis.call('DEL', job_key)
    existing_raw = false
  elseif lease_epoch < tonumber(existing.leaseEpoch) then
    return {3, tostring(existing.leaseEpoch)}
  elseif lease_epoch == tonumber(existing.leaseEpoch) then
    if existing.ownerId ~= owner_id then
      return {3, tostring(existing.leaseEpoch)}
    end

    if tonumber(existing.units) ~= units
      or not same_scope_list(existing.scopeKeys, requested_scopes)
    then
      return {4}
    end

    local intact = true
    for i = 2, #KEYS do
      local score = redis.call('ZSCORE', KEYS[i], existing.leaseId)
      local raw = redis.call('HGET', metadata_key(KEYS[i]), existing.leaseId)
      if not score or tonumber(score) <= now
        or not metadata_matches(raw, units, owner_id, job_id, lease_epoch)
      then
        intact = false
        break
      end
    end

    if intact then
      return {2, existing.leaseId, tostring(existing.expiresAt)}
    end

    for _, old_scope in ipairs(existing.scopeKeys) do
      remove_lease(old_scope, existing.leaseId, now)
    end
    redis.call('DEL', job_key)
  else
    for _, old_scope in ipairs(existing.scopeKeys) do
      remove_lease(old_scope, existing.leaseId, now)
    end
    redis.call('DEL', job_key)
  end
end

for i = 1, scope_count do
  local scope_key = KEYS[i + 1]
  local limit = tonumber(ARGV[7 + i])
  local usage = scope_usage(scope_key)
  if usage + units > limit then
    return {0, tostring(i), tostring(usage), tostring(limit)}
  end
end

local scope_metadata = cjson.encode({
  units = units,
  ownerId = owner_id,
  jobId = job_id,
  leaseEpoch = lease_epoch
})
for i = 2, #KEYS do
  redis.call('ZADD', KEYS[i], expires_at, lease_id)
  redis.call('HSET', metadata_key(KEYS[i]), lease_id, scope_metadata)
  refresh_scope_ttl(KEYS[i])
end

local fence = cjson.encode({
  leaseId = lease_id,
  ownerId = owner_id,
  jobId = job_id,
  leaseEpoch = lease_epoch,
  units = units,
  expiresAt = expires_at,
  scopeKeys = requested_scopes
})
redis.call('SET', job_key, fence, 'PXAT', expires_at)
return {1, lease_id, tostring(expires_at)}
`.trim();

const RENEW_SCRIPT = `
${LEASE_SCRIPT_HELPERS}

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local job_key = KEYS[1]
local lease_id = ARGV[1]
local lease_duration_ms = tonumber(ARGV[2])
local units = tonumber(ARGV[3])
local owner_id = ARGV[4]
local job_id = ARGV[5]
local lease_epoch = tonumber(ARGV[6])
local requested_scopes = cjson.decode(ARGV[7])

for i = 2, #KEYS do
  cleanup_scope(KEYS[i], now)
end

local existing_raw = redis.call('GET', job_key)
if not existing_raw then
  return {0, '-1'}
end
local existing = cjson.decode(existing_raw)
if existing.leaseId ~= lease_id
  or existing.ownerId ~= owner_id
  or existing.jobId ~= job_id
  or tonumber(existing.leaseEpoch) ~= lease_epoch
  or tonumber(existing.units) ~= units
  or tonumber(existing.expiresAt) <= now
  or not same_scope_list(existing.scopeKeys, requested_scopes)
then
  return {0, '-1'}
end

for i = 2, #KEYS do
  local score = redis.call('ZSCORE', KEYS[i], lease_id)
  local raw = redis.call('HGET', metadata_key(KEYS[i]), lease_id)
  if not score or tonumber(score) <= now
    or not metadata_matches(raw, units, owner_id, job_id, lease_epoch)
  then
    return {0, tostring(i - 2)}
  end
end

local new_expires_at = now + lease_duration_ms
for i = 2, #KEYS do
  redis.call('ZADD', KEYS[i], new_expires_at, lease_id)
  refresh_scope_ttl(KEYS[i])
end
existing.expiresAt = new_expires_at
redis.call('SET', job_key, cjson.encode(existing), 'PXAT', new_expires_at)
return {1, tostring(new_expires_at)}
`.trim();

const RELEASE_SCRIPT = `
${LEASE_SCRIPT_HELPERS}

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local job_key = KEYS[1]
local lease_id = ARGV[1]
local units = tonumber(ARGV[2])
local owner_id = ARGV[3]
local job_id = ARGV[4]
local lease_epoch = tonumber(ARGV[5])
local requested_scopes = cjson.decode(ARGV[6])

for i = 2, #KEYS do
  cleanup_scope(KEYS[i], now)
end

local existing_raw = redis.call('GET', job_key)
if not existing_raw then
  return 0
end
local existing = cjson.decode(existing_raw)
if existing.leaseId ~= lease_id
  or existing.ownerId ~= owner_id
  or existing.jobId ~= job_id
  or tonumber(existing.leaseEpoch) ~= lease_epoch
  or tonumber(existing.units) ~= units
  or tonumber(existing.expiresAt) <= now
  or not same_scope_list(existing.scopeKeys, requested_scopes)
then
  return 0
end

for _, scope_key in ipairs(existing.scopeKeys) do
  local raw = redis.call('HGET', metadata_key(scope_key), lease_id)
  if not metadata_matches(raw, units, owner_id, job_id, lease_epoch) then
    return 0
  end
end

for _, scope_key in ipairs(existing.scopeKeys) do
  remove_lease(scope_key, lease_id, now)
end
redis.call('DEL', job_key)
return 1
`.trim();

const INSPECT_SCRIPT = `
${LEASE_SCRIPT_HELPERS}

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local result = {}
for i = 1, #KEYS do
  cleanup_scope(KEYS[i], now)
  result[i] = tostring(scope_usage(KEYS[i]))
end
return result
`.trim();

type RedisScalar = string | number;

export interface LeaseClient extends Redis {
  relayAcquireWeightedLease(
    numKeys: number,
    ...args: RedisScalar[]
  ): Promise<RedisScalar[]>;
  relayRenewWeightedLease(
    numKeys: number,
    ...args: RedisScalar[]
  ): Promise<RedisScalar[]>;
  relayReleaseWeightedLease(
    numKeys: number,
    ...args: RedisScalar[]
  ): Promise<number>;
  relayInspectWeightedLeases(
    numKeys: number,
    ...args: RedisScalar[]
  ): Promise<RedisScalar[]>;
}

/** Register variable-key Lua commands on an ioredis connection. */
export function defineLeaseCommands(connection: Redis): LeaseClient {
  const client = connection as LeaseClient;
  if (typeof client.relayAcquireWeightedLease !== "function") {
    connection.defineCommand("relayAcquireWeightedLease", {
      lua: ACQUIRE_SCRIPT,
    });
  }
  if (typeof client.relayRenewWeightedLease !== "function") {
    connection.defineCommand("relayRenewWeightedLease", { lua: RENEW_SCRIPT });
  }
  if (typeof client.relayReleaseWeightedLease !== "function") {
    connection.defineCommand("relayReleaseWeightedLease", {
      lua: RELEASE_SCRIPT,
    });
  }
  if (typeof client.relayInspectWeightedLeases !== "function") {
    connection.defineCommand("relayInspectWeightedLeases", {
      lua: INSPECT_SCRIPT,
    });
  }
  return client;
}

export interface LeaseFence {
  readonly ownerId: string;
  readonly jobId: string;
  readonly leaseEpoch: number;
}

export interface LeaseRequest extends LeaseFence {
  readonly units: number;
}

export interface LeaseHandle extends LeaseRequest {
  readonly leaseId: string;
  readonly expiresAt: number;
  readonly jobKey: string;
  readonly scopeKeys: readonly string[];
}

export type AcquireLeaseResult =
  | {
    readonly ok: true;
    readonly leaseId: string;
    readonly expiresAt: number;
    readonly reused: boolean;
  }
  | {
    readonly ok: false;
    readonly reason: "capacity";
    readonly blockedScopeIndex: number;
    readonly usedUnits: number;
    readonly limit: number;
  }
  | {
    readonly ok: false;
    readonly reason: "fenced";
    readonly currentEpoch: number;
  }
  | { readonly ok: false; readonly reason: "conflict" };

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) throw new Error(`${name} must not be empty`);
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertFence(request: LeaseRequest): void {
  assertNonEmpty(request.ownerId, "ownerId");
  assertNonEmpty(request.jobId, "jobId");
  assertPositive(request.units, "units");
  if (!Number.isSafeInteger(request.leaseEpoch) || request.leaseEpoch < 0) {
    throw new Error("leaseEpoch must be a non-negative safe integer");
  }
}

function assertScopes(
  scopeKeys: readonly string[],
  scopeLimits?: readonly number[],
): void {
  if (scopeKeys.length === 0) {
    throw new Error("at least one lease scope is required");
  }
  if (new Set(scopeKeys).size !== scopeKeys.length) {
    throw new Error("lease scope keys must be unique");
  }
  if (scopeLimits !== undefined) {
    if (scopeKeys.length !== scopeLimits.length) {
      throw new Error("scopeKeys and scopeLimits must have equal length");
    }
    for (const limit of scopeLimits) {
      if (!Number.isFinite(limit) || limit < 0) {
        throw new Error("scope limits must be finite non-negative numbers");
      }
    }
  }
}

export async function acquireLease(
  client: LeaseClient,
  jobKey: string,
  scopeKeys: readonly string[],
  scopeLimits: readonly number[],
  leaseDurationMs: number,
  request: LeaseRequest,
): Promise<AcquireLeaseResult> {
  assertNonEmpty(jobKey, "jobKey");
  assertScopes(scopeKeys, scopeLimits);
  assertPositiveInteger(leaseDurationMs, "leaseDurationMs");
  assertFence(request);

  const leaseId = crypto.randomUUID();
  const result = await client.relayAcquireWeightedLease(
    scopeKeys.length + 1,
    jobKey,
    ...scopeKeys,
    leaseId,
    leaseDurationMs,
    request.units,
    request.ownerId,
    request.jobId,
    request.leaseEpoch,
    JSON.stringify(scopeKeys),
    ...scopeLimits,
  );

  const code = Number(result[0]);
  if (code === 0) {
    return {
      ok: false,
      reason: "capacity",
      blockedScopeIndex: Number(result[1]) - 1,
      usedUnits: Number(result[2]),
      limit: Number(result[3]),
    };
  }
  if (code === 3) {
    return {
      ok: false,
      reason: "fenced",
      currentEpoch: Number(result[1]),
    };
  }
  if (code === 4) return { ok: false, reason: "conflict" };
  if (code !== 1 && code !== 2) {
    throw new Error(`unexpected weighted lease result code ${code}`);
  }
  return {
    ok: true,
    leaseId: String(result[1]),
    expiresAt: Number(result[2]),
    reused: code === 2,
  };
}

export async function renewLease(
  client: LeaseClient,
  handle: LeaseHandle,
  leaseDurationMs: number,
): Promise<
  { readonly ok: true; readonly expiresAt: number } | {
    readonly ok: false;
    readonly missingScopeIndex?: number;
  }
> {
  assertScopes(handle.scopeKeys);
  assertPositiveInteger(leaseDurationMs, "leaseDurationMs");
  assertFence(handle);

  const result = await client.relayRenewWeightedLease(
    handle.scopeKeys.length + 1,
    handle.jobKey,
    ...handle.scopeKeys,
    handle.leaseId,
    leaseDurationMs,
    handle.units,
    handle.ownerId,
    handle.jobId,
    handle.leaseEpoch,
    JSON.stringify(handle.scopeKeys),
  );

  if (Number(result[0]) === 0) {
    const index = Number(result[1]);
    return index < 0 ? { ok: false } : { ok: false, missingScopeIndex: index };
  }
  return { ok: true, expiresAt: Number(result[1]) };
}

export async function releaseLease(
  client: LeaseClient,
  handle: LeaseHandle,
): Promise<boolean> {
  assertScopes(handle.scopeKeys);
  assertFence(handle);
  const result = await client.relayReleaseWeightedLease(
    handle.scopeKeys.length + 1,
    handle.jobKey,
    ...handle.scopeKeys,
    handle.leaseId,
    handle.units,
    handle.ownerId,
    handle.jobId,
    handle.leaseEpoch,
    JSON.stringify(handle.scopeKeys),
  );
  return result === 1;
}

export async function inspectLeaseUnits(
  client: LeaseClient,
  scopeKeys: readonly string[],
): Promise<Readonly<Record<string, number>>> {
  assertScopes(scopeKeys);
  const result = await client.relayInspectWeightedLeases(
    scopeKeys.length,
    ...scopeKeys,
  );
  const usage: Record<string, number> = {};
  scopeKeys.forEach((key, index) => {
    usage[key] = Number(result[index]);
  });
  return usage;
}
