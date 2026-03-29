# 12 — Claude Code Build Plan

This document is the step-by-step guide for building the rate limiter using Claude Code. Follow phases in order. Each phase ends with a working, testable milestone.

---

## Repository Initialization

```bash
# Run these commands to scaffold the project
mkdir rate-limiter && cd rate-limiter
git init
npm init -y
npm install -D typescript @types/node ts-node-dev rimraf
npx tsc --init

# Create monorepo structure
mkdir -p packages/{core,lambda,middleware,sidecar}/src
mkdir -p lua tests/{unit,integration,load} config infrastructure docs
```

Copy the documentation files into `docs/`.

---

## Phase 1 — Core Algorithm

**Goal:** Implement the sliding window counter algorithm as a pure TypeScript module with no Redis dependency. Fully testable with mocks.

### Files to Create

```
packages/core/src/
├── algorithm.ts      ← The weighted formula
├── key-builder.ts    ← Redis key construction + normalization
├── types.ts          ← All interfaces (RateLimitContext, RateLimitResult, etc.)
└── index.ts          ← Public exports
```

### Claude Code Prompt for This Phase

```
Create packages/core/src/algorithm.ts implementing the sliding window counter.

Requirements:
- Pure function: slidingWindowCheck(prevCount, currCount, elapsed, window, limit, cost) → { allowed, effective, remaining }
- All inputs are numbers. No side effects.
- elapsed = now_ms % window_ms
- weight = (window - elapsed) / window
- effective = prev * weight + curr
- allowed = effective + cost <= limit
- Export types in types.ts first, then implement

Write unit tests in tests/unit/algorithm.test.ts covering:
- Allows at exactly limit boundary
- Denies when 1 over limit
- Zero prev count (start of service)
- elapsed=0 (window just reset, full prev weight)
- elapsed=window (prev fully expired)
- Cost > 1 weighted correctly
- Floating point precision edge cases
```

### Claude Code Prompt for Key Builder

```
Create packages/core/src/key-builder.ts

Requirements:
- normalizeRoute(method, path) → string
  Strip UUIDs, numeric IDs, unix timestamps from path
  Replace with PARAM
  Result: "GET_api_users_PARAM"
- buildKeys(dimension, identifier, bucket) → [currKey, prevKey]
  Format: rl:v1:{dimension:identifier}:bucket
  Use hash tags {} for Redis cluster sharding
- hashIdentifier(raw) → string
  SHA-256, take first 16 hex chars
  Use for API keys and user IDs (never store raw)
- currentBucket(now_ms, window_ms) → number
  floor(now_ms / window_ms)

Include comprehensive tests for route normalization edge cases:
- Numeric IDs in multiple positions
- UUIDs (v4 format)
- Query strings (must be stripped)
- Special characters in path
- Empty path
```

---

## Phase 2 — Lua Scripts

**Goal:** Write and validate all Lua scripts. Test with a local Redis instance.

### Files to Create

```
lua/
├── check.lua
├── check_multi.lua
├── status.lua
├── reset.lua
└── reservoir_fetch.lua
```

### Claude Code Prompt

```
Create all Lua scripts in the lua/ directory as documented in docs/05-lua-scripts.md.

After creating each script:
1. Validate syntax: redis-cli --eval lua/check.lua 2 key1 key2 , 100 60000 1706000000 1 120000
2. Write a Redis CLI test sequence in tests/integration/lua-manual-test.sh

Create packages/core/src/lua-loader.ts:
- loadScript(name, client) → SHA string using SCRIPT LOAD
- evalScript(sha, keys, args, client) → result
- handleNoscript(name, keys, args, client) → retry after reload
- Pre-compute and export SCRIPT_NAMES array

For the NOSCRIPT handler, throw a typed error class ScriptNotLoadedError
that the adapter layer can catch and handle per failure policy.
```

---

## Phase 3 — Redis Client

**Goal:** Thin Redis client wrapper with connection management, EVALSHA, and health checks.

### Files to Create

