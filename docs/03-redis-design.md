# 03 — Redis Design

## Key Schema

All keys follow this pattern:

```
rl:{version}:{dimension}:{identifier}:{bucket}
```

| Segment | Values | Notes |
|---|---|---|
| `rl` | constant | Namespace prefix — allows co-existing with app keys |
| `{version}` | `v1` | Increment when schema changes — allows zero-downtime migration |
| `{dimension}` | `ip`, `route`, `user`, `user-route` | What is being limited |
| `{identifier}` | hashed value | See per-dimension rules below |
| `{bucket}` | integer | `floor(now_ms / window_ms)` |

### Per-Dimension Key Examples

```bash
# Per-IP (60s window, bucket = floor(1706000070000 / 60000) = 28433334)
rl:v1:ip:c0a80101:28433334          # IPv4 hex-encoded
rl:v1:ip:2001db8085a3000000008a2e0:28433334  # IPv6 truncated hash

# Per-route (method + path, normalized)
rl:v1:route:GET_api_users:28433334
rl:v1:route:POST_api_orders:28433334
rl:v1:route:GET_api_users_PARAM:28433334    # :id replaced with PARAM

# Per-user / API key (SHA-256 prefix of key — never store raw key)
rl:v1:user:a3f2c891b4:28433334

# Composite user + route
rl:v1:user-route:a3f2c891b4:POST_api_orders:28433334
```

### Route Normalization

Strip dynamic path segments to collapse per-resource limits into per-endpoint limits:

```typescript
function normalizeRoute(method: string, path: string): string {
  const normalized = path
    .replace(/\/[0-9a-f-]{8,}/gi, '/PARAM')  // UUIDs
    .replace(/\/\d+/g, '/PARAM')              // numeric IDs
    .replace(/[^a-zA-Z0-9_]/g, '_')           // safe for Redis key
    .toLowerCase()
  return `${method}_${normalized}`
}

// Examples:
// GET  /api/users/123          → get_api_users_PARAM
// GET  /api/users/abc-def-123  → get_api_users_PARAM
// POST /api/orders             → post_api_orders
```

---

## TTL Strategy

Each key gets a TTL of `window * 2`. This is deliberate:

```
Window 1 (T=0..60s)    Window 2 (T=60..120s)    Window 3 (T=120..180s)
├── curr_key_W1 ──────────────────────────────────────────────────► expires at T=120s
│   (written T=0)      (read as prev_key in W2)  (expired, not needed in W3)
│
└── curr_key_W2 ──────────────────────────────────────────────────────────────────► expires at T=180s
                       (written T=60)             (read as prev_key in W3)
```

If you set TTL to exactly `window`, the previous window's key expires at the moment it becomes needed as the "prev" bucket. TTL of `2 × window` guarantees it survives long enough to be read in the next window, then naturally expires before the window after that.

```typescript
const TTL_MS = window_ms * 2
redis.pexpire(curr_key, TTL_MS)  // Use PEXPIRE for millisecond precision
```

---

## Memory Sizing

### Per-Key Memory Cost

A Redis string key holding an integer counter:
- Key name: ~50–80 bytes (depending on identifier length)
- Value: 8 bytes (integer)
- Redis overhead per key: ~64 bytes
- **Total per key: ~130–150 bytes**

### Sizing Formula

```
total_keys = active_users × dimensions × 2 (curr + prev)

Example:
  active_users = 100,000
  dimensions   = 4 (ip, route, user, user-route)
  keys         = 100,000 × 4 × 2 = 800,000 keys

Memory = 800,000 × 150 bytes = 120 MB

With 3× headroom for burst: ~360 MB Redis RAM required
```

### Per Route Memory

```
active_routes = 50 distinct normalized routes
per_route_keys = 50 × 2 = 100 keys = negligible
```

### IP Keys

IPs are more numerous but most are low-traffic. Use a separate Redis database or key prefix with a lower TTL if IP tracking memory becomes significant:

```typescript
// IP keys can use shorter TTL since IP-level limits reset faster
const IP_TTL_MS = ip_window_ms * 2  // e.g., 10s window → 20s TTL
```

---

## Redis Cluster Topology

### Why Clustering is Needed

A single Redis node handles ~100K ops/sec. At 1M req/s with 3 dimension checks per request = 3M ops/sec. Even with the local reservoir cutting this by ~100x to 30K ops/sec, cluster headroom is important.

### Recommended Topology (ElastiCache)

