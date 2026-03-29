# 05 — Lua Scripts

All scripts are executed via `EVALSHA` after being loaded with `SCRIPT LOAD` at connection time. This guarantees atomicity — no other Redis command can interleave during script execution.

---

## `check.lua` — Primary Rate Limit Check

This is the hot path. Called on every request that misses the local reservoir.

```lua
-- check.lua
-- Sliding window counter: atomic read + weighted check + conditional increment
--
-- KEYS[1] = current bucket key  (rl:v1:{user:abc}:28433334)
-- KEYS[2] = previous bucket key (rl:v1:{user:abc}:28433333)
--
-- ARGV[1] = limit          (integer, e.g. 100)
-- ARGV[2] = window_ms      (integer, e.g. 60000)
-- ARGV[3] = now_ms         (integer, unix epoch ms)
-- ARGV[4] = cost           (integer, default 1)
-- ARGV[5] = ttl_ms         (integer, window_ms * 2)
--
-- Returns: {allowed, effective_count, limit, ttl_remaining_ms}
--   allowed: 1 = allow, 0 = deny

local limit    = tonumber(ARGV[1])
local window   = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4]) or 1
local ttl      = tonumber(ARGV[5])

-- How far we are into the current window (0 = just started, window = about to end)
local elapsed  = now % window

-- Fetch both buckets. Returns nil if key doesn't exist (first request in window).
local prev_count = tonumber(redis.call('GET', KEYS[2])) or 0
local curr_count = tonumber(redis.call('GET', KEYS[1])) or 0

-- Linear interpolation: weight the previous window by how much of it is still
-- within the rolling [now - window, now] interval.
local weight    = (window - elapsed) / window
local effective = prev_count * weight + curr_count

-- Check BEFORE writing. If over limit, deny without side effects.
if effective + cost > limit then
  -- Return: denied, current effective, limit, ms until window resets
  return {0, effective, limit, window - elapsed}
end

-- Increment current bucket and refresh its TTL.
-- INCRBY handles the case where the key doesn't exist yet (starts at 0).
redis.call('INCRBY', KEYS[1], cost)
redis.call('PEXPIRE', KEYS[1], ttl)

-- Return: allowed, new effective count, limit, ms until window resets
return {1, effective + cost, limit, window - elapsed}
```

---

## `check_multi.lua` — Multi-Dimension Batch Check

Checks all dimensions in a single Redis round-trip. More efficient than calling `check.lua` N times when all dimensions use the same window size.

```lua
-- check_multi.lua
-- Checks N dimensions atomically. Fails fast on first denied dimension.
--
-- KEYS: pairs of [curr_key, prev_key] for each dimension
--   KEYS[1], KEYS[2] = ip curr, ip prev
--   KEYS[3], KEYS[4] = route curr, route prev
--   KEYS[5], KEYS[6] = user curr, user prev
--   KEYS[7], KEYS[8] = user-route curr, user-route prev
--
-- ARGV[1] = now_ms
-- ARGV[2] = cost
-- ARGV[3] = ttl_ms
-- ARGV[4..N] = "dimension:limit:window_ms" for each active dimension
--   e.g. "ip:60:60000", "user:100:60000"
--
-- Returns: {allowed, failed_dimension_or_empty, effective, limit, ttl_ms}

local now  = tonumber(ARGV[1])
local cost = tonumber(ARGV[2]) or 1
local ttl  = tonumber(ARGV[3])

local key_index = 1

for i = 4, #ARGV do
  local parts = {}
  for part in ARGV[i]:gmatch("[^:]+") do
    table.insert(parts, part)
  end
  local dim    = parts[1]
  local limit  = tonumber(parts[2])
  local window = tonumber(parts[3])
  
  local curr_key = KEYS[key_index]
  local prev_key = KEYS[key_index + 1]
  key_index = key_index + 2
  
  local elapsed  = now % window
  local weight   = (window - elapsed) / window
  local prev     = tonumber(redis.call('GET', prev_key)) or 0
  local curr     = tonumber(redis.call('GET', curr_key)) or 0
  local effective = prev * weight + curr
  
  if effective + cost > limit then
    -- Deny — do not increment anything
    return {0, dim, effective, limit, window - elapsed}
  end
end

-- All dimensions passed — now increment all
key_index = 1
for i = 4, #ARGV do
  local parts = {}
  for part in ARGV[i]:gmatch("[^:]+") do
    table.insert(parts, part)
  end
  local window = tonumber(parts[3])
  local curr_key = KEYS[key_index]
  key_index = key_index + 2
  
  redis.call('INCRBY', curr_key, cost)
  redis.call('PEXPIRE', curr_key, ttl)
end

return {1, '', 0, 0, 0}
```

---

## `status.lua` — Read-Only Status Check

For dashboards, admin APIs, and status endpoints. Does NOT increment counters.

