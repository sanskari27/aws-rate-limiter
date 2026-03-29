# 04 — SDK Design

## Core Interface

The core SDK exposes a single primary method and supporting utilities:

```typescript
// packages/core/src/index.ts

export interface RateLimitContext {
  ip: string
  userId?: string
  apiKey?: string
  route: string          // normalized: "POST_api_orders"
  cost?: number          // default: 1
}

export interface RateLimitResult {
  allowed: boolean
  dimension: string      // which dimension triggered the deny (if denied)
  effective: number      // current effective count
  limit: number
  remaining: number
  resetAt: number        // unix epoch ms
  retryAfter?: number    // ms to wait before retry (only on deny)
}

export interface RateLimiterConfig {
  redis: RedisConfig
  rules: RuleConfig[]
  reservoir?: ReservoirConfig
  failure?: FailureConfig
  observability?: ObservabilityConfig
}

export class RateLimiter {
  constructor(config: RateLimiterConfig)
  
  // Primary method — checks all applicable dimensions
  async check(ctx: RateLimitContext): Promise<RateLimitResult>
  
  // Reset a specific key (admin use)
  async reset(dimension: string, identifier: string): Promise<void>
  
  // Get current status without incrementing (for dashboards)
  async status(ctx: RateLimitContext): Promise<RateLimitResult>
  
  // Graceful shutdown — flush reservoir tokens back to Redis
  async shutdown(): Promise<void>
}
```

---

## Rule Configuration

Rules are matched against the request context. First match wins.

```typescript
export interface RuleConfig {
  // Matching
  name: string
  match?: {
    routes?: string[]        // glob patterns: "POST /api/orders", "GET /api/*"
    userTiers?: string[]     // "free", "pro", "enterprise"
    ips?: string[]           // CIDR ranges
  }
  
  // Limits per dimension
  limits: {
    ip?:        LimitSpec
    route?:     LimitSpec
    user?:      LimitSpec
    userRoute?: LimitSpec
  }
  
  // Request cost
  cost?: number              // default: 1
  
  // Failure behavior for this route
  failurePolicy?: 'open' | 'closed' | 'local'
}

export interface LimitSpec {
  limit: number              // max requests
  window: number             // window size in seconds
}
```

### Example Rule Config (YAML)

```yaml
rules:
  # Public unauthenticated endpoints — strict IP limits
  - name: public-endpoints
    match:
      routes: ["GET /api/public/*"]
    limits:
      ip:
        limit: 30
        window: 60
      route:
        limit: 1000
        window: 60

  # Free tier users
  - name: free-tier
    match:
      userTiers: ["free"]
    limits:
      user:
        limit: 100
        window: 60
      userRoute:
        limit: 20
        window: 60

  # Pro tier users
  - name: pro-tier
    match:
      userTiers: ["pro"]
    limits:
      user:
        limit: 1000
        window: 60
      userRoute:
        limit: 200
        window: 60

  # Enterprise — very high limits, essentially just abuse protection
  - name: enterprise
    match:
      userTiers: ["enterprise"]
    limits:
      user:
        limit: 50000
        window: 60

  # Expensive operations — weighted cost
  - name: expensive-ops
    match:
      routes: ["POST /api/search", "POST /api/export", "POST /api/batch"]
    cost: 10
    limits:
      user:
        limit: 100
        window: 60

  # Auth endpoints — very strict, fail closed
  - name: auth-endpoints
    match:
      routes: ["POST /auth/*"]
    failurePolicy: closed
    limits:
      ip:
        limit: 10
        window: 60
      route:
        limit: 100
        window: 60

  # Default fallback
  - name: default
    limits:
      ip:
        limit: 60
        window: 60
      user:
        limit: 500
        window: 60
```

---

## Lambda Adapter

### withRateLimit Decorator

```typescript
// packages/lambda/src/decorator.ts
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'

export function withRateLimit(
  handler: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>,
  config: RateLimiterConfig
) {
  const limiter = RateLimiter.fromExtension()  // talks to local Extension process
  
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const ctx = extractContext(event, config)
    const result = await limiter.check(ctx)
    
    const rateLimitHeaders = buildHeaders(result)
    
    if (!result.allowed) {
      return {
        statusCode: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil((result.retryAfter ?? 0) / 1000)),
          ...rateLimitHeaders,
        },
        body: JSON.stringify({
          error: 'Too Many Requests',
          message: `Rate limit exceeded on ${result.dimension}`,
          retryAfter: result.retryAfter,
        }),
      }
    }
    
    const response = await handler(event)
    
    return {
      ...response,
      headers: { ...response.headers, ...rateLimitHeaders },
    }
  }
}

function extractContext(event: APIGatewayProxyEventV2, config: RateLimiterConfig): RateLimitContext {
  const ip = extractIP(event.headers, config.ipExtraction)
  const userId = extractUserId(event, config.userExtraction)
  const route = normalizeRoute(
    event.requestContext.http.method,
    event.requestContext.http.path
  )
  return { ip, userId, route }
}
```

### Usage in Lambda Handler

```typescript
// your-lambda/handler.ts
import { withRateLimit } from '@your-org/rate-limiter-lambda'
import { config } from './rate-limit-config'

const myHandler = async (event) => {
  // Your business logic — rate limit already checked
  return { statusCode: 200, body: JSON.stringify({ ok: true }) }
}

export const handler = withRateLimit(myHandler, config)
```

### Lambda Extension Entry Point

