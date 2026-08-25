import type { Redis } from "ioredis";
import { schedulerKeys, type SchedulerRedisKeys } from "./keys.ts";
import {
  isSchedulingClassKey,
  SCHEDULING_CLASS_KEYS,
  type SchedulingClassKey,
  type SchedulingClassProfile,
  validateSchedulingClassProfiles,
} from "./profiles.ts";

const SCHEDULER_QUEUE_HELPERS = `
local function workspace_ring_key(base, class_key)
  return base .. ':class:' .. class_key .. ':workspaces'
end

local function workspace_members_key(base, class_key)
  return base .. ':class:' .. class_key .. ':workspace-members'
end

local function ready_key(base, class_key, workspace_id)
  return base .. ':ready:' .. class_key .. ':' .. workspace_id
end

local function ensure_workspace(base, class_key, workspace_id)
  local members = workspace_members_key(base, class_key)
  if redis.call('SADD', members, workspace_id) == 1 then
    redis.call('RPUSH', workspace_ring_key(base, class_key), workspace_id)
  end
end

local function add_ready(base, job)
  redis.call(
    'ZADD',
    ready_key(base, job.classKey, job.workspaceId),
    job.fifoSequence,
    job.jobId
  )
  ensure_workspace(base, job.classKey, job.workspaceId)
end

local function remove_ready(base, job)
  local queue = ready_key(base, job.classKey, job.workspaceId)
  redis.call('ZREM', queue, job.jobId)
  if redis.call('ZCARD', queue) == 0 then
    redis.call('DEL', queue)
    redis.call('LREM', workspace_ring_key(base, job.classKey), 0, job.workspaceId)
    redis.call('SREM', workspace_members_key(base, job.classKey), job.workspaceId)
  end
end

local function refresh_dispatch_keys(dispatch_key, dispatch_metadata_key)
  if redis.call('ZCARD', dispatch_key) == 0 then
    redis.call('DEL', dispatch_key)
    redis.call('DEL', dispatch_metadata_key)
    return
  end

  -- Dispatch records must outlive scheduler process outages. Expired members
  -- are recovered by the claim script rather than by expiring the whole index.
  redis.call('PERSIST', dispatch_key)
  redis.call('PERSIST', dispatch_metadata_key)
end

local function subtract_floor_zero(value, amount)
  local result = value - amount
  if result < 0.000000001 then return 0 end
  return result
end

local function rollback_dispatch_accounting(state_key, dispatch)
  local cost = tonumber(dispatch.costUnits) or 0
  local class_key = dispatch.classKey
  if class_key and cost > 0 then
    local reserved_field = 'reserved:' .. class_key
    local deficit_field = 'deficit:' .. class_key
    local reserved = tonumber(redis.call('HGET', state_key, reserved_field)) or 0
    local deficit = tonumber(redis.call('HGET', state_key, deficit_field)) or 0
    local cap = tonumber(redis.call('HGET', state_key, 'deficit_cap')) or 0
    reserved = subtract_floor_zero(reserved, cost)
    if deficit - reserved > cap then deficit = reserved + cap end
    redis.call('HSET', state_key, reserved_field, tostring(reserved))
    redis.call('HSET', state_key, deficit_field, tostring(deficit))
  end

  local internal_reserved = tonumber(dispatch.internalCreditReserved) or 0
  if internal_reserved > 0 then
    local total = tonumber(redis.call('HGET', state_key, 'internal_reserved')) or 0
    redis.call(
      'HSET',
      state_key,
      'internal_reserved',
      tostring(subtract_floor_zero(total, internal_reserved))
    )
  end
end

local function commit_dispatch_accounting(state_key, base, dispatch)
  local cost = tonumber(dispatch.costUnits) or 0
  local class_key = dispatch.classKey
  if not class_key or cost <= 0 then
    error('dispatch lease is missing fairness accounting')
  end

  local deficit_field = 'deficit:' .. class_key
  local reserved_field = 'reserved:' .. class_key
  local deficit = tonumber(redis.call('HGET', state_key, deficit_field)) or 0
  local reserved = tonumber(redis.call('HGET', state_key, reserved_field)) or 0
  redis.call(
    'HSET',
    state_key,
    deficit_field,
    tostring(subtract_floor_zero(deficit, cost))
  )
  redis.call(
    'HSET',
    state_key,
    reserved_field,
    tostring(subtract_floor_zero(reserved, cost))
  )

  local internal_reserved = tonumber(dispatch.internalCreditReserved) or 0
  if internal_reserved > 0 then
    local credit = tonumber(redis.call('HGET', state_key, 'internal_credit')) or 0
    local total_reserved = tonumber(redis.call('HGET', state_key, 'internal_reserved')) or 0
    redis.call(
      'HSET',
      state_key,
      'internal_credit',
      tostring(subtract_floor_zero(credit, internal_reserved))
    )
    redis.call(
      'HSET',
      state_key,
      'internal_reserved',
      tostring(subtract_floor_zero(total_reserved, internal_reserved))
    )
  end

  local internal_earned = tonumber(dispatch.internalCreditEarned) or 0
  local internal_ring = workspace_ring_key(base, 'internal')
  if internal_earned > 0 and redis.call('LLEN', internal_ring) > 0 then
    local cap = tonumber(redis.call('HGET', state_key, 'deficit_cap')) or 0
    local credit = tonumber(redis.call('HGET', state_key, 'internal_credit')) or 0
    redis.call(
      'HSET',
      state_key,
      'internal_credit',
      tostring(math.min(cap, credit + internal_earned))
    )
  end
end
`.trim();