```lua
-- status.lua
-- Read current rate limit status without consuming any quota.
--
-- KEYS[1] = current bucket key
-- KEYS[2] = previous bucket key
-- ARGV[1] = limit
-- ARGV[2] = window_ms
-- ARGV[3] = now_ms
--
-- Returns: {effective_count, limit, remaining, ttl_ms}

local limit   = tonumber(ARGV[1])
local window  = tonumber(ARGV[2])
local now     = tonumber(ARGV[3])
local elapsed = now % window
local weight  = (window - elapsed) / window

local prev = tonumber(redis.call('GET', KEYS[2])) or 0
local curr = tonumber(redis.call('GET', KEYS[1])) or 0

local effective  = prev * weight + curr
local remaining  = math.max(0, limit - effective)
local ttl        = window - elapsed

return {effective, limit, remaining, ttl}
```

---

## `reset.lua` — Admin Reset

Deletes rate limit keys for a specific identifier across all windows. Use for admin operations (e.g., unblocking a legitimate user who was rate limited).

```lua
-- reset.lua
-- Deletes all rate limit keys matching a prefix (curr and prev buckets).
--
-- KEYS[1..N] = all keys to delete (curr and prev for each dimension)
--
-- Returns: number of keys deleted

local deleted = 0
for i = 1, #KEYS do
  deleted = deleted + redis.call('DEL', KEYS[i])
end
return deleted
```

Usage from application code:

```typescript
async function resetUser(userId: string): Promise<number> {
  const now = Date.now()
  const window = 60_000
  const currBucket = Math.floor(now / window)
  const prevBucket = currBucket - 1
  
  const keys = [
    `rl:v1:{user:${hash(userId)}}:${currBucket}`,
    `rl:v1:{user:${hash(userId)}}:${prevBucket}`,
    // Also reset composite keys
    // ... (enumerate routes if needed)
  ]
  
  return redis.evalsha(SCRIPT_SHAS.reset, keys.length, ...keys)
}
```

---

## `reservoir_fetch.lua` — Local Reservoir Token Pre-Fetch

Called when a process's local reservoir is empty. Claims a batch of tokens from Redis atomically so concurrent pre-fetches don't double-grant.

```lua
-- reservoir_fetch.lua
-- Atomically claims up to `batch_size` tokens from the rate limit budget.
-- Returns the number of tokens actually granted (may be less than batch_size
-- if the limit is nearly exhausted).
--
-- KEYS[1] = current bucket key
-- KEYS[2] = previous bucket key
-- ARGV[1] = limit
-- ARGV[2] = window_ms
-- ARGV[3] = now_ms
-- ARGV[4] = batch_size  (tokens to claim)
-- ARGV[5] = ttl_ms

local limit      = tonumber(ARGV[1])
local window     = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local batch_size = tonumber(ARGV[4])
local ttl        = tonumber(ARGV[5])
local elapsed    = now % window
local weight     = (window - elapsed) / window

local prev = tonumber(redis.call('GET', KEYS[2])) or 0
local curr = tonumber(redis.call('GET', KEYS[1])) or 0
local effective  = prev * weight + curr
local available  = math.max(0, limit - effective)

-- Grant as many as possible, up to batch_size
local granted = math.min(batch_size, math.floor(available))

if granted > 0 then
  redis.call('INCRBY', KEYS[1], granted)
  redis.call('PEXPIRE', KEYS[1], ttl)
end

return granted
```

---

## Error Handling for Lua Scripts

### NOSCRIPT Error

Occurs after Redis failover when the new primary hasn't seen the scripts:

```typescript
async function evalSafe(name: string, keys: string[], args: string[]) {
  try {
    return await redis.evalsha(SCRIPT_SHAS[name], keys.length, ...keys, ...args)
  } catch (err: any) {
    if (err.message?.startsWith('NOSCRIPT')) {
      logger.warn('Lua script not found, reloading after failover')
      await loadLuaScripts(redis)
      metrics.increment('rate_limiter.script_reload')
      return await redis.evalsha(SCRIPT_SHAS[name], keys.length, ...keys, ...args)
    }
    throw err
  }
}
```

### BUSY Error

Occurs if another long-running script is executing (should be rare with these short scripts):

```typescript
// Lua scripts in this system are all O(1) and sub-millisecond
// BUSY errors should never occur in practice, but handle defensively:
if (err.message?.startsWith('BUSY')) {
  logger.error('Redis BUSY — long-running script detected')
  // Fall through to failure policy
  return applyFailurePolicy(ctx, config)
}
```

---

## Script SHA Management

SHAs are deterministic — the same script always produces the same SHA. You can pre-compute and hardcode them for zero-overhead startup:

```typescript
// Pre-computed SHAs (run: redis-cli SCRIPT LOAD "$(cat check.lua)")
const SCRIPT_SHAS = {
  check:          'a1b2c3d4e5f6...',  // 40-char hex SHA
  check_multi:    'b2c3d4e5f6a7...',
  status:         'c3d4e5f6a7b8...',
  reset:          'd4e5f6a7b8c9...',
  reservoir_fetch:'e5f6a7b8c9d0...',
} as const

// Verify on startup (in case scripts were modified):
async function verifyScripts(redis: RedisClient) {
  const results = await redis.scriptExists(...Object.values(SCRIPT_SHAS))
  const missing = Object.keys(SCRIPT_SHAS).filter((_, i) => !results[i])
  if (missing.length > 0) {
    logger.warn(`Reloading missing scripts: ${missing.join(', ')}`)
    await loadLuaScripts(redis)
  }
}
```
