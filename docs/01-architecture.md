# 01 — System Architecture

## Overview

The rate limiter is built as a **core SDK with two thin platform adapters**. The algorithm and Redis logic live in one place; only the attachment mechanism differs between Lambda and EC2/ECS.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Your Application                         │
│                                                                 │
│   Lambda Handler  ──┐          EC2 / ECS Service ──┐           │
│   (decorated)       │          (middleware mounted)  │           │
└─────────────────────┼──────────────────────────────┼───────────┘
                      │                              │
              ┌───────▼──────────────────────────────▼───────┐
              │            Rate Limiter Core SDK              │
              │                                               │
              │  ┌──────────────┐   ┌─────────────────────┐  │
              │  │ Key Builder  │   │  Local Reservoir     │  │
              │  │ (dimensions) │   │  (in-process cache)  │  │
              │  └──────┬───────┘   └──────────┬──────────┘  │
              │         │                       │             │
              │  ┌──────▼───────────────────────▼──────────┐ │
              │  │         Redis Client (EVALSHA)           │ │
              │  └──────────────────────────────────────────┘ │
              └────────────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │        ElastiCache Redis Cluster      │
                    │   (6-8 nodes, consistent hash shard) │
                    └──────────────────────────────────────┘
```

---

## Component Map

### 1. Core SDK (`packages/core`)

Language: **TypeScript** (compiled to JS, with type definitions). Python wrapper for FastAPI services.

Responsibilities:
- Sliding window counter algorithm implementation
- Key construction for all dimensions
- Lua script loading and EVALSHA invocation
- Local reservoir management (token pre-fetch)
- Failure policy enforcement (fail-open / fail-closed / fail-local)
- Response header generation (`X-RateLimit-*`)

Does NOT own:
- HTTP transport
- Redis connection lifecycle (delegated to adapter)
- Config loading (injected at construction)

### 2. Lambda Adapter (`packages/lambda`)

Two components that work together:

**Lambda Extension** (`extension/`)
- Runs as a sidecar process inside the Lambda execution environment
- Manages a persistent Redis connection across invocations (cold start only once per container)
- Exposes a local HTTP server on `localhost:2772` for the handler to call
- Registers with Lambda Extensions API to get `INVOKE` and `SHUTDOWN` events
- On `SHUTDOWN`: flushes any un-synced local reservoir tokens back to Redis

**Handler Decorator** (`decorator/`)
- Wraps your Lambda handler function: `withRateLimit(handler, config)`
- Intercepts the event before your handler runs
- Extracts IP, user ID, route from the event (API Gateway v1/v2 format supported)
- Calls the Extension's local HTTP server (unix socket — zero network latency)
- Injects `X-RateLimit-*` headers into the response
- Short-circuits with 429 if denied

```
Lambda Invocation
      │
      ▼
Lambda Extension (localhost:2772)
      │  ← checks local reservoir first
      │  ← only calls Redis if reservoir empty
      ▼
withRateLimit(handler) decorator
      │  ← 429 if denied, proceed if allowed
      ▼
Your Handler Code
```

### 3. Middleware Adapter (`packages/middleware`)

A standard HTTP middleware for Node.js (Express, Fastify, raw http) and Python (FastAPI, Flask, WSGI).

```typescript
// Express
app.use(rateLimiter.middleware(config))

// FastAPI
app.add_middleware(RateLimiterMiddleware, config=config)
```

The middleware:
- Extracts IP from `X-Forwarded-For` (configurable trust depth)
- Extracts user ID from JWT, API key header, or custom extractor function
- Calls Core SDK `check()` method
- Sets response headers on both allow and deny
- Calls `next()` on allow, sends 429 on deny

### 4. Sidecar Adapter (`packages/sidecar`)

A standalone Docker container that exposes a simple gRPC or HTTP/2 API. Your application calls the sidecar before processing a request. Language-agnostic — any ECS service can use it regardless of language.

```
Your ECS Task
├── app container    →  POST localhost:8080/check  →  sidecar container
└── sidecar container  →  Redis cluster
```

Sidecar API:

```
POST /check
Body: { "keys": ["user:abc", "ip:1.2.3.4", "route:POST/orders"], "cost": 1 }
Response 200: { "allowed": true, "remaining": 37, "reset_at": 1706000060 }
Response 429: { "allowed": false, "retry_after": 42 }
```

### 5. Redis Cluster

See [03-redis-design.md](./03-redis-design.md) for full detail.

- ElastiCache Serverless or self-managed cluster (6-8 nodes recommended)
- Consistent hash sharding — each key always routes to the same node
- No cross-node coordination needed (counters are not aggregated across nodes)
- Read replicas for non-mutating status queries

---

## Attachment Model Decision Tree

```
Is your service on Lambda?
├── YES → Use Lambda Extension + withRateLimit decorator
│         (best cold start behavior, shared Redis connection)
│
└── NO → Is it a single-language EC2/ECS service?
         ├── YES → Use middleware library (lowest latency, no extra process)
         └── NO → Is it polyglot / you don't control the app code?
                  └── YES → Use sidecar container (language-agnostic)
```

---

## Data Flow — Per Request (Happy Path)

```
1. Request arrives at Lambda / EC2 service

2. Adapter extracts:
   - IP address (from headers, trust X-Forwarded-For)
   - User ID / API key (from JWT claim, header, or custom extractor)
   - Route (method + path, normalized — strip IDs from paths)

3. Key Builder constructs Redis keys:
   - curr_bucket = floor(now_ms / window_ms)
   - prev_bucket = curr_bucket - 1
   - For each dimension: [curr_key, prev_key]

4. Local Reservoir check (in-process):
   - If local_tokens[dimension] > cost → decrement, allow (no Redis call)
   - If reservoir empty → go to step 5

5. Redis EVALSHA (Lua script):
   - Atomic: GET prev + GET curr + weighted check + INCRBY curr + PEXPIRE
   - Returns: {allowed, effective_count, limit, ttl_ms}

6. If reservoir was empty and Redis returned allowed:
   - Pre-fetch next N tokens into local reservoir
   - (N = configurable batch size, default 100)

7. Set response headers:
   - X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset

8. If denied:
   - Return 429 with Retry-After (reset_ms + jitter)
   - Do NOT call application handler

9. If allowed:
   - Call application handler
   - Handler sees rate limit headers already set
```

---

## Security Considerations

**IP extraction trust**

Never trust `X-Forwarded-For` blindly. Configure the number of trusted proxy hops:

```typescript
{
  ipExtraction: {
    trustXForwardedFor: true,
    trustedProxyCount: 1  // Only trust the last 1 proxy
  }
}
```

**API key extraction**

Keys should be hashed before use in Redis key names to avoid leaking them in monitoring/logs:

```typescript
redis_key = `rl:v1:user:${sha256(apiKey).slice(0,16)}:${bucket}`
```

**Redis authentication**

Always use ElastiCache with in-transit encryption (TLS) and auth tokens. Never expose Redis to public subnets.

**Rate limit bypass**

A user can't bypass the limit by rotating IPs if per-user limiting is also active. Use composite (user + route) limits as the primary enforcement layer; per-IP as a secondary abuse signal.