const CONFIGURE_SCRIPT = `
local profiles = cjson.decode(ARGV[1])
local deficit_cap = tonumber(ARGV[2])
local max_cost = tonumber(ARGV[3])
local configured_max_cost = tonumber(redis.call('HGET', KEYS[2], 'max_cost'))
local configured_deficit_cap = tonumber(redis.call('HGET', KEYS[2], 'deficit_cap'))
local changed = not configured_max_cost or not configured_deficit_cap
local advanced_version = false

local function same_share(left, right)
  if type(left) ~= type(right) then return false end
  if type(left) == 'number' then return tonumber(left) == tonumber(right) end
  return true
end

for _, profile in ipairs(profiles) do
  local existing_raw = redis.call('HGET', KEYS[1], profile.classKey)
  if not existing_raw then
    changed = true
  else
    local existing = cjson.decode(existing_raw)
    local incoming_version = tonumber(profile.policyVersion)
    local existing_version = tonumber(existing.policyVersion)
    if incoming_version < existing_version then
      return {0, profile.classKey, tostring(existing_version)}
    end

    local policy_matches = tonumber(existing.weight) == tonumber(profile.weight)
      and existing.enabled == profile.enabled
      and same_share(existing.maxShare, profile.maxShare)
    if incoming_version == existing_version and not policy_matches then
      return {-1, profile.classKey}
    end
    if incoming_version > existing_version then
      changed = true
      advanced_version = true
    end
  end
end

if configured_max_cost and configured_max_cost ~= max_cost then
  if not advanced_version then return {-1, 'max_cost'} end
  changed = true
end
if configured_deficit_cap and configured_deficit_cap ~= deficit_cap then
  if not advanced_version then return {-1, 'deficit_cap'} end
  changed = true
end

if not changed then return {2} end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local active_dispatches = redis.call(
  'ZRANGEBYSCORE', KEYS[3], '(' .. tostring(now), '+inf', 'LIMIT', 0, 1
)
if #active_dispatches > 0 then return {-2} end

for _, profile in ipairs(profiles) do
  redis.call('HSET', KEYS[1], profile.classKey, cjson.encode(profile))
  redis.call('HSET', KEYS[2], 'deficit:' .. profile.classKey, '0')
  redis.call('HSET', KEYS[2], 'reserved:' .. profile.classKey, '0')
end
redis.call('HSET', KEYS[2], 'deficit_cap', tostring(deficit_cap))
redis.call('HSET', KEYS[2], 'max_cost', tostring(max_cost))
redis.call('HSET', KEYS[2], 'cursor', '1')
redis.call('HSET', KEYS[2], 'turn_funded', '0')
redis.call('HSET', KEYS[2], 'internal_credit', '0')
redis.call('HSET', KEYS[2], 'internal_reserved', '0')
return {1}
`.trim();

const ENQUEUE_SCRIPT = `
${SCHEDULER_QUEUE_HELPERS}

local jobs_key = KEYS[1]
local due_key = KEYS[2]
local dispatch_key = KEYS[3]
local dispatch_metadata_key = KEYS[4]
local profiles_key = KEYS[5]
local state_key = KEYS[6]
local base = KEYS[7]
local incoming_raw = ARGV[1]
local incoming = cjson.decode(incoming_raw)
local existing_raw = redis.call('HGET', jobs_key, incoming.jobId)

if existing_raw then
  local existing = cjson.decode(existing_raw)
  local existing_generation = tonumber(existing.dispatchGeneration)
  local incoming_generation = tonumber(incoming.dispatchGeneration)
  if existing.tombstone == 'cancelled' then
    return {3, tostring(existing_generation)}
  end
  if incoming_generation < existing_generation then
    return {0, tostring(existing_generation)}
  end
  if incoming_generation == existing_generation then
    if existing.tombstone == 'dispatched' then return {2} end
    if existing.classKey ~= incoming.classKey
      or tonumber(existing.policyVersion) ~= tonumber(incoming.policyVersion)
      or existing.workspaceId ~= incoming.workspaceId
      or tonumber(existing.costUnits) ~= tonumber(incoming.costUnits)
      or tonumber(existing.fifoSequence) ~= tonumber(incoming.fifoSequence)
      or tonumber(existing.eligibleAtMs) ~= tonumber(incoming.eligibleAtMs)
    then
      return {-1}
    end

    local dispatch_score = redis.call('ZSCORE', dispatch_key, incoming.jobId)
    local due_score = redis.call('ZSCORE', due_key, incoming.jobId)
    local ready_score = redis.call(
      'ZSCORE',
      ready_key(base, incoming.classKey, incoming.workspaceId),
      incoming.jobId
    )
    if not dispatch_score and not due_score and not ready_score then
      redis.call('ZADD', due_key, incoming.eligibleAtMs, incoming.jobId)
    elseif ready_score then
      ensure_workspace(base, incoming.classKey, incoming.workspaceId)
    end
    return {2}
  end
end

local profile_raw = redis.call('HGET', profiles_key, incoming.classKey)
if not profile_raw then return {-2} end
local incoming_profile = cjson.decode(profile_raw)
if incoming_profile.enabled ~= true then return {-2} end
if tonumber(incoming.policyVersion) > tonumber(incoming_profile.policyVersion) then
  return {-3, tostring(incoming_profile.policyVersion)}
end

if existing_raw then
  local existing = cjson.decode(existing_raw)
  redis.call('ZREM', due_key, existing.jobId)
  local dispatch_raw = redis.call('HGET', dispatch_metadata_key, existing.jobId)
  if dispatch_raw then
    rollback_dispatch_accounting(state_key, cjson.decode(dispatch_raw))
  end
  redis.call('ZREM', dispatch_key, existing.jobId)
  redis.call('HDEL', dispatch_metadata_key, existing.jobId)
  if not existing.tombstone then remove_ready(base, existing) end
end

redis.call('HSET', jobs_key, incoming.jobId, incoming_raw)
redis.call('ZADD', due_key, incoming.eligibleAtMs, incoming.jobId)
refresh_dispatch_keys(dispatch_key, dispatch_metadata_key)
return {1}
`.trim();

