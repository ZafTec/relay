import type { Redis } from "@relay/queue";

/**
 * "Cooldown cannot be shortened by an older response": a stale
 * (out-of-order) provider response setting a shorter cooldown than one
 * already in effect must not shrink it. Extend-only, computed from the
 * key's current TTL rather than trusting a caller-supplied "current
 * expiry" that could itself be stale.
 */
const SET_COOLDOWN_SCRIPT = `
local key = KEYS[1]
local new_expires_at = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local current_ttl = redis.call('PTTL', key)
local current_expires_at = now - 1
if current_ttl and current_ttl > 0 then
  current_expires_at = now + current_ttl
end
if new_expires_at > current_expires_at then
  local ttl_ms = new_expires_at - now
  if ttl_ms > 0 then
    redis.call('SET', key, '1', 'PX', ttl_ms)
    return 1
  end
end
return 0
`.trim();

export interface CooldownClient extends Redis {
  /** `numberOfKeys: 1` is fixed below, so ioredis auto-prepends the key count -- call with (key, ...args), not (1, key, ...args). */
  relaySetCooldown(key: string, ...args: number[]): Promise<number>;
}

export function defineCooldownCommands(connection: Redis): CooldownClient {
  const client = connection as CooldownClient;
  if (typeof client.relaySetCooldown !== "function") {
    connection.defineCommand("relaySetCooldown", {
      numberOfKeys: 1,
      lua: SET_COOLDOWN_SCRIPT,
    });
  }
  return client;
}

/** Returns true if this call actually extended the cooldown. */
export async function setProviderCooldown(
  client: CooldownClient,
  key: string,
  expiresAtMs: number,
  nowMs: number,
): Promise<boolean> {
  const result = await client.relaySetCooldown(key, expiresAtMs, nowMs);
  return result === 1;
}
