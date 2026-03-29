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
