# Redis Rate Limiter — Project Documentation

> Production-grade, multi-dimensional rate limiting module for AWS Lambda and EC2/ECS.  
> Sliding window counter algorithm · Redis-backed global state · 1M req/s target scale.

---

## Document Index

| Document | Purpose |
|---|---|
| [01-architecture.md](./01-architecture.md) | System architecture, component map, attachment model |
| [02-algorithm.md](./02-algorithm.md) | Sliding window counter — math, Redis model, Lua script |
| [03-redis-design.md](./03-redis-design.md) | Key schema, TTL strategy, cluster topology, memory sizing |
| [04-sdk-design.md](./04-sdk-design.md) | SDK interface, adapters (Lambda / EC2), local reservoir |
| [05-lua-scripts.md](./05-lua-scripts.md) | All Lua scripts, annotated, with edge case handling |
| [06-scale-and-performance.md](./06-scale-and-performance.md) | 1M req/s strategy, local reservoir, sharding, benchmarks |
| [07-thundering-herd.md](./07-thundering-herd.md) | Thundering herd problem, jitter, retry strategies |
| [08-failure-modes.md](./08-failure-modes.md) | Failure taxonomy, fallback policies, circuit breaker |
| [09-multi-dimensional-limiting.md](./09-multi-dimensional-limiting.md) | Per-user, per-IP, per-route, composite keys |
| [10-observability.md](./10-observability.md) | Metrics, CloudWatch, alerting, dashboards |
| [11-configuration.md](./11-configuration.md) | Config schema, per-route overrides, dynamic config |
| [12-claude-code-build-plan.md](./12-claude-code-build-plan.md) | Step-by-step Claude Code build instructions |

---

## Project Summary

### What This Is

A self-contained rate limiting module that can be attached to any AWS Lambda function or EC2/ECS service without changing application code. It uses Redis as the global counter store and implements the **sliding window counter** algorithm for accurate, memory-efficient limiting across multiple dimensions simultaneously.

### Core Design Decisions (from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Algorithm | Sliding window counter | O(1) memory, ~99% accuracy, 2 Redis ops/check |
| Storage | Redis (ElastiCache) | Atomic Lua scripts, sub-ms latency, cluster scaling |
| Attachment (Lambda) | Lambda Extension + middleware decorator | Shared Redis connection across invocations |
| Attachment (EC2/ECS) | HTTP middleware library + optional sidecar | Language-agnostic sidecar for polyglot services |
| Atomicity | Lua scripts via EVALSHA | Single round-trip, no race conditions |
| Scale strategy | Local token reservoir + Redis cluster | Cuts Redis traffic ~100x at the edge |
| Failure policy | Configurable per route (open/closed/local) | Different routes have different risk profiles |

### Deployment Targets

- **AWS Lambda** — via Lambda Extension (manages Redis connection lifecycle) + thin handler wrapper
- **EC2 / ECS** — via Express/FastAPI middleware library or standalone sidecar container

### Rate Limit Dimensions

Each request is checked against up to 4 dimensions, cheapest first:

1. **Per-IP** — `rl:v1:ip:{ip_address}:{bucket}`
2. **Per-route** — `rl:v1:route:{method_path}:{bucket}`
3. **Per-user/API-key** — `rl:v1:user:{user_id}:{bucket}`
4. **Composite (user + route)** — `rl:v1:user-route:{user_id}:{method_path}:{bucket}`

### Scale Target

- **1,000,000 req/s** sustained throughput
- Achieved via: local reservoir (100x Redis traffic reduction) + Redis cluster (6-8 nodes) + read replicas for status queries
- Single Redis node capacity: ~100K ops/s → cluster of 8 = ~800K ops/s headroom before local reservoir kicks in

---

## Quick Start (for Claude Code)

```bash
# Repository structure to create
rate-limiter/
├── packages/
│   ├── core/          # Algorithm + Redis logic (language-agnostic)
│   ├── lambda/        # Lambda Extension + decorator adapter
│   ├── middleware/    # Express / FastAPI / generic HTTP adapter
│   └── sidecar/       # Standalone container adapter
├── lua/               # All Lua scripts
├── config/            # Config schema + examples
├── tests/
│   ├── unit/
│   ├── integration/   # Requires Redis
│   └── load/          # k6 load test scripts
└── docs/              # This documentation
```

See [12-claude-code-build-plan.md](./12-claude-code-build-plan.md) for the full step-by-step build guide.
