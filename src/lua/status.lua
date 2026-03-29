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
local remaining  = math.max(0, math.floor(limit - effective))
local ttl        = window - elapsed

return {math.floor(effective), limit, remaining, ttl}
