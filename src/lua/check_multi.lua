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
local num_dims  = #ARGV - 3

-- Pre-parse all dimension specs and check limits (fail-fast)
local dims = {}
local most_constrained_eff   = -1
local most_constrained_limit = 0
local most_constrained_ttl   = 0

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

  local elapsed   = now % window
  local weight    = (window - elapsed) / window
  local prev      = tonumber(redis.call('GET', prev_key)) or 0
  local curr      = tonumber(redis.call('GET', curr_key)) or 0
  local effective = prev * weight + curr

  if effective + cost > limit then
    return {0, dim, math.floor(effective), limit, window - elapsed}
  end

  -- Track the most constrained dimension (highest effective/limit ratio)
  local ratio = effective / limit
  if ratio > most_constrained_eff / (most_constrained_limit == 0 and 1 or most_constrained_limit) then
    most_constrained_eff   = effective
    most_constrained_limit = limit
    most_constrained_ttl   = window - elapsed
  end

  dims[#dims + 1] = { curr_key = curr_key, window = window }
end

-- All dimensions passed — now increment all current-bucket keys
-- Use per-dimension TTL (2 * window) to avoid oversizing short-window keys
for _, d in ipairs(dims) do
  redis.call('INCRBY', d.curr_key, cost)
  redis.call('PEXPIRE', d.curr_key, d.window * 2)
end

return {1, '', math.floor(most_constrained_eff), most_constrained_limit, most_constrained_ttl}
