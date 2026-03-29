# 02 — Sliding Window Counter Algorithm

## Why Sliding Window Counter

From our algorithm comparison, five options were evaluated:

| Algorithm | Memory | Accuracy | Redis ops | Verdict |
|---|---|---|---|---|
| Fixed window | O(1) | ~85% (boundary burst) | 1 | Eliminated — boundary burst doubles effective limit |
| Sliding window log | O(N) | 100% | 3 | Eliminated — 60M entries/key at 1M req/s |
| **Sliding window counter** | **O(1)** | **~99%** | **2** | **Selected** |
| Token bucket | O(1) | ~85% | 2 | Viable alternative for burst-heavy traffic |
| Leaky bucket | O(N) | ~85% | 2+ | Eliminated — requires drain worker |

The sliding window counter gives you the memory efficiency of fixed window with dramatically better accuracy, at the cost of a ~1% approximation at window boundaries that is imperceptible in practice.

---

## The Core Formula

```
effective_count = prev_count × ((window - elapsed) / window) + curr_count
```

Where:
- `prev_count` = requests in the previous fixed window bucket
- `curr_count` = requests in the current fixed window bucket  
- `window` = window size in milliseconds
- `elapsed` = time elapsed since the start of the current bucket (`now % window`)
- `weight` = `(window - elapsed) / window` — the fraction of the previous window still "inside" the rolling window

### What the Formula Does

It estimates how many of the previous bucket's requests fall within the rolling `[now - window, now]` interval, using linear interpolation. As time progresses through the current window:

- At `elapsed = 0` (window just reset): `weight = 1.0` — all of prev counts
- At `elapsed = window/2` (halfway through): `weight = 0.5` — half of prev counts
- At `elapsed = window` (end of window): `weight = 0.0` — none of prev counts

### The 1% Error

The formula assumes requests were uniformly distributed across the previous window. If they weren't (e.g., all arrived in the last second of the previous window), the interpolation overestimates how many have "expired". In the worst case this leads to allowing slightly more than the limit. The maximum overcount is bounded and small enough to be acceptable for all non-financial API use cases.

---

## Step-by-Step Example

Setup: `limit = 100`, `window = 60s`, request arrives at `T = 70s` (10s into the second window).

```
Timeline:
│← Window 1 (T=0..60s) →│← Window 2 (T=60..120s) →│
                                   ↑
                               now = T+70s
                               elapsed = 70 % 60 = 10s

prev_count = 80  (requests in window 1)
curr_count = 30  (requests so far in window 2)
elapsed    = 10s
weight     = (60 - 10) / 60 = 0.833

effective  = 80 × 0.833 + 30
           = 66.67 + 30
           = 96.67

96.67 < 100 → ALLOWED
remaining  = 100 - 96.67 = 3.33 → report as 3
```

If `curr_count` were `5` more (35), effective = 101.67 → DENIED, 429 returned.

---

## Bucket Calculation

Each "bucket" is a fixed time slice identified by an integer:

```typescript
const curr_bucket = Math.floor(Date.now() / window_ms)
const prev_bucket = curr_bucket - 1
```

For a 60-second window, `Date.now() = 1706000070000`:
```
curr_bucket = Math.floor(1706000070000 / 60000) = 28433334
prev_bucket = 28433333
```

The bucket number is appended to the Redis key. When the window advances, you naturally start writing to a new key (`28433335`), and the old key decays via TTL.

---

## Why Two Buckets Instead of One

Fixed window uses one key per window. The problem: at `T=59s` a user fires 100 requests (fills the bucket). At `T=61s` the window resets — they fire another 100. In 2 seconds they sent 200 requests against a 100-per-minute limit. This is the boundary burst problem.

Sliding window counter avoids this by keeping the previous bucket alive and weighting it. The weight approaches zero as the window progresses, so old requests "fade out" smoothly rather than vanishing all at once.

---

## Algorithm Pseudocode

```
function check_rate_limit(user_id, route, ip, cost=1):
    
    # Build keys for each dimension
    for each dimension in [ip, route, user, user_route]:
        curr_key = build_key(dimension, curr_bucket)
        prev_key = build_key(dimension, prev_bucket)
        
        # Atomic check via Lua (single Redis round-trip)
        result = redis.evalsha(SCRIPT_SHA, 
            keys=[curr_key, prev_key],
            args=[limit[dimension], window_ms, now_ms, cost]
        )
        
        allowed, effective, limit, ttl_ms = result
        
        if not allowed:
            return DENY(retry_after = ttl_ms + jitter())
    
    # All dimensions passed
    return ALLOW(remaining = limit - effective)
```

---

## Dimension Check Order (Cheapest First)

Checking dimensions in order of specificity (broadest first) allows fast-failing before reaching expensive composite key lookups:

```
1. IP check         ← catches scanners, botnets, shared-IP abuse
2. Route check      ← catches endpoint-specific overload
3. User check       ← catches heavy users across all routes
4. User+Route check ← precise per-endpoint per-user enforcement
```

If any check fails, the request is immediately rejected. Subsequent checks are skipped. This means a blocked IP never causes a user check Redis call, saving ops at the top of the funnel.

---

## Cost-Weighted Requests

Not all requests are equal. The Lua script accepts a `cost` parameter:

```typescript
// These all consume different amounts of the same rate limit budget
await rateLimiter.check(ctx, { cost: 1 })    // standard GET
await rateLimiter.check(ctx, { cost: 5 })    // search query (expensive)
await rateLimiter.check(ctx, { cost: 20 })   // file upload
await rateLimiter.check(ctx, { cost: 50 })   // batch operation
```

Configure cost per route in your config:

```yaml
routes:
  - pattern: "GET /api/*"
    cost: 1
  - pattern: "POST /api/search"
    cost: 5
  - pattern: "POST /api/upload"
    cost: 20
  - pattern: "POST /api/batch"
    cost: 50
```

---

## Accuracy Analysis

The ~1% error manifests only when:
1. The previous window had significant traffic, AND
2. That traffic was NOT uniformly distributed (it arrived in a burst)

In all uniform or near-uniform traffic patterns, the algorithm is effectively 100% accurate.

Worst case scenario (pathological): All 100 requests in the previous window arrived in the final 1 second. At `elapsed = 1s`, weight = `(60-1)/60 = 0.983`, so effective = `100 × 0.983 + 0 = 98.3`. The algorithm thinks 98.3 requests are still in the window when actually all 100 are — undercount by 1.7%. This means a user could squeeze in slightly more than the limit in this edge case.

For a production user-facing API, this is acceptable. For financial transaction limiting (where you need hard guarantees), use token bucket instead, or add a secondary hard fixed-window check.