const CLAIM_SCRIPT = `
${SCHEDULER_QUEUE_HELPERS}

local jobs_key = KEYS[1]
local due_key = KEYS[2]
local dispatch_key = KEYS[3]
local dispatch_metadata_key = KEYS[4]
local profiles_key = KEYS[5]
local state_key = KEYS[6]
local base = KEYS[7]
local lease_id = ARGV[1]
local owner_id = ARGV[2]
local lease_duration_ms = tonumber(ARGV[3])
local promotion_limit = tonumber(ARGV[4])
local recovery_limit = tonumber(ARGV[5])
local classes = {'standard', 'paid', 'enterprise', 'internal'}

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local function get_profile(class_key)
  local raw = redis.call('HGET', profiles_key, class_key)
  if not raw then return nil end
  return cjson.decode(raw)
end

local function peek_class(class_key)
  local ring = workspace_ring_key(base, class_key)
  local members = workspace_members_key(base, class_key)
  local remaining = tonumber(redis.call('LLEN', ring))
  while remaining > 0 do
    local workspace_id = redis.call('LINDEX', ring, 0)
    if not workspace_id then return nil, nil, nil end
    local queue = ready_key(base, class_key, workspace_id)

    while true do
      local ids = redis.call('ZRANGE', queue, 0, 0)
      if #ids == 0 then break end
      local job_id = ids[1]
      local raw = redis.call('HGET', jobs_key, job_id)
      if not raw then
        redis.call('ZREM', queue, job_id)
      else
        local job = cjson.decode(raw)
        if job.classKey ~= class_key or job.workspaceId ~= workspace_id then
          redis.call('ZREM', queue, job_id)
        elseif redis.call('ZSCORE', dispatch_key, job_id) then
          redis.call('ZREM', queue, job_id)
        else
          return workspace_id, job_id, job
        end
      end
    end

    redis.call('DEL', queue)
    redis.call('LPOP', ring)
    redis.call('SREM', members, workspace_id)
    remaining = remaining - 1
  end
  return nil, nil, nil
end

local function rotate_workspace(class_key, workspace_id, job_id)
  local ring = workspace_ring_key(base, class_key)
  local members = workspace_members_key(base, class_key)
  local queue = ready_key(base, class_key, workspace_id)
  redis.call('ZREM', queue, job_id)
  redis.call('LPOP', ring)
  if redis.call('ZCARD', queue) > 0 then
    redis.call('RPUSH', ring, workspace_id)
  else
    redis.call('DEL', queue)
    redis.call('SREM', members, workspace_id)
  end
end

local function class_has_ready(class_key)
  local profile = get_profile(class_key)
  if not profile or profile.enabled ~= true then return false end
  local _, job_id, _ = peek_class(class_key)
  return job_id ~= nil
end

local function customer_backlogged()
  for i = 1, 3 do
    if class_has_ready(classes[i]) then return true end
  end
  return false
end

local function internal_backlogged()
  return class_has_ready('internal')
end

local expired = redis.call(
  'ZRANGEBYSCORE', dispatch_key, '-inf', now, 'LIMIT', 0, recovery_limit
)
for _, job_id in ipairs(expired) do
  local dispatch_raw = redis.call('HGET', dispatch_metadata_key, job_id)
  if dispatch_raw then
    rollback_dispatch_accounting(state_key, cjson.decode(dispatch_raw))
  end
  redis.call('ZREM', dispatch_key, job_id)
  redis.call('HDEL', dispatch_metadata_key, job_id)
  local raw = redis.call('HGET', jobs_key, job_id)
  if raw then
    local job = cjson.decode(raw)
    if not job.tombstone then add_ready(base, job) end
  end
end
refresh_dispatch_keys(dispatch_key, dispatch_metadata_key)

local due = redis.call(
  'ZRANGEBYSCORE', due_key, '-inf', now, 'LIMIT', 0, promotion_limit
)
for _, job_id in ipairs(due) do
  redis.call('ZREM', due_key, job_id)
  local raw = redis.call('HGET', jobs_key, job_id)
  if raw and not redis.call('ZSCORE', dispatch_key, job_id) then
    local job = cjson.decode(raw)
    if not job.tombstone then add_ready(base, job) end
  end
end

local deficit_cap = tonumber(redis.call('HGET', state_key, 'deficit_cap'))
local max_cost = tonumber(redis.call('HGET', state_key, 'max_cost'))
if not deficit_cap or not max_cost then return {-1} end

local min_weight = nil
for _, class_key in ipairs(classes) do
  local profile = get_profile(class_key)
  if profile and profile.enabled == true then
    local weight = tonumber(profile.weight)
    if not min_weight or weight < min_weight then min_weight = weight end
  end
end
if not min_weight then return {0} end

local cursor = tonumber(redis.call('HGET', state_key, 'cursor')) or 1
if cursor < 1 or cursor > #classes then cursor = 1 end
local funded = redis.call('HGET', state_key, 'turn_funded') == '1'
local max_iterations = math.ceil(max_cost / min_weight + 2) * #classes
local iterations = 0

while iterations < max_iterations do
  iterations = iterations + 1
  local class_key = classes[cursor]
  local profile = get_profile(class_key)
  local workspace_id, job_id, job = nil, nil, nil
  if profile and profile.enabled == true then
    workspace_id, job_id, job = peek_class(class_key)
  end

  if not job_id then
    cursor = cursor % #classes + 1
    funded = false
  else
    local deficit_field = 'deficit:' .. class_key
    local reserved_field = 'reserved:' .. class_key
    local deficit = tonumber(redis.call('HGET', state_key, deficit_field)) or 0
    local reserved = tonumber(redis.call('HGET', state_key, reserved_field)) or 0
    if reserved < 0 then reserved = 0 end
    if deficit < reserved then deficit = reserved end
    if deficit - reserved > deficit_cap then deficit = reserved + deficit_cap end
    if not funded then
      local available = deficit - reserved
      deficit = reserved + math.min(
        deficit_cap,
        available + tonumber(profile.weight)
      )
      redis.call('HSET', state_key, deficit_field, tostring(deficit))
      funded = true
    end

    local cost = tonumber(job.costUnits)
    local customers_waiting = false
    local share_allows = true
    local internal_credit_reserved = 0
    local internal_credit_earned = 0
    if class_key == 'internal' and type(profile.maxShare) == 'number' then
      customers_waiting = customer_backlogged()
      if customers_waiting then
        local credit = tonumber(redis.call('HGET', state_key, 'internal_credit')) or 0
        local credit_reserved = tonumber(redis.call('HGET', state_key, 'internal_reserved')) or 0
        share_allows = credit - credit_reserved + 0.000000001 >= cost
        if share_allows then internal_credit_reserved = cost end
      else
        redis.call('HSET', state_key, 'internal_credit', '0')
      end
    elseif class_key ~= 'internal' then
      local internal_profile = get_profile('internal')
      if internal_profile and internal_profile.enabled == true
        and type(internal_profile.maxShare) == 'number'
        and internal_backlogged()
      then
        local share = tonumber(internal_profile.maxShare)
        internal_credit_earned = cost * share / (1 - share)
      end
    end

    if deficit - reserved + 0.000000001 >= cost and share_allows then
      reserved = reserved + cost
      redis.call('HSET', state_key, reserved_field, tostring(reserved))
      if internal_credit_reserved > 0 then
        local total_reserved = tonumber(redis.call('HGET', state_key, 'internal_reserved')) or 0
        redis.call(
          'HSET',
          state_key,
          'internal_reserved',
          tostring(total_reserved + internal_credit_reserved)
        )
      end
      rotate_workspace(class_key, workspace_id, job_id)

      local _, next_job_id, next_job = peek_class(class_key)
      local continue_turn = next_job_id ~= nil
        and deficit - reserved + 0.000000001 >= tonumber(next_job.costUnits)
      if continue_turn and class_key == 'internal'
        and type(profile.maxShare) == 'number'
        and customer_backlogged()
      then
        local credit = tonumber(redis.call('HGET', state_key, 'internal_credit')) or 0
        local credit_reserved = tonumber(redis.call('HGET', state_key, 'internal_reserved')) or 0
        continue_turn = credit - credit_reserved + 0.000000001
          >= tonumber(next_job.costUnits)
      end

      if continue_turn then
        funded = true
      else
        cursor = cursor % #classes + 1
        funded = false
      end
      redis.call('HSET', state_key, 'cursor', tostring(cursor))
      redis.call('HSET', state_key, 'turn_funded', funded and '1' or '0')

      local expires_at = now + lease_duration_ms
      local dispatch = {
        leaseId = lease_id,
        ownerId = owner_id,
        dispatchGeneration = job.dispatchGeneration,
        expiresAtMs = expires_at,
        classKey = class_key,
        costUnits = cost,
        internalCreditReserved = internal_credit_reserved,
        internalCreditEarned = internal_credit_earned
      }
      redis.call('ZADD', dispatch_key, expires_at, job_id)
      redis.call('HSET', dispatch_metadata_key, job_id, cjson.encode(dispatch))
      refresh_dispatch_keys(dispatch_key, dispatch_metadata_key)
      return {
        1,
        job.jobId,
        tostring(job.dispatchGeneration),
        job.classKey,
        job.workspaceId,
        tostring(job.costUnits),
        tostring(job.fifoSequence),
        tostring(job.eligibleAtMs),
        tostring(job.policyVersion),
        lease_id,
        owner_id,
        tostring(expires_at)
      }
    end

    redis.call('HSET', state_key, deficit_field, tostring(deficit))
    cursor = cursor % #classes + 1
    funded = false
  end
end

redis.call('HSET', state_key, 'cursor', tostring(cursor))
redis.call('HSET', state_key, 'turn_funded', funded and '1' or '0')
return {0}
`.trim();

