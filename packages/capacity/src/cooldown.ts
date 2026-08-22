import type { Redis } from "ioredis";

/**
 * "Cooldown cannot be shortened by an older response": a stale
 * (out-of-order) provider response setting a shorter cooldown than one
 * already in effect must not shrink it. Callers supply a relative duration,
 * and Redis `TIME` derives the absolute expiry, so application clock skew can
 * neither shorten nor accidentally extend a provider cooldown.
 */
const SET_COOLDOWN_SCRIPT = `
local key = KEYS[1]
local duration_ms = tonumber(ARGV[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local new_expires_at = now + duration_ms
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
  durationMs: number,
): Promise<boolean> {
  if (key.length === 0) throw new Error("cooldown key must not be empty");
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error("cooldown durationMs must be a positive safe integer");
  }
  const result = await client.relaySetCooldown(key, durationMs);
  return result === 1;
}
