-- reservoir_fetch.lua
-- Atomically claims up to `batch_size` tokens from the rate limit budget.
-- Returns the number of tokens actually granted (may be less than batch_size).
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