```
packages/core/src/
├── redis-client.ts    ← Connection factory, EVALSHA wrapper
├── health.ts          ← Periodic health checks, memory monitoring
└── circuit-breaker.ts ← Circuit breaker implementation
```

### Claude Code Prompt

```
Create packages/core/src/redis-client.ts

Requirements:
- createClient(config: RedisConfig) → RedisClient
  Supports both single node and cluster (ioredis)
  TLS enabled when URL starts with rediss://
  Ping interval 30s for Lambda Extension (keep-alive)
  connectTimeout: 200ms, commandTimeout: 100ms
  maxRetriesPerRequest: 1

- RedisClient interface:
  evalsha(sha, keys, args) → Promise<any>  // with NOSCRIPT retry built in
  get(key) → Promise<string | null>
  info(section) → Promise<string>
  quit() → Promise<void>
  isConnected() → boolean

- All methods wrapped with:
  - Timing measurement (emit latency metric)
  - Error classification (connection / auth / noscript / wrongtype / other)
  - NOSCRIPT auto-retry (reload scripts, retry once)

Create packages/core/src/circuit-breaker.ts
Implement as documented in docs/07-thundering-herd.md
States: closed → open → half-open → closed
Wrap the evalsha call only
```

---

## Phase 4 — Core RateLimiter Class

**Goal:** The main `RateLimiter` class that wires together algorithm + keys + Redis + reservoir + circuit breaker.

### Files to Create

```
packages/core/src/
├── rate-limiter.ts    ← Main class
├── reservoir.ts       ← Local token reservoir
├── config-loader.ts   ← Rule matching + SSM loader
└── headers.ts         ← X-RateLimit-* header builder
```

### Claude Code Prompt

```
Create packages/core/src/rate-limiter.ts — the main class

Implement RateLimiter as documented in docs/04-sdk-design.md

The check(ctx) method must:
1. Find matching rule (config-loader.findRule(ctx, rules))
2. Determine which dimensions to check (based on rule.limits keys)
3. For each dimension (ip → route → user → user-route):
   a. Build curr + prev Redis keys
   b. Check local reservoir first
   c. If reservoir miss: call Redis via circuit breaker
   d. If denied: return immediately with RateLimitResult{allowed:false}
4. All dimensions passed: return RateLimitResult{allowed:true}
5. Always set response headers (even on deny)

Error handling:
- Redis error + fail_open: log warn, return allowed=true
- Redis error + fail_closed: log error, return allowed=false, statusCode=503
- Redis error + fail_local: use LocalFallbackLimiter

Create packages/core/src/reservoir.ts as documented in docs/04-sdk-design.md

Create integration tests in tests/integration/rate-limiter.test.ts
These tests require a running Redis instance (use testcontainers or docker-compose)
Test scenarios:
- Single dimension deny at exact limit
- Multi-dimension: IP passes, user denied
- Reservoir reduces Redis calls by batchSize factor
- Fail-open on Redis timeout (mock Redis with delay > commandTimeout)
- Reset clears counters
- Status returns correct counts without incrementing
```

---

## Phase 5 — Lambda Adapter

**Goal:** Lambda Extension + `withRateLimit` decorator, deployable to AWS.

### Files to Create

```
packages/lambda/
├── src/
│   ├── decorator.ts       ← withRateLimit(handler, config)
│   ├── extractor.ts       ← Extract IP/userId from API GW event
│   └── index.ts
├── extension/
│   ├── index.ts           ← Extension entry point
│   ├── lambda-api.ts      ← Lambda Extensions API registration
│   ├── local-server.ts    ← Local HTTP server on port 2772
│   └── Dockerfile         ← Package extension as layer
├── package.json
└── tsconfig.json
```

### Claude Code Prompt