const ACKNOWLEDGE_SCRIPT = `
${SCHEDULER_QUEUE_HELPERS}

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local raw = redis.call('HGET', KEYS[3], ARGV[1])
if not raw then return 0 end
local lease = cjson.decode(raw)
if tonumber(lease.dispatchGeneration) ~= tonumber(ARGV[2])
  or lease.leaseId ~= ARGV[3]
  or lease.ownerId ~= ARGV[4]
  or tonumber(lease.expiresAtMs) <= now
then
  return 0
end
local job_raw = redis.call('HGET', KEYS[1], ARGV[1])
if not job_raw then return 0 end
local job = cjson.decode(job_raw)
if tonumber(job.dispatchGeneration) ~= tonumber(ARGV[2]) or job.tombstone then
  return 0
end

commit_dispatch_accounting(KEYS[4], KEYS[5], lease)
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
redis.call(
  'HSET',
  KEYS[1],
  ARGV[1],
  cjson.encode({
    jobId = ARGV[1],
    dispatchGeneration = tonumber(ARGV[2]),
    tombstone = 'dispatched'
  })
)
refresh_dispatch_keys(KEYS[2], KEYS[3])
return 1
`.trim();

const RENEW_SCRIPT = `
${SCHEDULER_QUEUE_HELPERS}

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then return {0} end
local lease = cjson.decode(raw)
if tonumber(lease.dispatchGeneration) ~= tonumber(ARGV[2])
  or lease.leaseId ~= ARGV[3]
  or lease.ownerId ~= ARGV[4]
  or tonumber(lease.expiresAtMs) <= now
then
  return {0}
end
local expires_at = now + tonumber(ARGV[5])
lease.expiresAtMs = expires_at
redis.call('ZADD', KEYS[1], expires_at, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(lease))
refresh_dispatch_keys(KEYS[1], KEYS[2])
return {1, tostring(expires_at)}
`.trim();

