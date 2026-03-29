# aws-rate-limiter

Production-grade, multi-dimensional sliding-window rate limiter for Node.js — built for AWS Lambda, EC2, and ECS. Backed by Redis/ElastiCache with atomic Lua scripts, an in-process token reservoir, circuit breaker, and first-class adapters for Express, Fastify, and Lambda.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [Programmatic](#programmatic-config)
  - [YAML File](#yaml-file-config)
  - [Environment Variables](#environment-variable-config)
- [Framework Adapters](#framework-adapters)
  - [Express](#express)
  - [Fastify](#fastify)
  - [AWS Lambda](#aws-lambda)
  - [Koa](#koa)
  - [NestJS](#nestjs)
  - [Hapi](#hapi)
  - [Plain Node.js HTTP](#plain-nodejs-http)
- [Rate Limit Rules](#rate-limit-rules)
  - [Per-Route Limits](#per-route-limits)
  - [Per-Tier Limits](#per-tier-limits)
  - [Rule Matching](#rule-matching)
- [Dimensions](#dimensions)
- [Failure Policies](#failure-policies)
- [Reservoir (Performance)](#reservoir-performance)
- [Response Headers](#response-headers)
- [API Reference](#api-reference)
- [Error Handling](#error-handling)
- [Infrastructure](#infrastructure)
- [Examples](#examples)

---

## How It Works

Every incoming request is checked against up to **four dimensions in order** — the first one to exceed its limit denies the request immediately (fail-fast):

```
Request → [1] Per-IP → [2] Per-route → [3] Per-user → [4] Per-user+route → Allowed
```

Each dimension uses a **sliding window counter** stored in Redis via atomic Lua scripts (`EVALSHA`). An optional **in-process token reservoir** pre-fetches tokens in batches, reducing Redis round-trips by up to 100×. A **circuit breaker** isolates your app from Redis failures, falling back to configurable policies (`open` / `closed` / `local`).

```
Your App
  │
  ├── Express / Fastify middleware ──┐
  │                                  ▼
  ├── Lambda Extension + decorator  Rate Limiter Core
  │                                  │
  └── Direct RateLimiter API ────────┤
                                     │   ┌──────────────────┐
                                     ├──▶│ Local Reservoir   │ (in-process, ~0ms)
                                     │   └──────────────────┘
                                     │   ┌──────────────────┐
                                     └──▶│ Redis EVALSHA     │ (~0.5ms same-AZ)
                                         └──────────────────┘
```

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | ≥ 18.x | Required |
| Redis | ≥ 6.x | Single node or cluster |
| TypeScript | ≥ 5.x | Optional, types included |

**Redis options:**
- **Local development** — Docker: `docker run -d -p 6379:6379 redis:7-alpine`
- **AWS production** — ElastiCache for Redis (single node or cluster mode)
- **Cluster mode** — Supported natively; pass `redis.cluster` instead of `redis.url`

---

## Installation

```bash
npm install aws-rate-limiter
```

No peer dependencies required. Express, Fastify, Koa, etc. are optional — only install what your project already uses.

---

## Quick Start

```typescript
import { RateLimiter } from 'aws-rate-limiter';

const limiter = new RateLimiter({
  redis: { url: 'redis://localhost:6379' },
  rules: [
    {
      name: 'default',
      limits: {
        ip:   { limit: 100, window: 60 },  // 100 requests / IP / minute
        user: { limit: 200, window: 60 },  // 200 requests / user / minute
      },
    },
  ],
});

await limiter.connect();

const result = await limiter.check({
  ip:     '1.2.3.4',
  userId: 'user-123',
  route:  '/api/users',
  method: 'GET',
});

if (!result.allowed) {
  // 429 Too Many Requests
  console.log(`Retry after ${result.retryAfter}ms`);
}

await limiter.shutdown();
```

---

## Configuration

### Programmatic Config

Pass a `RateLimiterConfig` object directly to the constructor:

```typescript
import { RateLimiter, RateLimiterConfig } from 'aws-rate-limiter';

const config: RateLimiterConfig = {
  // ── Redis connection (required) ───────────────────────────────────────
  redis: {
    url: 'redis://localhost:6379',   // Single node
    // or for cluster:
    // cluster: { nodes: [{ host: 'node1', port: 6379 }, { host: 'node2', port: 6379 }] }
    password: process.env.REDIS_AUTH,
    connectTimeout: 500,             // ms — default: 200
    commandTimeout: 200,             // ms — default: 100
    maxRetriesPerRequest: 2,         // default: 1
  },

  // ── Rules (required, at least one) ────────────────────────────────────
  rules: [
    {
      name: 'default',
      limits: {
        ip:        { limit: 100,  window: 60 },
        route:     { limit: 1000, window: 60 },
        user:      { limit: 200,  window: 60 },
        userRoute: { limit: 50,   window: 60 },
      },
    },
  ],

  // ── Reservoir (optional — improves performance) ────────────────────────
  reservoir: {
    enabled:      true,
    batchSize:    10,    // tokens to pre-fetch per batch
    syncInterval: 1000,  // ms between background syncs
  },

  // ── Failure policy (optional) ──────────────────────────────────────────
  failure: {
    default: 'open',   // 'open' | 'closed' | 'local'
    circuitBreaker: {
      enabled:         true,
      threshold:       5,      // consecutive failures before opening
      recoveryTimeout: 30000,  // ms before attempting recovery
    },
  },

  // ── Observability (optional) ───────────────────────────────────────────
  observability: {
    logLevel:      'info',   // 'debug' | 'info' | 'warn' | 'error'
    logSampleRate: 0.1,      // fraction of allowed requests to log
    metrics:       'none',   // 'none' | 'memory' | 'cloudwatch'
    namespace:     'MyApp',  // CloudWatch/Prometheus namespace
  },
};

const limiter = new RateLimiter(config);
```

### YAML File Config

Create a `rate-limiter.yaml` file (supports `${ENV_VAR}` substitution):

```yaml
redis:
  url: ${REDIS_URL}
  password: ${REDIS_AUTH}
  connectTimeout: 500
  commandTimeout: 200

rules:
  - name: auth-endpoints
    match:
      routes:
        - "POST /auth/*"
        - "POST /login"
    limits:
      ip:
        limit: 10
        window: 60
    failure: closed

  - name: default
    limits:
      ip:
        limit: 100
        window: 60
      user:
        limit: 200
        window: 60

failure:
  default: open
  circuitBreaker:
    enabled: true
    threshold: 5
    recoveryTimeout: 30000
```

Load it in your application:

```typescript
import { loadConfig } from 'aws-rate-limiter/config';

const config = loadConfig('./rate-limiter.yaml');
const limiter = new RateLimiter(config);
```

`loadConfig(path?)` resolution order:
1. Explicit `path` argument
2. `RATE_LIMITER_CONFIG` environment variable
3. Falls back to `loadConfigFromEnv()` if no file is found

### Environment Variable Config

For simple deployments without a YAML file:

| Variable | Config Field | Default |
|----------|-------------|---------|
| `RATE_LIMITER_REDIS_URL` | `redis.url` | `redis://localhost:6379` |
| `RATE_LIMITER_REDIS_AUTH` | `redis.password` | — |
| `RATE_LIMITER_DEFAULT_LIMIT` | default rule `ip.limit` | `60` |
| `RATE_LIMITER_DEFAULT_WINDOW` | default rule `ip.window` (seconds) | `60` |
| `RATE_LIMITER_FAILURE_POLICY` | `failure.default` | `open` |
| `RATE_LIMITER_RESERVOIR_ENABLED` | `reservoir.enabled` | `false` |
| `RATE_LIMITER_RESERVOIR_BATCH_SIZE` | `reservoir.batchSize` | `10` |
| `RATE_LIMITER_RESERVOIR_SYNC_INTERVAL` | `reservoir.syncInterval` (ms) | `1000` |
| `RATE_LIMITER_CIRCUIT_BREAKER_ENABLED` | circuit breaker on/off | `false` |
| `RATE_LIMITER_LOG_LEVEL` | `observability.logLevel` | `info` |
| `RATE_LIMITER_LOG_SAMPLE_RATE` | `observability.logSampleRate` | `1` |
| `RATE_LIMITER_METRICS_BACKEND` | `observability.metrics` | `none` |
| `RATE_LIMITER_METRICS_NAMESPACE` | `observability.namespace` | — |

```bash
RATE_LIMITER_REDIS_URL=redis://my-elasticache:6379 \
RATE_LIMITER_DEFAULT_LIMIT=100 \
RATE_LIMITER_DEFAULT_WINDOW=60 \
node dist/server.js
```

Then load it:

```typescript
import { loadConfigFromEnv } from 'aws-rate-limiter/config';

const limiter = new RateLimiter(loadConfigFromEnv());
```

---

## Framework Adapters

### Express

Built-in adapter — no additional dependencies:

```typescript
import express from 'express';
import { RateLimiter } from 'aws-rate-limiter';
import { createExpressMiddleware } from 'aws-rate-limiter/adapters/express';

const limiter = new RateLimiter({ /* config */ });
await limiter.connect();

const app = express();
app.set('trust proxy', 1);

app.use(
  createExpressMiddleware({
    rateLimiter: limiter,

    // Routes to skip entirely (minimatch globs)
    skipRoutes: ['/health', '/metrics', '/internal/*'],

    // Whether to attach X-RateLimit-* headers on allowed responses (default: true)
    setHeaders: true,

    // How to extract the real client IP
    ipExtraction: {
      trustXForwardedFor: true,
      trustedProxyCount: 1,
    },

    // Return the user's tier for rule matching (e.g. 'free', 'premium', 'enterprise')
    // Without this, rules with match.userTiers will never match.
    getUserTier: (req) => {
      // Option A: header injected by API gateway / auth proxy
      const tier = req.headers['x-user-tier'];
      if (tier) return tier as string;

      // Option B: from decoded JWT attached by earlier auth middleware
      return (req as any).user?.tier;
    },
  }),
);
```

User identity is extracted automatically from:
- `Authorization: Bearer <token>` header → treated as `apiKey`
- `X-API-Key` header → treated as `apiKey`

To use `userId` instead, pass `userExtraction.apiKeyHeader` or populate `req.user` and provide a custom `getUserTier`.

### Fastify

Built-in adapter — registers as a `preHandler` hook:

```typescript
import Fastify from 'fastify';
import { RateLimiter } from 'aws-rate-limiter';
import { createFastifyHook } from 'aws-rate-limiter/adapters/fastify';

const limiter = new RateLimiter({ /* config */ });
await limiter.connect();

const fastify = Fastify({ trustProxy: true });

fastify.addHook(
  'preHandler',
  createFastifyHook({
    rateLimiter: limiter,
    skipRoutes: ['/health', '/metrics'],
    ipExtraction: { trustXForwardedFor: true, trustedProxyCount: 1 },
    getUserTier: (req) => req.headers['x-user-tier'] as string | undefined,
  }),
);
```

Rate limit headers (`X-RateLimit-*`) are always set — even on denied requests — so clients can adapt.

### AWS Lambda

Lambda uses a **two-component pattern** to keep a persistent Redis connection alive across invocations:

**1. Extension (Lambda Layer) — `extension.ts`**

```typescript
import { LambdaExtension } from 'aws-rate-limiter/adapters/lambda';

const extension = new LambdaExtension({
  rateLimiterConfig: {
    redis: { url: process.env.REDIS_URL! },
    rules: [
      {
        name: 'default',
        limits: { ip: { limit: 100, window: 60 }, user: { limit: 200, window: 60 } },
      },
    ],
  },
  port: 2772, // default — must match extensionUrl in decorator
});

// Blocks until Lambda sends SHUTDOWN event
await extension.run();
```

**2. Handler Decorator — `handler.ts`**

```typescript
import { withRateLimit } from 'aws-rate-limiter/adapters/lambda';

export const handler = withRateLimit(
  async (event, context) => {
    return { statusCode: 200, body: JSON.stringify({ message: 'Hello' }) };
  },
  {
    extensionUrl:      'http://localhost:2772', // default
    userIdHeader:      'x-user-id',
    apiKeyHeader:      'x-api-key',
    trustedProxyCount: 1,
    // Cloudfront or other custom IP headers
    ipHeaders: ['cf-connecting-ip', 'true-client-ip'],
  },
);
```

**Why Lambda needs an Extension:**
Without it, each Lambda invocation opens a new Redis connection (+200ms TLS handshake). The Extension keeps one persistent connection per container — warm invocations have zero connection overhead.

**Fail-open by design:** If the Extension is unreachable (e.g., still starting up), `withRateLimit` allows the request through rather than dropping traffic.

### Koa

No built-in adapter — use the core `RateLimiter` API directly as middleware:

```typescript
import Koa from 'koa';
import { RateLimiter } from 'aws-rate-limiter';

const limiter = new RateLimiter({ /* config */ });
await limiter.connect();

const app = new Koa();
app.proxy = true;

app.use(async (ctx, next) => {
  if (ctx.path === '/health') return next();

  const result = await limiter.check({
    ip:       ctx.ip,
    apiKey:   ctx.get('x-api-key') || undefined,
    route:    ctx.path,
    method:   ctx.method,
    userTier: ctx.get('x-user-tier') || undefined,
  });

  const windowSecs = result.windowSecs ?? 60;
  ctx.set('X-RateLimit-Limit',     String(result.limit));
  ctx.set('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
  ctx.set('X-RateLimit-Reset',     String(Math.ceil(result.resetAt / 1000)));
  ctx.set('X-RateLimit-Policy',    `${result.limit};w=${windowSecs}`);

  if (!result.allowed) {
    if (result.retryAfter !== undefined) {
      ctx.set('Retry-After', String(Math.ceil(result.retryAfter / 1000)));
    }
    ctx.status = 429;
    ctx.body = { error: 'Too Many Requests', retryAfter: result.retryAfter };
    return;
  }

  await next();
});
```

### NestJS

Two patterns — choose based on your needs:

**Pattern 1: Global middleware** (simplest — wraps the Express adapter):

```typescript
import { Injectable, NestMiddleware, Module } from '@nestjs/common';
import { createExpressMiddleware } from 'aws-rate-limiter/adapters/express';
import type { Request, Response, NextFunction } from 'express';

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly middleware = createExpressMiddleware({
    rateLimiter: globalLimiterInstance,
    skipRoutes: ['/health'],
  });

  async use(req: Request, res: Response, next: NextFunction) {
    await this.middleware(req as any, res as any, next);
  }
}

@Module({})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RateLimitMiddleware).forRoutes('*');
  }
}
```

**Pattern 2: Guard** (per-controller or per-route with `@UseGuards`):

```typescript
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { RateLimiter } from 'aws-rate-limiter';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req  = context.switchToHttp().getRequest();
    const res  = context.switchToHttp().getResponse();
    const result = await this.limiter.check({
      ip:     req.ip,
      apiKey: req.headers['x-api-key'],
      route:  req.path,
      method: req.method,
    });

    res.set('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));

    if (!result.allowed) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
```

Register `RateLimiter` as a provider with `onModuleInit` / `onModuleDestroy` for proper lifecycle management. See [`examples/nestjs.ts`](./examples/nestjs.ts) for the full wiring.

### Hapi

Use the `onPreHandler` lifecycle extension:

```typescript
import Hapi from '@hapi/hapi';
import { RateLimiter } from 'aws-rate-limiter';

const limiter = new RateLimiter({ /* config */ });
await limiter.connect();

const server = Hapi.server({ port: 3000 });

server.ext('onPreHandler', async (request, h) => {
  if (request.path === '/health') return h.continue;

  const ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || request.info.remoteAddress;

  const result = await limiter.check({
    ip:     ip || '0.0.0.0',
    apiKey: request.headers['x-api-key'],
    route:  request.path,
    method: request.method.toUpperCase(),
  });

  if (!result.allowed) {
    return h.response({ error: 'Too Many Requests' }).code(429).takeover();
  }

  return h.continue;
});
```

### Plain Node.js HTTP

```typescript
import * as http from 'http';
import { RateLimiter } from 'aws-rate-limiter';

const limiter = new RateLimiter({ /* config */ });
await limiter.connect();

const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || '0.0.0.0';

  const result = await limiter.check({
    ip,
    apiKey: req.headers['x-api-key'] as string | undefined,
    route:  new URL(req.url!, 'http://localhost').pathname,
    method: req.method || 'GET',
  });

  res.setHeader('X-RateLimit-Limit',     String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
  res.setHeader('X-RateLimit-Reset',     String(Math.ceil(result.resetAt / 1000)));

  if (!result.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too Many Requests' }));
    return;
  }

  // ... your handler
});
```

---

## Rate Limit Rules

### Per-Route Limits

Rules are matched **top-to-bottom — first match wins**. Route patterns are matched against `"METHOD /path"` using [minimatch](https://github.com/isaacs/minimatch) globs.

```typescript
const limiter = new RateLimiter({
  redis: { url: 'redis://localhost:6379' },
  rules: [
    // Most specific rules first
    {
      name: 'auth',
      match: { routes: ['POST /auth/*', 'POST /login', 'POST /register'] },
      limits: { ip: { limit: 10, window: 60 } },
      failure: 'closed',   // deny all if Redis is down
    },
    {
      name: 'uploads',
      match: { routes: ['POST /api/uploads', 'PUT /api/files/*'] },
      limits: {
        ip:   { limit: 20, window: 300 },  // 20 uploads per 5 min
        user: { limit: 50, window: 300 },
      },
    },
    {
      name: 'search',
      match: { routes: ['GET /api/search', 'GET /api/search/*'] },
      limits: { ip: { limit: 30, window: 60 }, user: { limit: 60, window: 60 } },
    },
    {
      name: 'read-apis',
      match: { routes: ['GET /api/**'] },       // all GET routes under /api/
      limits: { ip: { limit: 200, window: 60 }, user: { limit: 300, window: 60 } },
    },
    {
      name: 'write-apis',
      match: { routes: ['POST /api/**', 'PUT /api/**', 'PATCH /api/**', 'DELETE /api/**'] },
      limits: {
        ip:        { limit: 50, window: 60 },
        user:      { limit: 100, window: 60 },
        userRoute: { limit: 20, window: 60 },
      },
    },
    // Catch-all must be last — no match criteria
    {
      name: 'default',
      limits: { ip: { limit: 100, window: 60 }, user: { limit: 200, window: 60 } },
    },
  ],
});
```

**Glob pattern reference:**

| Pattern | Matches |
|---------|---------|
| `"GET /api/users"` | Exact route only |
| `"GET /api/users/*"` | One level deep: `/api/users/123` |
| `"GET /api/**"` | Any depth: `/api/users/123/posts` |
| `"POST /api/**"` | All POST routes under `/api/` |
| `"* /api/search"` | Any HTTP method to `/api/search` |

### Per-Tier Limits

Use `match.userTiers` to apply different limits based on the authenticated user's subscription tier. **Your adapter must supply the `userTier`** via the `getUserTier` callback (Express/Fastify) or by setting `ctx.userTier` directly (core API). If `userTier` is `undefined`, tier rules are skipped.

```typescript
rules: [
  {
    name: 'enterprise',
    match: { userTiers: ['enterprise'] },
    limits: { user: { limit: 10000, window: 60 }, userRoute: { limit: 1000, window: 60 } },
  },
  {
    name: 'premium',
    match: { userTiers: ['premium'] },
    limits: { user: { limit: 1000, window: 60 }, userRoute: { limit: 100, window: 60 } },
  },
  {
    name: 'default',
    limits: { ip: { limit: 100, window: 60 }, user: { limit: 200, window: 60 } },
  },
],
```

Supply the tier in your adapter:

```typescript
// Express
createExpressMiddleware({
  rateLimiter: limiter,
  getUserTier: (req) => (req as any).user?.subscription ?? req.headers['x-user-tier'] as string,
});

// Core API
await limiter.check({
  ip:       '1.2.3.4',
  userId:   'user-123',
  route:    '/api/data',
  method:   'GET',
  userTier: 'premium',   // <-- set this from your auth layer
});
```

### Rule Matching

Match conditions use **AND semantics** — all specified conditions must pass for a rule to match:

```typescript
{
  name: 'premium-writes',
  match: {
    routes:    ['POST /api/**', 'PUT /api/**'],  // must be a write route
    userTiers: ['premium', 'enterprise'],        // AND must be premium/enterprise
  },
  limits: { user: { limit: 500, window: 60 }, userRoute: { limit: 50, window: 60 } },
}
```

A rule with **no `match` field** acts as a catch-all and matches every request.

---

## Dimensions

Each rule defines limits per dimension. Only configured dimensions are checked; omitted ones are skipped.

| Dimension | Config Key | Redis Key Pattern | When Active |
|-----------|-----------|-------------------|-------------|
| Per-IP | `limits.ip` | `rl:v1:ip:{ip}:{bucket}` | Always |
| Per-route | `limits.route` | `rl:v1:route:{method_path}:{bucket}` | Always |
| Per-user | `limits.user` | `rl:v1:user:{hash}:{bucket}` | When `userId` or `apiKey` is present |
| Per-user+route | `limits.userRoute` | `rl:v1:user-route:{hash}:{route}:{bucket}` | When `userId` or `apiKey` is present |

User identifiers (`userId`, `apiKey`) are **SHA-256 hashed** before being stored in Redis keys — they are never stored in plain text.

The `window` value is in **seconds**. A window of `60` means a 60-second sliding window (not a fixed 1-minute bucket).

---

## Failure Policies

Configure what happens when Redis is unavailable. Can be set **globally** and **overridden per rule**:

| Policy | Behaviour | Use For |
|--------|-----------|---------|
| `open` (default) | Allow all traffic — rate limiting is temporarily disabled | Public content, read-heavy APIs |
| `closed` | Deny all traffic with 429 | Auth endpoints, payment routes |
| `local` | In-process fixed-window fallback — rate limiting still works, but per-instance not globally | Medium-criticality APIs |

```typescript
// Global default + per-rule overrides
{
  failure: { default: 'open' },
  rules: [
    { name: 'auth',     match: { routes: ['POST /auth/*'] }, limits: {...}, failure: 'closed' },
    { name: 'payments', match: { routes: ['POST /pay/*']  }, limits: {...}, failure: 'closed' },
    { name: 'search',   match: { routes: ['GET /search']  }, limits: {...}, failure: 'local'  },
    { name: 'default',  limits: {...} },  // inherits 'open' from global default
  ],
}
```

**Circuit breaker** — prevents hammering a struggling Redis:

```typescript
failure: {
  default: 'open',
  circuitBreaker: {
    enabled:         true,
    threshold:       5,      // open after 5 consecutive failures
    recoveryTimeout: 30000,  // try again after 30 seconds
  },
}
```

States: `closed` (normal) → `open` (failing, apply policy) → `half-open` (testing recovery) → `closed`.

---

## Reservoir (Performance)

The local token reservoir pre-fetches tokens from Redis in batches, serving most requests from memory without a Redis round-trip:

```
Without reservoir: every request → Redis (~0.5ms each)
With reservoir:    ~99% of requests → in-memory (~0.01ms), ~1% → Redis refill
```

```typescript
reservoir: {
  enabled:      true,
  batchSize:    10,    // tokens to claim per Redis call
  syncInterval: 1000,  // background sync interval (ms)
}
```

**Sizing trade-off:** larger `batchSize` → fewer Redis calls but allows short bursts above the limit. Rule of thumb: `batchSize ≤ limit / (expectedInstances × 10)`.

On `shutdown()`, unused tokens are returned to Redis. If shutdown is abrupt, tokens expire via Redis TTL (2× window length).

---

## Response Headers

On every rate-limited response (both allowed and denied):

| Header | Value | Example |
|--------|-------|---------|
| `X-RateLimit-Limit` | Configured limit for the matched dimension | `100` |
| `X-RateLimit-Remaining` | Remaining requests in current window | `42` |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when window resets | `1706000060` |
| `X-RateLimit-Policy` | Limit and window in RFC-8941 format | `100;w=60` |
| `Retry-After` | Seconds to wait before retrying (429 only) | `15` |

---

## API Reference

### `new RateLimiter(config)`

```typescript
const limiter = new RateLimiter(config: RateLimiterConfig);
```

Throws `ConfigurationError` if `rules` is empty or config is invalid.

### `limiter.connect()`

```typescript
await limiter.connect(): Promise<void>
```

Connects to Redis and loads Lua scripts. Must be called before any other method. Throws `RedisConnectionError` on failure.

### `limiter.check(ctx)`

```typescript
await limiter.check(ctx: RateLimitContext): Promise<RateLimitResult>
```

Evaluates all active dimensions and returns the result. Consumes quota — use `status()` for read-only queries.

```typescript
// RateLimitContext
{
  ip:       string;           // required — raw client IP (IPv4 or IPv6)
  route:    string;           // required — request path e.g. "/api/users"
  method:   string;           // required — HTTP method e.g. "GET"
  userId?:  string;           // optional — authenticated user ID
  apiKey?:  string;           // optional — API key (used if no userId)
  userTier?: string;          // optional — subscription tier for rule matching
  cost?:    number;           // optional — request cost weight (default: 1)
}

// RateLimitResult
{
  allowed:     boolean;       // true = proceed, false = 429
  dimension:   string;        // which dimension denied ("ip" | "route" | "user" | "user-route" | "none")
  limit:       number;        // configured limit for triggering dimension
  remaining:   number;        // remaining quota (clamped to 0)
  resetAt:     number;        // Unix epoch ms when window resets
  windowSecs?: number;        // window duration in seconds
  retryAfter?: number;        // ms to wait before retry (only on deny)
  effective:   number;        // sliding-window effective request count
  source:      'redis' | 'reservoir' | 'local_fallback';
}
```

### `limiter.status(ctx)`

```typescript
await limiter.status(ctx: RateLimitContext): Promise<RateLimitResult>
```

Read-only quota check — **does not consume quota**. Returns the most-constrained dimension. Useful for dashboards and pre-flight checks.

### `limiter.reset(dimension, identifier)`

```typescript
await limiter.reset(
  dimension:  'ip' | 'user' | 'route' | 'user-route',
  identifier: string,
): Promise<number>  // number of Redis keys deleted
```

Deletes rate limit counters for a specific dimension and identifier. Use for admin operations (e.g., unblock a user after a support ticket).

```typescript
// Reset by IP
await limiter.reset('ip', '1.2.3.4');

// Reset a user (pass raw userId — it will be hashed internally)
await limiter.reset('user', 'user-abc-123');

// Reset a specific user+route combination
await limiter.reset('user-route', 'user-abc-123:GET /api/search');
```

### `limiter.isConnected()`

```typescript
limiter.isConnected(): boolean
```

### `limiter.shutdown()`

```typescript
await limiter.shutdown(): Promise<void>
```

Flushes the reservoir and disconnects from Redis. Always call on `SIGTERM`/`SIGINT`.

---

## Error Handling

```typescript
import {
  RateLimiterError,
  RedisConnectionError,
  ConfigurationError,
} from 'aws-rate-limiter';

try {
  await limiter.connect();
} catch (err) {
  if (err instanceof RedisConnectionError) {
    console.error('Cannot reach Redis:', err.message, err.code);
  } else if (err instanceof ConfigurationError) {
    console.error('Bad config:', err.message, err.code);
  }
}

// check() does not throw on Redis failure — it applies the failure policy.
// It only throws ConfigurationError if connect() was not called first.
const result = await limiter.check(ctx);
// result.source === 'local_fallback' if Redis was unavailable
```

| Error Class | `code` | When Thrown |
|-------------|--------|-------------|
| `ConfigurationError` | `CONFIGURATION_ERROR` | Invalid config, or `check()` called before `connect()` |
| `RedisConnectionError` | `REDIS_CONNECTION_ERROR` | Connection failure during `connect()` |

---

## Infrastructure

### Local Development

```bash
# Start Redis
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Verify
redis-cli ping   # → PONG
```

### AWS ElastiCache (Production)

**Single node** (dev/staging):
```typescript
redis: { url: 'rediss://my-cluster.xxxxx.ng.0001.use1.cache.amazonaws.com:6379' }
// rediss:// enables TLS — always use in production
```

**Cluster mode** (production):
```typescript
redis: {
  cluster: {
    nodes: [
      { host: 'my-cluster.xxxxx.clustercfg.use1.cache.amazonaws.com', port: 6379 },
    ],
  },
  password: process.env.REDIS_AUTH_TOKEN,
}
```

**Recommended node types:**

| Environment | Node Type | Notes |
|-------------|-----------|-------|
| Dev / Staging | `cache.t3.medium` | ~20K ops/s |
| Small production | `cache.r7g.large` | ~100K ops/s |
| High traffic | `cache.r7g.xlarge` | ~200K ops/s |
| 1M req/s | 6× `cache.r7g.large` cluster | ~600K ops/s with reservoir |

**Security checklist:**
- Always use TLS (`rediss://`)
- Set an AUTH token on the ElastiCache cluster
- Restrict security groups to port `6379` from your application subnets only
- Never place ElastiCache in a public subnet

### Lambda Deployment

```
Lambda Layer (Extension)
└── extensions/
    └── rate-limiter-extension  (compiled from extension.ts)

Lambda Function
└── handler.js                  (compiled from handler.ts, wrapped with withRateLimit)
```

The extension binary must be named to match what you register. Set `AWS_LAMBDA_RUNTIME_API` is injected automatically by the Lambda runtime.

---

## Examples

Full runnable examples for every supported framework are in the [`examples/`](./examples/) directory:

| File | Framework | Notes |
|------|-----------|-------|
| [`examples/express.ts`](./examples/express.ts) | Express | Built-in adapter |
| [`examples/fastify.ts`](./examples/fastify.ts) | Fastify | Built-in adapter |
| [`examples/aws-lambda.ts`](./examples/aws-lambda.ts) | AWS Lambda | Extension + decorator |
| [`examples/koa.ts`](./examples/koa.ts) | Koa 2.x | Core API |
| [`examples/nestjs.ts`](./examples/nestjs.ts) | NestJS 10.x | Middleware + Guard patterns |
| [`examples/hapi.ts`](./examples/hapi.ts) | Hapi 21.x | Core API |
| [`examples/node-http.ts`](./examples/node-http.ts) | Node.js `http` | Core API, no framework |
| [`examples/rate-limiter.yaml`](./examples/rate-limiter.yaml) | — | Full YAML config reference |

For deep dives into the internals, see the [`docs/`](./docs/README.md) directory:

| Document | Topic |
|----------|-------|
| [01-architecture.md](./docs/01-architecture.md) | System architecture and component map |
| [02-algorithm.md](./docs/02-algorithm.md) | Sliding window counter math |
| [03-redis-design.md](./docs/03-redis-design.md) | Key schema, TTL, cluster topology |
| [06-scale-and-performance.md](./docs/06-scale-and-performance.md) | 1M req/s strategy, reservoir, benchmarks |
| [08-failure-modes.md](./docs/08-failure-modes.md) | Failure taxonomy, circuit breaker, fallbacks |
| [11-configuration.md](./docs/11-configuration.md) | Full config schema reference |
