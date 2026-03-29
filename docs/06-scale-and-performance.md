# 06 — Scale and Performance

## The 1M req/s Target

Achieving 1M req/s requires a layered strategy. No single component can handle it alone.

```
1M req/s total
│
├── Layer 1: Local Reservoir (absorbs ~99% of traffic)
│   Each Lambda/EC2 instance serves from in-memory token pool
│   Redis is only consulted when a reservoir refill is needed
│   Effective Redis traffic: ~10K ops/s (100x reduction)
│
├── Layer 2: Redis Cluster (handles the remaining ~1% = ~10K ops/s)
│   6 primary nodes × 100K ops/s = 600K ops/s headroom
│   Well within limits with 60x spare capacity
│
└── Layer 3: Connection Management
    Lambda Extension: 1 persistent connection per container
    EC2: connection pool sized to concurrency
```

---

## Layer 1 — Local Reservoir (Most Important)

Without the reservoir, 1M req/s means 1M Redis calls/s. With a reservoir of 100 tokens per key:

```
Redis calls = (total_requests / reservoir_batch_size)
            = 1,000,000 / 100
            = 10,000 calls/s ← easily handled by a 2-node cluster
```

### How Reservoir Sizing Affects Accuracy

```
Scenario: 100 req/min limit, 50 Lambda instances, batch_size = 100

Max tokens in flight across all instances:
  50 instances × 100 tokens = 5,000 tokens "checked out"

This means up to 5,000 requests could be served before Redis enforces the 100 req/min limit.
The limit is effectively 5,000 during a burst.

Fix: batch_size = max(1, floor(limit / (instances * safety_factor)))
  = max(1, floor(100 / (50 * 10))) = 0 → round up to 1

With batch_size = 1: no reservoir benefit, but exact enforcement.
With batch_size = 2: limit could reach 100 (50×2). Acceptable.
```

### Adaptive Batch Size

For high-limit endpoints (e.g., enterprise tier at 50,000 req/min), larger batch sizes are safe and beneficial:

```typescript
function computeBatchSize(limit: number, expectedInstances: number): number {
  const maxOvershoot = limit * 0.05  // Allow up to 5% overshoot
  return Math.max(1, Math.floor(maxOvershoot / expectedInstances))
}

// limit=100, instances=5:    batchSize = floor(5/5)   = 1
// limit=1000, instances=10:  batchSize = floor(50/10) = 5
// limit=50000, instances=50: batchSize = floor(2500/50) = 50
```

---

## Layer 2 — Redis Cluster Sizing

### Single Node Baseline

| Operation | Throughput |
|---|---|
| Simple GET/SET | ~200K ops/s |
| EVALSHA (Lua script) | ~100K ops/s |
| INCRBY | ~150K ops/s |
| PEXPIRE | ~150K ops/s |

The Lua script does: 2× GET + 1× INCRBY + 1× PEXPIRE = 4 commands per check. At ~100K scripts/s per node, that's 400K Redis ops/s per node in total.

### Cluster Math

```
Target: handle 10K Redis calls/s (after reservoir)
Each call = 1 Lua script execution
Required nodes: 10K / 100K = 0.1 nodes

Start with 3 primaries for HA, scale to 6 for growth headroom.
```

Even at 1M Redis calls/s (no reservoir), 10 nodes suffice. The reservoir makes the cluster a non-bottleneck.

### Node Type Recommendations (ElastiCache)

| Traffic | Node Type | Notes |
|---|---|---|
| Dev/staging | `cache.t3.medium` | 3.09 GB RAM, ~20K ops/s |
| Small prod | `cache.r7g.large` | 13.07 GB RAM, ~100K ops/s |
| Large prod | `cache.r7g.xlarge` | 26.32 GB RAM, ~200K ops/s |
| 1M req/s target | 6× `cache.r7g.large` cluster | 600K ops/s, 78 GB RAM |

---

## Layer 3 — Connection Management

### Lambda Cold Start Optimization

The Lambda Extension approach eliminates per-invocation Redis connection overhead:

```
Without Extension:
  Cold start: +200ms (TLS handshake + auth + SCRIPT LOAD)
  Warm invocation: connection may be stale → +50ms reconnect
  
With Extension:
  Cold start: Extension connects once when container starts (+200ms, not on critical path)
  Warm invocation: connection already open → +0ms connection overhead
  Redis round-trip: ~0.5ms (same AZ)
```