const RELEASE_SCRIPT = `
${SCHEDULER_QUEUE_HELPERS}

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local raw = redis.call('HGET', KEYS[4], ARGV[1])
if not raw then return 0 end
local lease = cjson.decode(raw)
if tonumber(lease.dispatchGeneration) ~= tonumber(ARGV[2])
  or lease.leaseId ~= ARGV[3]
  or lease.ownerId ~= ARGV[4]
  or tonumber(lease.expiresAtMs) <= now
then
  return 0
end
local job_raw = redis.call('HGET', KEYS[1], ARGV[1])
if not job_raw then return 0 end
local job = cjson.decode(job_raw)
if job.tombstone then return 0 end
local eligible_at = tonumber(ARGV[5])
if eligible_at < 0 then eligible_at = now end
job.eligibleAtMs = eligible_at
rollback_dispatch_accounting(KEYS[5], lease)
redis.call('HSET', KEYS[1], job.jobId, cjson.encode(job))
redis.call('ZREM', KEYS[3], job.jobId)
redis.call('HDEL', KEYS[4], job.jobId)
redis.call('ZADD', KEYS[2], eligible_at, job.jobId)
refresh_dispatch_keys(KEYS[3], KEYS[4])
return 1
`.trim();

const REMOVE_SCRIPT = `
${SCHEDULER_QUEUE_HELPERS}

local job_id = ARGV[1]
local removed_generation = tonumber(ARGV[2])
local raw = redis.call('HGET', KEYS[1], job_id)
if raw then
  local job = cjson.decode(raw)
  if tonumber(job.dispatchGeneration) > removed_generation then return 0 end
  if not job.tombstone then remove_ready(KEYS[6], job) end
end

redis.call('ZREM', KEYS[2], job_id)
local dispatch_raw = redis.call('HGET', KEYS[4], job_id)
if dispatch_raw then
  rollback_dispatch_accounting(KEYS[5], cjson.decode(dispatch_raw))
end
redis.call('ZREM', KEYS[3], job_id)
redis.call('HDEL', KEYS[4], job_id)

redis.call(
  'HSET',
  KEYS[1],
  job_id,
  cjson.encode({
    jobId = job_id,
    dispatchGeneration = removed_generation,
    tombstone = 'cancelled'
  })
)
refresh_dispatch_keys(KEYS[3], KEYS[4])
return 1
`.trim();