```typescript
// packages/lambda/extension/index.ts
import { registerExtension, processEvents } from './lambda-api'
import { RateLimiter } from '@your-org/rate-limiter-core'
import { startLocalServer } from './local-server'

async function main() {
  const extensionId = await registerExtension()
  const limiter = new RateLimiter(loadConfig())
  
  // Expose local HTTP server for the decorator to call
  const server = await startLocalServer(limiter, { port: 2772 })
  
  // Process Lambda lifecycle events
  await processEvents(extensionId, {
    onInvoke: () => { /* no-op — limiter is stateless per-invocation */ },
    onShutdown: async () => {
      await limiter.shutdown()  // Flush reservoir tokens
      server.close()
    }
  })
}

main().catch(console.error)
```

---

## EC2 / ECS Middleware Adapter

### Express Middleware

```typescript
// packages/middleware/src/express.ts
import { Request, Response, NextFunction } from 'express'

export function createRateLimitMiddleware(config: RateLimiterConfig) {
  const limiter = new RateLimiter(config)
  
  return async (req: Request, res: Response, next: NextFunction) => {
    const ctx: RateLimitContext = {
      ip:     extractIP(req),
      userId: extractUserId(req),
      route:  normalizeRoute(req.method, req.path),
      cost:   getRouteCost(req.method, req.path, config.rules),
    }
    
    const result = await limiter.check(ctx)
    
    // Always set headers (even on deny)
    res.set('X-RateLimit-Limit',     String(result.limit))
    res.set('X-RateLimit-Remaining', String(Math.max(0, result.remaining)))
    res.set('X-RateLimit-Reset',     String(Math.ceil(result.resetAt / 1000)))
    res.set('X-RateLimit-Policy',    `${result.limit};w=${result.window}`)
    
    if (!result.allowed) {
      res.set('Retry-After', String(Math.ceil((result.retryAfter ?? 0) / 1000)))
      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded: ${result.dimension}`,
        retryAfter: result.retryAfter,
      })
    }
    
    next()
  }
}
```

### FastAPI Middleware (Python)

```python
# packages/middleware/src/fastapi_middleware.py
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
import asyncio

class RateLimiterMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, config: dict):
        super().__init__(app)
        self.limiter = RateLimiter(config)
    
    async def dispatch(self, request: Request, call_next):
        ctx = RateLimitContext(
            ip=extract_ip(request),
            user_id=extract_user_id(request),
            route=normalize_route(request.method, request.url.path),
        )
        
        result = await self.limiter.check(ctx)
        
        headers = {
            "X-RateLimit-Limit":     str(result.limit),
            "X-RateLimit-Remaining": str(max(0, result.remaining)),
            "X-RateLimit-Reset":     str(result.reset_at // 1000),
        }
        
        if not result.allowed:
            return JSONResponse(
                status_code=429,
                content={"error": "Too Many Requests", "retryAfter": result.retry_after},
                headers={**headers, "Retry-After": str(result.retry_after // 1000)},
            )
        
        response = await call_next(request)
        for k, v in headers.items():
            response.headers[k] = v
        return response
```

---

## Local Reservoir

The reservoir trades perfect accuracy for dramatically lower Redis traffic. Each process (Lambda container, EC2 instance) holds a small token pool per rate limit key.

```typescript
// packages/core/src/reservoir.ts

interface ReservoirBucket {
  tokens: number
  lastSync: number        // timestamp of last Redis sync
  syncInProgress: boolean
}

export class LocalReservoir {
  private buckets = new Map<string, ReservoirBucket>()
  private batchSize: number  // tokens to pre-fetch per Redis call (default: 100)
  private syncInterval: number  // max ms between forced syncs (default: 5000)
  
  async consume(key: string, cost: number, redisCheck: () => Promise<number>): Promise<boolean> {
    const bucket = this.buckets.get(key) ?? { tokens: 0, lastSync: 0, syncInProgress: false }
    
    // Serve from local reservoir if possible
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost
      this.buckets.set(key, bucket)
      return true  // No Redis call needed
    }
    
    // Reservoir empty — fetch from Redis
    if (!bucket.syncInProgress) {
      bucket.syncInProgress = true
      const granted = await redisCheck()  // Returns tokens granted by Redis
      bucket.tokens = Math.max(0, granted - cost)  // Keep remainder in reservoir
      bucket.lastSync = Date.now()
      bucket.syncInProgress = false
      this.buckets.set(key, bucket)
      return granted > 0
    }
    
    // Sync in progress (concurrent request) — fall through to Redis directly
    return (await redisCheck()) > 0
  }
  
  // Called on Lambda Extension shutdown or EC2 SIGTERM
  async flush(redis: RedisClient): Promise<void> {
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.tokens > 0) {
        // Return unused pre-fetched tokens to Redis (DECRBY)
        await redis.decrby(key, bucket.tokens).catch(() => {})
      }
    }
    this.buckets.clear()
  }
}
```

### Reservoir Tradeoffs

| Aspect | Without Reservoir | With Reservoir (batch=100) |
|---|---|---|
| Redis calls | 1 per request | 1 per 100 requests |
| Redis traffic | 1M ops/s | ~10K ops/s |
| Accuracy | Exact | May over-allow by up to `batchSize` per instance |
| Crash behavior | No data loss | Up to `batchSize` tokens lost per crash |

The "over-allow" risk: if you have 50 Lambda instances each with a reservoir of 100 tokens, and the true limit is 100 req/min, a burst could allow up to 5,000 requests before Redis is consulted. Size `batchSize` relative to your limit:

```typescript
// Rule of thumb: batchSize = limit / (expected_concurrent_instances * 10)
// For limit=1000, instances=10: batchSize = 1000 / (10*10) = 10
reservoir: {
  batchSize: 10,
  syncInterval: 1000,  // Force Redis sync at least every 1s regardless
}
```