### Lambda Concurrency and Connections

```
Max concurrent Lambdas: 1000 (account default)
Connections per Lambda: 1 (via Extension)
Total Redis connections: 1000

ElastiCache max connections per node:
  cache.r7g.large: ~65,000 connections
  
1000 << 65,000 → no connection exhaustion risk
```

### EC2/ECS Connection Pool

```typescript
// Recommended pool settings for a typical EC2 service
const redis = new Cluster(endpoints, {
  redisOptions: {
    maxRetriesPerRequest: 1,    // Fail fast → trigger fallback
    connectTimeout: 200,         // 200ms to establish connection
    commandTimeout: 100,         // 100ms max per command
    lazyConnect: false,          // Pre-connect at startup
  },
  // Cluster-level settings
  enableAutoPipelining: true,   // Batch multiple commands automatically
  maxRedirections: 3,           // Follow MOVED/ASK redirects
  retryDelayOnFailover: 100,    // Wait 100ms on failover
})
```

---

## Latency Budget

Total rate limiting overhead budget: **< 5ms p99**

```
Component                     p50    p99
───────────────────────────────────────
Local reservoir hit            0.01ms  0.1ms
Redis EVALSHA (same AZ)        0.3ms   1.5ms
Key construction               0.01ms  0.05ms
Header generation              0.01ms  0.05ms
NOSCRIPT retry (rare)          N/A    ~5ms

Total (reservoir hit):         0.03ms  0.2ms   ← 99% of requests
Total (Redis call):            0.35ms  1.7ms   ← ~1% of requests
Total (NOSCRIPT, very rare):   5ms    10ms     ← after failover only
```

---

## Load Testing

Use k6 to validate scale targets before production:

```javascript
// tests/load/rate-limiter-k6.js
import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  stages: [
    { duration: '30s', target: 100 },    // Ramp up
    { duration: '2m',  target: 1000 },   // Sustained load
    { duration: '30s', target: 5000 },   // Spike test
    { duration: '1m',  target: 1000 },   // Return to normal
    { duration: '30s', target: 0 },      // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(99)<5'],       // 99% of requests < 5ms overhead
    http_req_failed:   ['rate<0.01'],     // < 1% error rate
    'checks{name:rate_limit_headers}': ['rate>0.99'],  // Headers always present
  },
}

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:3000'

export default function () {
  const userId = `user_${Math.floor(Math.random() * 1000)}`
  const response = http.get(`${BASE_URL}/api/test`, {
    headers: {
      'X-User-ID': userId,
      'X-API-Key': `key_${userId}`,
    },
  })
  
  check(response, {
    'rate_limit_headers': (r) =>
      r.headers['X-RateLimit-Limit'] !== undefined &&
      r.headers['X-RateLimit-Remaining'] !== undefined,
    'valid status': (r) => r.status === 200 || r.status === 429,
    '429 has retry-after': (r) =>
      r.status !== 429 || r.headers['Retry-After'] !== undefined,
  })
}
```

Run:
```bash
k6 run --env TARGET_URL=https://your-api.example.com tests/load/rate-limiter-k6.js
```

---

## Performance Anti-Patterns to Avoid

**1. Calling Redis on every request (no reservoir)**
Redis latency at 0.5ms × 1M req/s = 500,000ms of cumulative latency per second per node. Use the reservoir.

**2. Large Lua scripts**
Redis Lua runs single-threaded. Long scripts block all other commands. Keep scripts under ~10 operations. The scripts in this system are all 4–8 operations.

**3. Using KEYS pattern matching in Lua**
`redis.call('KEYS', 'rl:*')` scans the entire keyspace. O(N) where N = total keys. Never do this in the hot path. All lookups are O(1) by design.

**4. Not using PEXPIRE**
`EXPIRE` has second granularity. For sub-second windows, use `PEXPIRE` (millisecond precision). The rate limiter always uses `PEXPIRE`.

**5. Synchronous SCRIPT LOAD on every invocation**
Load scripts once on connection, cache the SHA. `EVALSHA` is fast; `SCRIPT LOAD` parses and compiles the script each time.

**6. Cross-shard Lua scripts without hash tags**
A Lua script can only operate on keys that live on the same Redis node. Without hash tags, `curr_key` and `prev_key` may land on different nodes → CROSSSLOT error. Always use `{hash_tag}` in key names (see [03-redis-design.md](./03-redis-design.md)).