type RedisScalar = string | number;

interface SchedulerClient extends Redis {
  relaySchedulerConfigure(
    numKeys: number,
    ...args: RedisScalar[]
  ): Promise<RedisScalar[]>;
  relaySchedulerEnqueue(
    numKeys: number,
    ...args: RedisScalar[]
  ): Promise<RedisScalar[]>;
  relaySchedulerClaim(
    numKeys: number,
    ...args: RedisScalar[]
  ): Promise<RedisScalar[]>;
  relaySchedulerAcknowledge(
    numKeys: number,
    ...args: RedisScalar[]
  ): Promise<number>;
  relaySchedulerRenew(
    numKeys: number,
    ...args: RedisScalar[]
  ): Promise<RedisScalar[]>;
  relaySchedulerRelease(
    numKeys: number,
    ...args: RedisScalar[]
  ): Promise<number>;
  relaySchedulerRemove(
    numKeys: number,
    ...args: RedisScalar[]
  ): Promise<number>;
}

function defineSchedulerCommands(connection: Redis): SchedulerClient {
  const client = connection as SchedulerClient;
  const definitions: ReadonlyArray<readonly [string, string]> = [
    ["relaySchedulerConfigure", CONFIGURE_SCRIPT],
    ["relaySchedulerEnqueue", ENQUEUE_SCRIPT],
    ["relaySchedulerClaim", CLAIM_SCRIPT],
    ["relaySchedulerAcknowledge", ACKNOWLEDGE_SCRIPT],
    ["relaySchedulerRenew", RENEW_SCRIPT],
    ["relaySchedulerRelease", RELEASE_SCRIPT],
    ["relaySchedulerRemove", REMOVE_SCRIPT],
  ];
  for (const [name, lua] of definitions) {
    if (
      typeof (client as unknown as Record<string, unknown>)[name] !== "function"
    ) {
      connection.defineCommand(name, { lua });
    }
  }
  return client;
}

export interface SchedulerConfig {
  readonly env: string;
  readonly dispatchLeaseDurationMs: number;
  /** Highest job cost accepted by this scheduler. */
  readonly maxCostUnits: number;
  /** Defaults to maxCostUnits and may never be lower than it. */
  readonly idleDeficitCapUnits?: number;
  readonly promotionBatchSize?: number;
  readonly recoveryBatchSize?: number;
}

export interface SchedulerJob {
  readonly jobId: string;
  readonly dispatchGeneration: number;
  /** Admission snapshot; older versions remain runnable under current class weights. */
  readonly policyVersion: number;
  readonly classKey: SchedulingClassKey;
  readonly workspaceId: string;
  readonly costUnits: number;
  /** Durable, monotonically increasing order within a workspace. */
  readonly fifoSequence: number;
  readonly eligibleAtMs: number;
}

export type EnqueueResult =
  | { readonly kind: "enqueued" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "stale"; readonly currentGeneration: number }
  | { readonly kind: "conflict" }
  | { readonly kind: "class_disabled" }
  | { readonly kind: "policy_mismatch"; readonly currentVersion: number }
  | { readonly kind: "terminal"; readonly currentGeneration: number };

export interface DispatchLease extends SchedulerJob {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly expiresAtMs: number;
}

export interface SchedulerState {
  readonly cursor: SchedulingClassKey;
  readonly turnFunded: boolean;
  readonly internalCredit: number;
  readonly internalReservedCredit: number;
  readonly deficits: Readonly<Record<SchedulingClassKey, number>>;
  readonly reservedDeficits: Readonly<Record<SchedulingClassKey, number>>;
}

function assertPositive(value: number, name: string): void {
  if (
    !Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      `${name} must be positive and within Redis numeric precision`,
    );
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) throw new Error(`${name} must not be empty`);
}

/**
 * Redis-backed, work-conserving weighted deficit round robin.
 *
 * Class deficits, reservations, and class/workspace cursors are persistent
 * Redis state. Every replica executes the same claim script, which promotes due
 * jobs, recovers expired dispatch leases, selects by class/workspace/FIFO order,
 * and installs the next fenced dispatch lease as one atomic operation. Fairness
 * cost is reserved at claim and committed only after publication acknowledgement.
 */
export class WeightedFairScheduler {
  private readonly client: SchedulerClient;
  private readonly keys: SchedulerRedisKeys;
  private readonly deficitCap: number;
  private readonly promotionBatchSize: number;
  private readonly recoveryBatchSize: number;

