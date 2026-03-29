/**
 * Koa example — uses the core RateLimiter API directly as Koa middleware.
 *
 * No built-in Koa adapter exists, so this shows how to build one in ~30 lines.
 *
 * Run:
 *   npx ts-node examples/koa.ts
 *
 * Test:
 *   curl -i http://localhost:3000/api/users
 */

import Koa from 'koa';
import Router from '@koa/router';
import { RateLimiter, RateLimitContext, RateLimitResult } from 'aws-rate-limiter';

async function main() {
  const limiter = new RateLimiter({
    redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
    rules: [
      {
        name: 'default',
        limits: {
          ip: { limit: 100, window: 60 },
          route: { limit: 1000, window: 60 },
          user: { limit: 200, window: 60 },
        },
      },
    ],
    failure: { default: 'open' },
  });

  await limiter.connect();

  const app = new Koa();
  app.proxy = true;

  // Rate limiting middleware
  app.use(async (ctx, next) => {
    // Skip health checks
    if (ctx.path === '/health') {
      return next();
    }

    const ip = ctx.ip || '0.0.0.0';
    const apiKey = ctx.get('x-api-key') || undefined;
    const userTier = ctx.get('x-user-tier') || undefined;

    const rateLimitCtx: RateLimitContext = {
      ip,
      apiKey,
      route: ctx.path,
      method: ctx.method,
      userTier,
    };

    let result: RateLimitResult;
    try {
      result = await limiter.check(rateLimitCtx);
    } catch {
      // Fail open on errors
      await next();
      return;
    }

    // Set rate limit headers
    const windowSecs = result.windowSecs ?? 60;
    ctx.set('X-RateLimit-Limit', String(result.limit));
    ctx.set('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
    ctx.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    ctx.set('X-RateLimit-Policy', `${result.limit};w=${windowSecs}`);

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

  // Routes
  const router = new Router();

  router.get('/health', (ctx) => {
    ctx.body = { status: 'ok', rateLimiterConnected: limiter.isConnected() };
  });

  router.get('/api/users', (ctx) => {
    ctx.body = { users: [{ id: 1, name: 'Alice' }] };
  });

  router.get('/api/users/:id', (ctx) => {
    ctx.body = { id: ctx.params.id, name: 'Alice' };
  });

  app.use(router.routes());
  app.use(router.allowedMethods());

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Koa server listening on http://localhost:${port}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await limiter.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
