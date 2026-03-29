# 10 — Observability

## Metric Taxonomy

All metrics follow the naming convention: `rate_limiter.{category}.{name}`

---

## Core Traffic Metrics

| Metric | Type | Tags | Description |
|---|---|---|---|
| `rate_limiter.check.total` | Counter | `route`, `dimension` | Total rate limit checks |
| `rate_limiter.check.allowed` | Counter | `route`, `dimension` | Allowed requests |
| `rate_limiter.check.denied` | Counter | `route`, `dimension`, `user_tier` | Denied requests (429) |
| `rate_limiter.check.latency` | Histogram | `route`, `source` | Time to complete check (ms) |
| `rate_limiter.check.source` | Counter | `source` (reservoir/redis) | Where the decision came from |

### Derived Signals

```
denial_rate     = rate_limiter.check.denied / rate_limiter.check.total
reservoir_ratio = rate_limiter.check.source{source="reservoir"} / total
redis_savings   = 1 - (redis_calls / total_requests)
```

---

## Reservoir Metrics

| Metric | Type | Tags | Description |
|---|---|---|---|
| `rate_limiter.reservoir.hit` | Counter | `dimension` | Served from local reservoir |
| `rate_limiter.reservoir.miss` | Counter | `dimension` | Reservoir empty, Redis called |
| `rate_limiter.reservoir.refill` | Counter | `dimension` | Redis batch fetch triggered |
| `rate_limiter.reservoir.tokens_granted` | Histogram | `dimension` | Tokens returned per refill |
| `rate_limiter.reservoir.flush` | Counter | — | Tokens returned to Redis on shutdown |

---

## Redis Health Metrics

| Metric | Type | Tags | Description |
|---|---|---|---|
| `rate_limiter.redis.latency` | Histogram | `operation` | Redis command latency (ms) |
| `rate_limiter.redis.errors` | Counter | `error_type` | Redis error count |
| `rate_limiter.redis.connections` | Gauge | — | Active connection count |
| `rate_limiter.redis.memory_utilization` | Gauge | `node` | Redis memory % used |
| `rate_limiter.noscript_reload` | Counter | — | Script reload count after failover |

---

## Failure Mode Metrics

| Metric | Type | Tags | Description |
|---|---|---|---|
| `rate_limiter.fail_open` | Counter | `route` | Requests allowed due to Redis failure |
| `rate_limiter.fail_closed` | Counter | `route` | Requests rejected due to Redis failure |
| `rate_limiter.fail_local` | Counter | `route` | Requests served by local fallback |
| `rate_limiter.circuit_breaker.open` | Counter | — | Circuit breaker state transitions |
| `rate_limiter.circuit_breaker.state` | Gauge | — | 0=closed, 1=half-open, 2=open |
| `rate_limiter.wrongtype_error` | Counter | — | Redis key type collision |

---

## Emitting Metrics

### CloudWatch (Lambda)

```typescript
import { CloudWatch } from '@aws-sdk/client-cloudwatch'

const cw = new CloudWatch({ region: process.env.AWS_REGION })

class CloudWatchMetrics {
  private buffer: MetricDatum[] = []
  
  increment(name: string, tags: Record<string, string> = {}, value = 1) {
    this.buffer.push({
      MetricName: name,
      Value: value,
      Unit: 'Count',
      Dimensions: Object.entries(tags).map(([Name, Value]) => ({ Name, Value })),
      Timestamp: new Date(),
    })
    
    if (this.buffer.length >= 20) this.flush()
  }
  
  histogram(name: string, value: number, tags: Record<string, string> = {}) {
    this.buffer.push({
      MetricName: name,
      Value: value,
      Unit: 'Milliseconds',
      Dimensions: Object.entries(tags).map(([Name, Value]) => ({ Name, Value })),
    })
  }
  
  async flush() {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0, 20)
    
    await cw.putMetricData({
      Namespace: 'RateLimiter',
      MetricData: batch,
    }).catch(err => logger.warn({ err }, 'Failed to flush CloudWatch metrics'))
  }
}
```

### Prometheus / StatsD (EC2/ECS)