  constructor(connection: Redis, private readonly config: SchedulerConfig) {
    assertNonEmpty(config.env, "env");
    assertPositiveInteger(
      config.dispatchLeaseDurationMs,
      "dispatchLeaseDurationMs",
    );
    assertPositive(config.maxCostUnits, "maxCostUnits");
    this.deficitCap = config.idleDeficitCapUnits ?? config.maxCostUnits;
    assertPositive(this.deficitCap, "idleDeficitCapUnits");
    if (this.deficitCap < config.maxCostUnits) {
      throw new Error("idleDeficitCapUnits cannot be lower than maxCostUnits");
    }
    this.promotionBatchSize = config.promotionBatchSize ?? 1_000;
    this.recoveryBatchSize = config.recoveryBatchSize ?? 1_000;
    assertPositiveInteger(this.promotionBatchSize, "promotionBatchSize");
    assertPositiveInteger(this.recoveryBatchSize, "recoveryBatchSize");
    this.client = defineSchedulerCommands(connection);
    this.keys = schedulerKeys(config.env);
  }

  /**
   * Installs the current class policy. Versions are monotonic; queued jobs with
   * older admission snapshots remain valid and run under these current weights.
   * Reapplying an identical configuration does not mutate fairness state.
   */
  async configureProfiles(
    profiles: readonly SchedulingClassProfile[],
  ): Promise<void> {
    validateSchedulingClassProfiles(profiles);
    const enabled = profiles.filter((profile) => profile.enabled);
    if (enabled.length === 0) {
      throw new Error("at least one scheduling class must be enabled");
    }
    const minWeight = Math.min(...enabled.map((profile) => profile.weight));
    const maximumScriptVisits = Math.ceil(
      this.config.maxCostUnits / minWeight + 2,
    ) * SCHEDULING_CLASS_KEYS.length;
    if (maximumScriptVisits > 100_000) {
      throw new Error(
        "profile weights are too small for maxCostUnits; atomic selection would exceed 100000 class visits",
      );
    }

    const result = await this.client.relaySchedulerConfigure(
      3,
      this.keys.profiles,
      this.keys.state,
      this.keys.dispatch,
      JSON.stringify(profiles),
      this.deficitCap,
      this.config.maxCostUnits,
    );
    if (Number(result[0]) === 0) {
      throw new Error(
        `stale scheduler profile ${result[1]}; current policy version is ${
          result[2]
        }`,
      );
    }
    if (Number(result[0]) === -1) {
      throw new Error(
        `scheduler profile ${result[1]} changed without a policy version bump`,
      );
    }
    if (Number(result[0]) === -2) {
      throw new Error(
        "scheduler profiles cannot change while dispatch leases are active",
      );
    }
    if (Number(result[0]) === 2) return;
    if (Number(result[0]) !== 1) {
      throw new Error(`unexpected scheduler configuration result ${result[0]}`);
    }
  }

  async enqueue(job: SchedulerJob): Promise<EnqueueResult> {
    this.validateJob(job);
    const result = await this.client.relaySchedulerEnqueue(
      7,
      this.keys.jobs,
      this.keys.due,
      this.keys.dispatch,
      this.keys.dispatchMetadata,
      this.keys.profiles,
      this.keys.state,
      this.keys.base,
      JSON.stringify(job),
    );
    switch (Number(result[0])) {
      case 1:
        return { kind: "enqueued" };
      case 2:
        return { kind: "duplicate" };
      case 0:
        return { kind: "stale", currentGeneration: Number(result[1]) };
      case -1:
        return { kind: "conflict" };
      case -2:
        return { kind: "class_disabled" };
      case -3:
        return { kind: "policy_mismatch", currentVersion: Number(result[1]) };
      case 3:
        return { kind: "terminal", currentGeneration: Number(result[1]) };
      default:
        throw new Error(`unexpected scheduler enqueue result ${result[0]}`);
    }
  }

  async claimNext(
    ownerId: string,
  ): Promise<
    { readonly kind: "empty" } | {
      readonly kind: "leased";
      readonly lease: DispatchLease;
    }
  > {
    assertNonEmpty(ownerId, "ownerId");
    const leaseId = crypto.randomUUID();
    const result = await this.client.relaySchedulerClaim(
      7,
      this.keys.jobs,
      this.keys.due,
      this.keys.dispatch,
      this.keys.dispatchMetadata,
      this.keys.profiles,
      this.keys.state,
      this.keys.base,
      leaseId,
      ownerId,
      this.config.dispatchLeaseDurationMs,
      this.promotionBatchSize,
      this.recoveryBatchSize,
    );
    const code = Number(result[0]);
    if (code === 0) return { kind: "empty" };
    if (code === -1) {
      throw new Error("scheduler profiles have not been configured");
    }
    if (code !== 1) {
      throw new Error(`unexpected scheduler claim result ${result[0]}`);
    }
    const classKey = String(result[3]);
    if (!isSchedulingClassKey(classKey)) {
      throw new Error(`scheduler returned unknown class ${classKey}`);
    }
    return {
      kind: "leased",
      lease: {
        jobId: String(result[1]),
        dispatchGeneration: Number(result[2]),
        classKey,
        workspaceId: String(result[4]),
        costUnits: Number(result[5]),
        fifoSequence: Number(result[6]),
        eligibleAtMs: Number(result[7]),
        policyVersion: Number(result[8]),
        leaseId: String(result[9]),
        ownerId: String(result[10]),
        expiresAtMs: Number(result[11]),
      },
    };
  }

