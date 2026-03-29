# aws-rate-limiter Examples

Usage examples for every supported framework and integration.

## Built-in Adapters

These frameworks have first-class adapter support with zero additional dependencies:

| Example | Adapter | File |
|---------|---------|------|
| [Express](./express.ts) | `createExpressMiddleware` | `src/adapters/express.ts` |
| [Fastify](./fastify.ts) | `createFastifyHook` | `src/adapters/fastify.ts` |
| [AWS Lambda](./aws-lambda.ts) | `withRateLimit` + `LambdaExtension` | `src/adapters/lambda/` |

## Core API (Any Framework)

These examples use the `RateLimiter` class directly — works with any Node.js HTTP framework:

| Example | Framework | File |
|---------|-----------|------|
| [Node.js HTTP](./node-http.ts) | Built-in `http` module | No dependencies |
| [Koa](./koa.ts) | Koa 2.x | `koa` |
| [Hapi](./hapi.ts) | @hapi/hapi 21.x | `@hapi/hapi` |
| [NestJS](./nestjs.ts) | NestJS 10.x | `@nestjs/common`, `@nestjs/core` |

## Shared Configuration

All examples reference a shared YAML config file:

- [`rate-limiter.yaml`](./rate-limiter.yaml) — example configuration with multiple rules, tiered limits, and failure policies.

## Prerequisites

1. A running Redis instance (local or ElastiCache):
   ```bash
   docker run -d --name redis -p 6379:6379 redis:7-alpine
   ```

2. Install the rate limiter:
   ```bash
   npm install aws-rate-limiter
   ```

3. Set the Redis URL (or configure in YAML):
   ```bash
   export REDIS_URL=redis://localhost:6379
   ```

## Quick Start

The simplest way to get started — Express with environment config:

```typescript
import express from 'express';
import { RateLimiter } from 'aws-rate-limiter';
import { createExpressMiddleware } from 'aws-rate-limiter/adapters/express';

const limiter = new RateLimiter({
  redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
  rules: [{ name: 'default', limits: { ip: { limit: 100, window: 60 } } }],
});

const app = express();

async function start() {
  await limiter.connect();
  app.use(createExpressMiddleware({ rateLimiter: limiter }));
  app.get('/', (_req, res) => res.json({ message: 'Hello!' }));
  app.listen(3000);
}

start();
```
