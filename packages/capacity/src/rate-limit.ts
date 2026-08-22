import type { Redis } from "@relay/queue";

/**
 * GCRA rate limiting, per "Capacity coordinator": "Use GCRA for smooth
 * request-rate limits ... Do not use fixed windows for provider limits."
 * Each key holds a single value, the theoretical arrival time (TAT); a
 * request is allowed once `now >= new_tat - burst`. Cooldown keys are
 * plain existence checks (see `setProviderCooldown` in cooldown.ts) and
 * are checked first in the same script so a cooldown denial never
 * touches GCRA state and a GCRA denial never touches cooldown state --
 * "all relevant checks are all-or-none; a denied later constraint must
 * not consume an earlier token."
 *
 * ARGV layout: [numGcraKeys, (emissionIntervalMs, burstMs, cost) *
 * numGcraKeys]. KEYS layout: [...gcraKeys, ...cooldownKeys]. `now` comes
 * from Redis's own `TIME` command, not a caller-supplied timestamp -- see
 * the comment on `ACQUIRE_SCRIPT` in leases.ts for why.
 */
const PERMIT_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local num_gcra = tonumber(ARGV[1])
local total = #KEYS
local num_cooldown = total - num_gcra

for i = num_gcra + 1, total do
  local exists = redis.call('EXISTS', KEYS[i])
  if exists == 1 then
    local ttl = redis.call('PTTL', KEYS[i])
    return {0, i, ttl}
  end
end

local new_tats = {}
for i = 1, num_gcra do
  local base = 1 + (i - 1) * 3
  local emission_interval = tonumber(ARGV[base + 1])
  local burst = tonumber(ARGV[base + 2])
  local cost = tonumber(ARGV[base + 3])
  local raw = redis.call('GET', KEYS[i])
  local tat = now
  if raw then
    tat = tonumber(raw)
  end
  if tat < now then
    tat = now
  end
  -- Allow/deny is decided against the *pre-update* TAT (the debt already
  -- on the books), not the TAT this request would create -- otherwise
  -- every key would deny its own first request.
  local allow_at = tat - burst
  if now < allow_at then
    return {0, i, allow_at - now}
  end
  new_tats[i] = tat + emission_interval * cost
end

for i = 1, num_gcra do
  local base = 1 + (i - 1) * 3
  local burst = tonumber(ARGV[base + 2])
  local ttl_ms = math.ceil(new_tats[i] - now + burst) + 1000
  redis.call('SET', KEYS[i], new_tats[i], 'PX', ttl_ms)
end

return {1}
`.trim();

export interface RateLimitClient extends Redis {
  relayAcquirePermit(
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<[0, number, number] | [1]>;
}

/** `numberOfKeys` omitted -- see the comment in leases.ts's `defineLeaseCommands`; the caller passes the key count as the first argument. */
export function defineRateLimitCommands(connection: Redis): RateLimitClient {
  const client = connection as RateLimitClient;
  if (typeof client.relayAcquirePermit !== "function") {
    connection.defineCommand("relayAcquirePermit", { lua: PERMIT_SCRIPT });
  }
  return client;
}

export interface RateLimitCheck {
  readonly key: string;
  /** Minimum spacing between requests at the steady-state rate. */
  readonly emissionIntervalMs: number;
  /** How far a burst may run ahead of the steady-state rate. */
  readonly burstMs: number;
  /** Cost of this request in the same units as emissionIntervalMs; 1 for an unweighted check. */
  readonly cost: number;
}

export interface AcquirePermitResult {
  readonly ok: boolean;
  readonly blockedIndex?: number;
  readonly retryAfterMs?: number;
  readonly blockedReason?: "rate" | "cooldown";
}

export async function acquireSubmissionPermit(
  client: RateLimitClient,
  checks: readonly RateLimitCheck[],
  cooldownKeys: readonly string[],
): Promise<AcquirePermitResult> {
  const gcraArgs = checks.flatMap((check) => [
    check.emissionIntervalMs,
    check.burstMs,
    check.cost,
  ]);
  const keys = [...checks.map((check) => check.key), ...cooldownKeys];

  const result = await client.relayAcquirePermit(
    keys.length,
    ...keys,
    checks.length,
    ...gcraArgs,
  );

  if (result[0] === 0) {
    const index = result[1] - 1;
    const blockedReason = index >= checks.length ? "cooldown" : "rate";
    return {
      ok: false,
      blockedIndex: index,
      retryAfterMs: result[2],
      blockedReason,
    };
  }
  return { ok: true };
}