  /** Acknowledge successful BullMQ publication and commit fairness accounting. */
  async acknowledgeDispatch(lease: DispatchLease): Promise<boolean> {
    this.validateDispatchLease(lease);
    return (await this.client.relaySchedulerAcknowledge(
      5,
      this.keys.jobs,
      this.keys.dispatch,
      this.keys.dispatchMetadata,
      this.keys.state,
      this.keys.base,
      lease.jobId,
      lease.dispatchGeneration,
      lease.leaseId,
      lease.ownerId,
    )) === 1;
  }

  async renewDispatchLease(
    lease: DispatchLease,
  ): Promise<
    { readonly ok: false } | {
      readonly ok: true;
      readonly lease: DispatchLease;
    }
  > {
    this.validateDispatchLease(lease);
    const result = await this.client.relaySchedulerRenew(
      2,
      this.keys.dispatch,
      this.keys.dispatchMetadata,
      lease.jobId,
      lease.dispatchGeneration,
      lease.leaseId,
      lease.ownerId,
      this.config.dispatchLeaseDurationMs,
    );
    if (Number(result[0]) !== 1) return { ok: false };
    return {
      ok: true,
      lease: { ...lease, expiresAtMs: Number(result[1]) },
    };
  }

  /** Release a live publication lease back to due/ready scheduling. */
  async releaseDispatchLease(
    lease: DispatchLease,
    eligibleAtMs?: number,
  ): Promise<boolean> {
    this.validateDispatchLease(lease);
    if (eligibleAtMs !== undefined) {
      assertNonNegativeInteger(eligibleAtMs, "eligibleAtMs");
    }
    return (await this.client.relaySchedulerRelease(
      5,
      this.keys.jobs,
      this.keys.due,
      this.keys.dispatch,
      this.keys.dispatchMetadata,
      this.keys.state,
      lease.jobId,
      lease.dispatchGeneration,
      lease.leaseId,
      lease.ownerId,
      eligibleAtMs ?? -1,
    )) === 1;
  }

  /** Remove a queued or dispatching generation after durable cancellation. */
  async removeJob(jobId: string, dispatchGeneration: number): Promise<boolean> {
    assertNonEmpty(jobId, "jobId");
    assertNonNegativeInteger(dispatchGeneration, "dispatchGeneration");
    return (await this.client.relaySchedulerRemove(
      6,
      this.keys.jobs,
      this.keys.due,
      this.keys.dispatch,
      this.keys.dispatchMetadata,
      this.keys.state,
      this.keys.base,
      jobId,
      dispatchGeneration,
    )) === 1;
  }

  async inspectState(): Promise<SchedulerState> {
    const raw = await this.client.hgetall(this.keys.state);
    const cursorIndex = Number(raw.cursor ?? 1) - 1;
    const cursor = SCHEDULING_CLASS_KEYS[cursorIndex] ?? "standard";
    return {
      cursor,
      turnFunded: raw.turn_funded === "1",
      internalCredit: Number(raw.internal_credit ?? 0),
      internalReservedCredit: Number(raw.internal_reserved ?? 0),
      deficits: {
        standard: Number(raw["deficit:standard"] ?? 0),
        paid: Number(raw["deficit:paid"] ?? 0),
        enterprise: Number(raw["deficit:enterprise"] ?? 0),
        internal: Number(raw["deficit:internal"] ?? 0),
      },
      reservedDeficits: {
        standard: Number(raw["reserved:standard"] ?? 0),
        paid: Number(raw["reserved:paid"] ?? 0),
        enterprise: Number(raw["reserved:enterprise"] ?? 0),
        internal: Number(raw["reserved:internal"] ?? 0),
      },
    };
  }

  private validateDispatchLease(lease: DispatchLease): void {
    this.validateJob(lease);
    assertNonEmpty(lease.leaseId, "leaseId");
    assertNonEmpty(lease.ownerId, "ownerId");
    assertPositiveInteger(lease.expiresAtMs, "expiresAtMs");
  }

  private validateJob(job: SchedulerJob): void {
    assertNonEmpty(job.jobId, "jobId");
    assertNonEmpty(job.workspaceId, "workspaceId");
    if (!isSchedulingClassKey(job.classKey)) {
      throw new Error(`unsupported scheduling class ${job.classKey}`);
    }
    assertNonNegativeInteger(job.dispatchGeneration, "dispatchGeneration");
    assertPositiveInteger(job.policyVersion, "policyVersion");
    assertPositive(job.costUnits, "costUnits");
    if (job.costUnits > this.config.maxCostUnits) {
      throw new Error(
        `costUnits ${job.costUnits} exceeds maxCostUnits ${this.config.maxCostUnits}`,
      );
    }
    assertNonNegativeInteger(job.fifoSequence, "fifoSequence");
    assertNonNegativeInteger(job.eligibleAtMs, "eligibleAtMs");
  }
}