```
Create the Lambda adapter in packages/lambda/

Step 1: Create extension/lambda-api.ts
Implement Lambda Extensions API lifecycle:
  POST /2020-01-01/extension/register → extensionId
  GET  /2020-01-01/extension/event/next → {eventType, deadlineMs}
eventType is INVOKE or SHUTDOWN

Step 2: Create extension/local-server.ts
HTTP server on localhost:2772 (or unix socket)
Single endpoint: POST /check
Body: RateLimitContext JSON
Response: RateLimitResult JSON
Use Node.js http module (no Express — minimize cold start size)

Step 3: Create extension/index.ts
Register → create RateLimiter → start server → event loop
On SHUTDOWN: limiter.shutdown() then server.close()
Add 0-500ms random startup jitter (thundering herd prevention)

Step 4: Create src/decorator.ts
withRateLimit(handler, config) wraps handler
Extract context from APIGatewayProxyEventV2 (v2 format preferred, v1 fallback)
Calls Extension local server (or Core directly if Extension not running)
On deny: return 429 with correct headers
On allow: call handler, merge rate limit headers into response

Step 5: Create Dockerfile for Lambda Layer
Package extension binary + dependencies
Follow AWS Lambda Extension packaging format
Layer structure: /opt/extensions/rate-limiter-extension

Write a CDK construct in infrastructure/lambda-rate-limiter-layer.ts
that deploys the extension as a Lambda Layer and attaches it to a function.
```

---

## Phase 6 — Middleware Adapter

**Goal:** Express + FastAPI middleware.

### Claude Code Prompt

```
Create packages/middleware/

TypeScript / Node.js:
- src/express.ts    — createRateLimitMiddleware(config) for Express
- src/fastify.ts    — rateLimitPlugin for Fastify (register pattern)
- src/generic.ts    — framework-agnostic: check(req) → RateLimitResult

Python:
- src/fastapi.py    — RateLimiterMiddleware(BaseHTTPMiddleware)
- src/flask.py      — before_request decorator
- src/grpc.py       — gRPC interceptor

For all adapters:
- Extract IP with configurable proxy trust depth
- Extract user ID from JWT (verify signature, cache result 60s) or API key header
- Set X-RateLimit-* headers on both allow and deny responses
- 429 response body: {"error":"Too Many Requests","retryAfter":N,"dimension":"user"}
- 503 response body: {"error":"Service Unavailable","message":"Rate limiter unavailable"} (fail_closed)

Test the Express middleware with supertest in tests/unit/middleware.test.ts
Mock the RateLimiter.check() method
Test: allow, deny 429, fail-open, fail-closed, header presence on all responses
```

---

## Phase 7 — Infrastructure as Code

**Goal:** Terraform for ElastiCache, security groups, SSM parameters.

### Files to Create

```
infrastructure/
├── terraform/
│   ├── elasticache.tf
│   ├── security-groups.tf
│   ├── ssm-parameters.tf
│   ├── cloudwatch-alarms.tf
│   └── variables.tf
├── cdk/
│   ├── lambda-rate-limiter-stack.ts
│   └── ecs-rate-limiter-stack.ts
└── docker-compose.dev.yml   ← Local Redis for development
```

### Claude Code Prompt

```
Create infrastructure/terraform/ for ElastiCache and supporting resources

elasticache.tf:
- aws_elasticache_replication_group
- 6 shards (num_cache_clusters per shard = 2 for HA)
- Node type: cache.r7g.large
- Engine: redis 7.x
- In-transit encryption enabled
- Auth token from SSM
- Automatic failover enabled
- Maintenance window: sun:05:00-sun:06:00
- Snapshot retention: 7 days

security-groups.tf:
- rate-limiter-redis-sg: ingress 6380 from application SGs only
- No public access

ssm-parameters.tf:
- /rate-limiter/{env}/redis/url
- /rate-limiter/{env}/redis/auth
- /rate-limiter/{env}/limits/* (dynamic limits)
All as SecureString type

cloudwatch-alarms.tf:
Create all alarms from docs/10-observability.md
SNS topic for alarm actions
Email subscription (var.alert_email)

variables.tf:
env, vpc_id, subnet_ids, app_security_group_ids, alert_email, redis_auth_token

Create infrastructure/docker-compose.dev.yml:
redis service with 6 instances to simulate cluster (use redis-cluster image)
Or single Redis for simple local dev (with RATE_LIMITER_CLUSTER_MODE=false env var)
```