```typescript
import { Registry, Counter, Histogram, Gauge } from 'prom-client'

const registry = new Registry()

export const metrics = {
  checkTotal:  new Counter({ name: 'rate_limiter_check_total', help: 'Total checks', labelNames: ['route', 'dimension'], registers: [registry] }),
  checkDenied: new Counter({ name: 'rate_limiter_check_denied', help: 'Denied checks', labelNames: ['route', 'dimension', 'user_tier'], registers: [registry] }),
  checkLatency: new Histogram({ name: 'rate_limiter_check_latency_ms', help: 'Check latency', buckets: [0.1, 0.5, 1, 2, 5, 10, 50], labelNames: ['source'], registers: [registry] }),
  failOpen:    new Counter({ name: 'rate_limiter_fail_open_total', help: 'Fail-open events', labelNames: ['route'], registers: [registry] }),
  redisMemory: new Gauge({ name: 'rate_limiter_redis_memory_ratio', help: 'Redis memory utilization', registers: [registry] }),
}

// Expose /metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType)
  res.end(await registry.metrics())
})
```

---

## CloudWatch Alarms

```typescript
// infrastructure/cloudwatch-alarms.ts (or Terraform)

const alarms = [
  {
    AlarmName: 'RateLimiter-HighDenialRate',
    MetricName: 'rate_limiter.check.denied',
    Namespace: 'RateLimiter',
    Period: 60,
    EvaluationPeriods: 3,
    Threshold: 1000,           // More than 1000 denials/minute
    ComparisonOperator: 'GreaterThanThreshold',
    AlarmActions: [SNS_TOPIC_ARN],
    TreatMissingData: 'notBreaching',
  },
  {
    AlarmName: 'RateLimiter-RedisFailOpen',
    MetricName: 'rate_limiter.fail_open',
    Namespace: 'RateLimiter',
    Period: 60,
    EvaluationPeriods: 1,
    Threshold: 1,              // Any fail-open event is worth investigating
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    AlarmActions: [SNS_TOPIC_ARN],
    TreatMissingData: 'notBreaching',
  },
  {
    AlarmName: 'RateLimiter-RedisMemoryHigh',
    MetricName: 'rate_limiter.redis.memory_utilization',
    Namespace: 'RateLimiter',
    Period: 300,
    EvaluationPeriods: 2,
    Threshold: 0.85,           // 85% memory utilization
    ComparisonOperator: 'GreaterThanThreshold',
    AlarmActions: [SNS_TOPIC_ARN],
  },
  {
    AlarmName: 'RateLimiter-HighLatency',
    ExtendedStatistic: 'p99',
    MetricName: 'rate_limiter.check.latency',
    Namespace: 'RateLimiter',
    Period: 60,
    EvaluationPeriods: 5,
    Threshold: 10,             // p99 > 10ms
    ComparisonOperator: 'GreaterThanThreshold',
    AlarmActions: [SNS_TOPIC_ARN],
  },
]
```

---

## Structured Logging

Every decision emits a structured log line. Use log sampling at high traffic to avoid log volume explosion:

```typescript
interface RateLimitLogEntry {
  ts:          string      // ISO timestamp
  level:       'info' | 'warn' | 'error'
  event:       'allowed' | 'denied' | 'fail_open' | 'fail_closed' | 'fail_local'
  route:       string
  dimension?:  string      // Which dimension triggered deny
  effective?:  number      // Effective count at time of check
  limit?:      number
  remaining?:  number
  userId?:     string      // Hashed
  ip?:         string      // Truncated for privacy
  latency_ms:  number
  source:      'reservoir' | 'redis' | 'local_fallback'
}

// Sample logging: log 1% of allowed, 100% of denied
function shouldLog(event: string): boolean {
  if (event === 'allowed') return Math.random() < 0.01
  return true  // Always log denials and failures
}
```

---

## Admin API Endpoints

Expose internal endpoints (protected by internal auth) for operations:

```typescript
// GET /internal/rate-limit/status?userId=abc&route=POST_api_orders
// Returns current effective count and remaining quota without consuming any tokens

// POST /internal/rate-limit/reset { userId: "abc" }
// Resets all rate limit keys for a user (e.g., customer support unblocking a user)

// GET /internal/rate-limit/top-users?dimension=user&window=60
// Returns top 10 users by request volume in the current window

// GET /internal/rate-limit/redis/health
// Returns Redis cluster health, memory usage, and connection count
```

The `/top-users` endpoint is the most operationally useful — it's how you identify abusers in production:

```typescript
app.get('/internal/rate-limit/top-users', async (req, res) => {
  const pattern = `rl:v1:user:*:${currentBucket()}`
  const keys    = await redis.keys(pattern)  // Offline/admin only — never in hot path
  
  const counts = await Promise.all(
    keys.map(async (key) => ({
      key,
      count: parseInt(await redis.get(key) ?? '0'),
    }))
  )
  
  const top10 = counts
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
  
  res.json({ top10, bucket: currentBucket(), window: 60 })
})
```