```
┌─────────────────────────────────────────────────────┐
│                  ElastiCache Cluster                │
│                                                     │
│  Primary 1  ─── Replica 1a, 1b                     │
│  Primary 2  ─── Replica 2a, 2b                     │
│  Primary 3  ─── Replica 3a, 3b                     │
│  Primary 4  ─── Replica 4a, 4b                     │
│  Primary 5  ─── Replica 5a, 5b                     │
│  Primary 6  ─── Replica 6a, 6b                     │
│                                                     │
│  6 primaries × ~100K ops/s = 600K write ops/s      │
│  12 replicas for read queries (status, dashboards)  │
└─────────────────────────────────────────────────────┘
```

### Sharding Strategy

Keys shard by consistent hash, so a given `user:abc123` always goes to the same primary node — no cross-node coordination. This is built into Redis Cluster protocol automatically.

To ensure related keys land on the same shard (important for multi-key Lua scripts), use **hash tags**:

```bash
# Without hash tag — curr and prev may land on different nodes!
rl:v1:user:abc:28433334   → node 2
rl:v1:user:abc:28433333   → node 5  ← PROBLEM: Lua can't atomic across nodes

# With hash tag — both land on same node
rl:v1:{user:abc}:28433334  → node 2
rl:v1:{user:abc}:28433333  → node 2  ← CORRECT
```

Modify key builder to wrap the stable identifier portion in `{}`:

```typescript
function buildKey(dimension: string, identifier: string, bucket: number): string {
  return `rl:v1:{${dimension}:${identifier}}:${bucket}`
}
```

### maxmemory Policy

```
maxmemory-policy allkeys-lru
```

Use `allkeys-lru`, NOT `volatile-lru`. Rate limiter keys all have TTLs set, making them prime eviction targets under `volatile-lru`. With `allkeys-lru`, eviction is spread across all keys proportionally, preserving counter accuracy under memory pressure.

---

## Connection Management

### Lambda — Lambda Extension

The Extension manages one persistent Redis connection per Lambda container. This connection survives across invocations (unlike connections made inside the handler, which can timeout between invocations).

```typescript
// extension/redis-client.ts
import { createClient } from 'redis'

let client: ReturnType<typeof createClient> | null = null

export async function getClient() {
  if (!client || !client.isOpen) {
    client = createClient({
      url: process.env.REDIS_URL,
      socket: {
        tls: true,
        reconnectStrategy: (retries) => Math.min(retries * 50, 2000)
      },
      pingInterval: 30_000  // Keep alive through Lambda idle periods
    })
    await client.connect()
    await loadLuaScripts(client)  // SCRIPT LOAD on connect
  }
  return client
}
```

### EC2/ECS — Connection Pool

Use a connection pool sized to your concurrency. For Node.js, `ioredis` cluster client handles pooling automatically:

```typescript
import { Cluster } from 'ioredis'

const redis = new Cluster([
  { host: 'elasticache-endpoint', port: 6379 }
], {
  redisOptions: {
    tls: {},
    password: process.env.REDIS_AUTH_TOKEN,
    connectTimeout: 200,    // Fail fast — don't hang requests
    commandTimeout: 100,    // 100ms max per Redis command
  },
  enableReadyCheck: true,
  maxRetriesPerRequest: 1,  // Fail fast to trigger fallback policy
})
```

---

## Script Pre-Loading (EVALSHA)

On every Redis connection (cold start for Lambda Extension, startup for EC2), load all Lua scripts:

```typescript
const SCRIPT_SHAS: Record<string, string> = {}

async function loadLuaScripts(client: RedisClient) {
  const scripts = {
    check:       readFileSync('./lua/check.lua', 'utf8'),
    checkMulti:  readFileSync('./lua/check_multi.lua', 'utf8'),
    reset:       readFileSync('./lua/reset.lua', 'utf8'),
    status:      readFileSync('./lua/status.lua', 'utf8'),
  }
  
  for (const [name, script] of Object.entries(scripts)) {
    SCRIPT_SHAS[name] = await client.scriptLoad(script)
  }
}
```

Handle `NOSCRIPT` errors (after failover to a new primary that hasn't seen the scripts):

```typescript
async function evalsha(name: string, keys: string[], args: string[]) {
  try {
    return await redis.evalsha(SCRIPT_SHAS[name], keys.length, ...keys, ...args)
  } catch (err) {
    if (err.message.startsWith('NOSCRIPT')) {
      await loadLuaScripts(redis)  // Re-load after failover
      return await redis.evalsha(SCRIPT_SHAS[name], keys.length, ...keys, ...args)
    }
    throw err
  }
}
```
