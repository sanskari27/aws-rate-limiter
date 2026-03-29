# 08 — Failure Modes

## Failure Taxonomy

```
Redis unreachable
├── Connection refused / timeout
│   ├── ElastiCache endpoint wrong or not reachable from VPC
│   └── Security group blocking port 6379/6380
│
├── Auth failure
│   └── AUTH token wrong or expired
│
└── Failover in progress
    ├── Primary promoted replica (15-30s window)
    └── NOSCRIPT error after failover (scripts not loaded on new primary)

Redis reachable but misbehaving
├── WRONGTYPE error (key collision with app data)
├── OOM / maxmemory reached
├── BUSY (long-running script, should not occur)
└── CROSSSLOT (Lua script across shards, missing hash tags)

Application-layer failures
├── Key builder throws (invalid user ID, null route)
├── Config not loaded (missing env vars)
└── Reservoir flush failure on shutdown
```

---

## Failure Policies

Configurable per route. Three options:

### `fail_open` (default for most routes)

Allow all traffic when Redis is unavailable. Service stays up; rate limiting is temporarily disabled.

```typescript
// Rate limit check
try {
  return await redis.evalsha(...)
} catch (err) {
  logger.warn('Redis unavailable — failing open', { err, route: ctx.route })
  metrics.increment('rate_limiter.fail_open', { route: ctx.route })
  return { allowed: true, effective: 0, limit: Infinity, remaining: Infinity, ... }
}
```

Appropriate for: public read APIs, content endpoints, anything where availability is more important than precise limiting.

### `fail_closed`

Reject all traffic when Redis is unavailable. Returns 503 (not 429).

```typescript
} catch (err) {
  logger.error('Redis unavailable — failing closed', { err, route: ctx.route })
  metrics.increment('rate_limiter.fail_closed', { route: ctx.route })
  return {
    allowed: false,
    statusCode: 503,
    message: 'Service temporarily unavailable — rate limiter backend unreachable',
  }
}
```

Appropriate for: payment endpoints, auth endpoints, any route where allowing uncontrolled traffic could cause fraud or abuse.

### `fail_local`

Fall back to a per-instance in-memory fixed-window counter. Rate limiting continues to work, but limits are enforced per-process rather than globally.

```typescript
class LocalFallbackLimiter {
  private counters = new Map<string, { count: number, resetAt: number }>()
  
  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now()
    const entry = this.counters.get(key)
    
    if (!entry || now > entry.resetAt) {
      this.counters.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }
    
    if (entry.count >= limit) return false
    
    entry.count++
    return true
  }
}

// In the rate limiter:
} catch (err) {
  logger.warn('Redis unavailable — using local fallback limiter')
  metrics.increment('rate_limiter.fail_local', { route: ctx.route })
  const allowed = localFallback.check(buildLocalKey(ctx), config.limit, config.window)
  return { allowed, ... }
}
```

Appropriate for: medium-criticality endpoints where you want some rate limiting even during Redis outages, but a complete blackout is worse than approximate limiting.

---

## Configuring Failure Policies

```yaml
# config/rate-limit.yaml
failure:
  default: fail_open      # Fallback for routes without explicit policy

routes:
  - name: auth
    match: { routes: ["POST /auth/*"] }
    failure: fail_closed  # Never allow uncontrolled auth traffic

  - name: payments
    match: { routes: ["POST /api/payments/*"] }
    failure: fail_closed

  - name: search
    match: { routes: ["GET /api/search"] }
    failure: fail_local   # Local limiting is better than no limiting

  - name: public
    match: { routes: ["GET /api/public/*"] }
    failure: fail_open    # Availability over rate limiting
```

---

## NOSCRIPT Error (Post-Failover)

When ElastiCache promotes a replica to primary (during a failure), the new primary doesn't have the Lua scripts loaded. The first `EVALSHA` call fails with `NOSCRIPT`.

Handling:

```typescript
async function evalWithNoscriptRetry(name: string, keys: string[], args: string[]) {
  try {
    return await redis.evalsha(SCRIPT_SHAS[name], keys.length, ...keys, ...args)
  } catch (err: any) {
    if (!err.message?.startsWith('NOSCRIPT')) throw err
    
    logger.warn({ name }, 'NOSCRIPT error — reloading scripts after failover')
    metrics.increment('rate_limiter.noscript_reload')
    
    await loadLuaScripts(redis)  // Re-SCRIPT LOAD all scripts
    
    // Retry once. If this also fails, throw to trigger failure policy.
    return await redis.evalsha(SCRIPT_SHAS[name], keys.length, ...keys, ...args)
  }
}
```

This is transparent to the caller. The one-time reload adds ~5ms latency to the first post-failover request; subsequent requests are normal.

---

## WRONGTYPE Error (Key Collision)

If your application already uses Redis and a key like `rl:v1:...` happens to exist with a different type (e.g., a list instead of a string), `GET` will return a WRONGTYPE error.

Prevention: use a unique prefix that can't collide with application keys. The `rl:` prefix combined with a version helps, but you can add an environment suffix:

```typescript
const KEY_PREFIX = `rl:v1:${process.env.ENV}:`  // rl:v1:prod:, rl:v1:staging:
```

Detection and recovery:

```typescript
} catch (err: any) {
  if (err.message?.includes('WRONGTYPE')) {
    logger.error('Key type collision — wrong Redis database or prefix conflict', {
      key: err.command?.args?.[0],
    })
    metrics.increment('rate_limiter.wrongtype_error')
    // Treat as fail_open — don't crash the service over a config error
    return allowAll(ctx)
  }
}
```

---

## OOM / maxmemory Handling

When Redis hits its `maxmemory` limit:
- With `allkeys-lru`: Redis starts evicting least-recently-used keys. Rate limit counters may be evicted mid-window, effectively resetting that user's count to 0 (allowing a burst).
- With `volatile-lru`: Redis preferentially evicts keys with TTLs — all rate limit keys have TTLs, so they're prime eviction targets.

Detecting OOM pressure:

```typescript
// Periodically check Redis memory usage
async function checkRedisHealth() {
  const info = await redis.info('memory')
  const usedMemory = parseInt(info.match(/used_memory:(\d+)/)?.[1] ?? '0')
  const maxMemory  = parseInt(info.match(/maxmemory:(\d+)/)?.[1] ?? '0')
  
  if (maxMemory > 0) {
    const utilization = usedMemory / maxMemory
    metrics.gauge('rate_limiter.redis_memory_utilization', utilization)
    
    if (utilization > 0.85) {
      logger.warn({ utilization }, 'Redis memory above 85% — consider scaling')
      alerts.send('Redis memory high', { utilization })
    }
  }
}

// Run every 60 seconds
setInterval(checkRedisHealth, 60_000)
```

---

## Graceful Shutdown

On Lambda Extension `SHUTDOWN` event or EC2 `SIGTERM`:

```typescript
async function gracefulShutdown() {
  logger.info('Rate limiter shutting down — flushing reservoir')
  
  try {
    // Return unused pre-fetched tokens to Redis
    await reservoir.flush(redis)
    logger.info('Reservoir flushed successfully')
  } catch (err) {
    // Non-fatal — tokens will expire naturally via TTL
    logger.warn({ err }, 'Reservoir flush failed — tokens will expire via TTL')
  }
  
  await redis.quit()
}

// Lambda Extension
process.on('SIGTERM', gracefulShutdown)

// EC2 / ECS
process.on('SIGTERM', async () => {
  await gracefulShutdown()
  process.exit(0)
})
```

---

## Observability for Failure Modes

Emit metrics for every failure path so you can detect and alert:

| Metric | When Emitted | Alert Threshold |
|---|---|---|
| `rate_limiter.fail_open` | Redis error + fail_open policy | > 0.1% of requests |
| `rate_limiter.fail_closed` | Redis error + fail_closed policy | Any occurrence |
| `rate_limiter.fail_local` | Redis error + fail_local policy | > 0.1% of requests |
| `rate_limiter.noscript_reload` | NOSCRIPT error after failover | > 1/hour |
| `rate_limiter.wrongtype_error` | Key type collision | Any occurrence |
| `rate_limiter.redis_memory_utilization` | Health check | > 85% |
| `rate_limiter.circuit_breaker.open` | Circuit breaker trips | Any occurrence |

See [10-observability.md](./10-observability.md) for full metric definitions and CloudWatch alarm configs.
