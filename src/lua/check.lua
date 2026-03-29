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

-- How far we are into the current window
local elapsed  = now % window

-- Fetch both buckets
local prev_count = tonumber(redis.call('GET', KEYS[2])) or 0
local curr_count = tonumber(redis.call('GET', KEYS[1])) or 0

-- Linear interpolation weight
local weight    = (window - elapsed) / window
local effective = prev_count * weight + curr_count

-- Check BEFORE writing
if effective + cost > limit then
  return {0, math.floor(effective), limit, window - elapsed}
end

-- Increment current bucket and refresh TTL
redis.call('INCRBY', KEYS[1], cost)
redis.call('PEXPIRE', KEYS[1], ttl)

return {1, math.floor(effective + cost), limit, window - elapsed}