---

## Phase 8 — Tests

**Goal:** Full test coverage — unit, integration, and load.

### Claude Code Prompt

```
Create the complete test suite

tests/unit/ (no Redis required — mock everything):
- algorithm.test.ts         ← Pure algorithm math
- key-builder.test.ts       ← Key construction + normalization
- circuit-breaker.test.ts   ← State transitions
- reservoir.test.ts         ← Token accounting
- config-loader.test.ts     ← Rule matching logic
- headers.test.ts           ← Header generation

tests/integration/ (requires Redis via docker-compose):
- rate-limiter.test.ts      ← Full end-to-end check/deny/reset/status
- lua-scripts.test.ts       ← Each Lua script directly
- multi-dimension.test.ts   ← IP + route + user + composite
- reservoir-redis.test.ts   ← Verify Redis call reduction
- failure-modes.test.ts     ← Mock Redis failures, verify policies

tests/load/ (k6):
- rate-limit-k6.js          ← Sustained 1000 VU load test (as in docs/06-scale-and-performance.md)
- burst-k6.js               ← Spike to 5000 VU, verify no thundering herd
- fairness-k6.js            ← 100 users at 2× their limit, verify equal distribution

Add to package.json:
"scripts": {
  "test": "jest tests/unit",
  "test:integration": "docker-compose up -d && jest tests/integration && docker-compose down",
  "test:load": "k6 run tests/load/rate-limit-k6.js",
  "test:all": "npm test && npm run test:integration"
}
```

---

## Phase 9 — CLI and Admin Tools

### Claude Code Prompt

```
Create a CLI tool at packages/cli/src/index.ts

Commands:
  rl status --user <userId> --route <route>
    → Show current rate limit status for a user+route

  rl reset --user <userId>
    → Reset all rate limit keys for a user

  rl top --dimension user --limit 20
    → Show top 20 users by request volume in current window

  rl test --config ./config/rate-limit.yaml
    → Validate config file syntax and rule coverage

  rl benchmark --requests 10000 --concurrency 100
    → Quick local benchmark of Redis throughput

Use commander.js for CLI parsing.
Read RATE_LIMITER_REDIS_URL from env or --redis flag.
Output as table (default) or --json for scripting.
```

---

## Build Order Summary

| Phase | What | Testable When Done |
|---|---|---|
| 1 | Core algorithm + key builder | Unit tests, no Redis needed |
| 2 | Lua scripts | Manual redis-cli test |
| 3 | Redis client + circuit breaker | docker-compose Redis |
| 4 | RateLimiter class + reservoir | Integration tests |
| 5 | Lambda adapter + Extension | Local invocation test |
| 6 | Middleware adapters | Express supertest |
| 7 | Infrastructure (Terraform/CDK) | terraform plan |
| 8 | Full test suite | All tests green |
| 9 | CLI tools | Manual usage |

---

## Claude Code Tips for This Project

**Always give Claude Code the relevant doc first:**
```bash
# Before working on Lua scripts:
"Read docs/05-lua-scripts.md and docs/02-algorithm.md, then implement..."

# Before working on Redis:
"Read docs/03-redis-design.md, especially the hash tag section, then..."
```

**Run tests after each phase:**
```bash
npm test               # After Phase 1
npm run test:integration  # After Phase 4
```

**Use Claude Code to explain failures:**
```
The integration test tests/integration/multi-dimension.test.ts is failing
with CROSSSLOT error. Read docs/03-redis-design.md (hash tags section)
and fix key-builder.ts.
```

**Iterate on Lua scripts interactively:**
```bash
# Test Lua scripts directly without the full SDK
redis-cli --eval lua/check.lua 2 \
  "rl:v1:{user:abc}:28433334" \
  "rl:v1:{user:abc}:28433333" \
  , 100 60000 1706000070000 1 120000
```
