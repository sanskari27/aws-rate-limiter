# 07 — Thundering Herd Prevention

## What Is the Thundering Herd Problem

In the context of rate limiting, "thundering herd" refers to two distinct but related problems:

**Problem A — Window Reset Surge:** When a rate limit window resets (e.g., at the top of every minute), every client that was blocked simultaneously receives permission to retry. They all hit your service at the same instant, causing a spike that can be larger than the original traffic.

**Problem B — Lambda Cold Start Surge:** When a fleet of Lambda functions scales out simultaneously (e.g., after a traffic spike), hundreds or thousands of containers try to connect to Redis at the same moment. This can exhaust Redis connection limits or cause connection timeout storms.

**Problem C — Redis Recovery Surge:** When Redis comes back online after an outage, all the requests that were being served via fail-open policy (or queued) hit Redis simultaneously.

---

## Problem A — Window Reset Surge

### The Mechanism

```
T=59s: 10,000 users hit rate limit. All receive Retry-After: 1s
T=60s: Window resets. All 10,000 users retry simultaneously.
       Your service receives 10,000 requests in <1ms.
       Rate limiter checks Redis 10,000 times in a burst.
       New window refills → all pass → downstream receives 10,000 req spike.
```

### Solution 1: Jitter on Retry-After

Instead of returning the exact reset time, add random jitter:

```typescript
function computeRetryAfter(resetMs: number, windowMs: number): number {
  const baseDelay = resetMs  // ms until window resets
  const jitterMax = windowMs * 0.15  // up to 15% of window size
  const jitter    = Math.random() * jitterMax
  return Math.ceil(baseDelay + jitter)
}

// Example: window=60s, reset in 2s
// Without jitter: all clients retry in exactly 2s
// With jitter:    clients retry between 2s and 11s (2 + 0..9s)
```

In the response headers:

```typescript
res.set('Retry-After', String(Math.ceil(computeRetryAfter(ttlMs, windowMs) / 1000)))
```

### Solution 2: Staggered Window Offsets (Advanced)

Instead of all windows resetting at the same wall-clock time, offset each user's window by a hash of their user ID:

```typescript
function computeBucket(userId: string, now: number, windowMs: number): number {
  // Hash the user ID to get a per-user offset (0..window)
  const offset = hashToRange(userId, windowMs)
  return Math.floor((now - offset) / windowMs)
}

// User abc123: offset=12000ms → window resets at T=12, 72, 132...
// User def456: offset=37000ms → window resets at T=37, 97, 157...
// No two users reset at the same time.
```

This completely eliminates synchronized window resets. Downside: windows are harder to reason about for debugging.

### Solution 3: Exponential Backoff in Client SDKs

If you control the client (internal services, mobile SDKs), implement exponential backoff with jitter:

```typescript
// Client-side retry logic
async function callWithRetry(fn: () => Promise<Response>, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fn()
    
    if (response.status !== 429) return response
    
    const retryAfter = parseInt(response.headers.get('Retry-After') ?? '1') * 1000
    const backoff = retryAfter * Math.pow(2, attempt)
    const jitter  = Math.random() * backoff * 0.3
    
    await sleep(backoff + jitter)
  }
  throw new Error('Max retries exceeded')
}
```

---

## Problem B — Lambda Cold Start Connection Surge

### The Mechanism

```
Traffic spike at T=0:
  Lambda scales from 10 → 500 instances in 30s
  All 490 new instances do: TLS handshake + AUTH + SCRIPT LOAD to Redis
  490 simultaneous connection attempts → Redis connection queue fills up
  Some connections time out → NOSCRIPT errors → error spike
```

### Solution 1: Lambda Extension with Staggered Connect

The Extension initializes the Redis connection, but staggered:

```typescript
// extension/index.ts
async function main() {
  // Add startup jitter to stagger cold-start connections
  const startupJitter = Math.random() * 500  // 0-500ms
  await sleep(startupJitter)
  
  const client = await connectWithRetry()
  await loadLuaScripts(client)
  
  const server = await startLocalServer(client)
  await processLifecycleEvents()
}

async function connectWithRetry(maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const client = createClient({ url: process.env.REDIS_URL })
      await client.connect()
      return client
    } catch (err) {
      const delay = Math.min(100 * Math.pow(2, i), 5000)  // Exponential backoff
      await sleep(delay + Math.random() * 100)
    }
  }
  throw new Error('Failed to connect to Redis after max attempts')
}
```

### Solution 2: ElastiCache Serverless (Recommended)

ElastiCache Serverless automatically manages connection pooling and scales to handle connection spikes. With Serverless, you don't hit a per-node connection limit — AWS manages the proxy layer.

```terraform
resource "aws_elasticache_serverless_cache" "rate_limiter" {
  engine = "redis"
  name   = "rate-limiter"
  
  cache_usage_limits {
    data_storage {
      maximum = 10  # GB
      unit    = "GB"
    }
    ecpu_per_second {
      maximum = 5000
    }
  }
  
  security_group_ids = [aws_security_group.redis.id]
  subnet_ids         = var.private_subnet_ids
}
```

### Solution 3: Connection Pooling Proxy (EC2/ECS)

For non-Serverless deployments, run a Redis proxy (e.g., Envoy, Twemproxy) that pools connections between your service fleet and Redis:

```
EC2 instances (1000 connections) → Envoy proxy → Redis (50 connections)
```

---

## Problem C — Redis Recovery Surge

### The Mechanism

When Redis recovers after an outage where `failurePolicy = 'open'` was in effect, every request that was allowed through tries to register against Redis simultaneously.

### Solution: Circuit Breaker with Half-Open State

```typescript
class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed'
  private failureCount = 0
  private lastFailureTime = 0
  private readonly threshold = 5
  private readonly recoveryTimeout = 10_000  // 10s before trying again
  
  async call<T>(fn: () => Promise<T>, fallback: () => T): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.recoveryTimeout) {
        this.state = 'half-open'  // Try one request to probe Redis
      } else {
        return fallback()  // Still open — use fallback
      }
    }
    
    try {
      const result = await fn()
      
      if (this.state === 'half-open') {
        this.state = 'closed'  // Recovery successful
        this.failureCount = 0
        logger.info('Circuit breaker closed — Redis recovered')
      }
      
      return result
    } catch (err) {
      this.failureCount++
      this.lastFailureTime = Date.now()
      
      if (this.failureCount >= this.threshold || this.state === 'half-open') {
        this.state = 'open'
        logger.error('Circuit breaker opened — Redis unavailable')
        metrics.increment('rate_limiter.circuit_breaker.open')
      }
      
      return fallback()
    }
  }
}
```

During recovery, the half-open state sends only 1 probe request to Redis. If it succeeds, the circuit closes and normal operation resumes. The recovery is gradual — not a thundering surge.

---

## Summary of Mitigations

| Problem | Primary Mitigation | Secondary |
|---|---|---|
| Window reset surge | Jitter on Retry-After | Staggered window offsets |
| Lambda cold start surge | ElastiCache Serverless | Extension startup jitter |
| Redis recovery surge | Circuit breaker half-open | Exponential backoff |
| Client retry storm | Exponential backoff in SDK | Jitter on Retry-After |

All four mitigations are implemented in this module. Jitter and circuit breaker are enabled by default. ElastiCache Serverless is recommended in the Terraform config.
