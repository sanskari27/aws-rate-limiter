/**
 * Hapi example — uses the core RateLimiter API as a Hapi lifecycle extension.
 *
 * No built-in Hapi adapter exists, so this shows how to integrate via onPreHandler.
 *
 * Run:
 *   npx ts-node examples/hapi.ts
 *
 * Test:
 *   curl -i http://localhost:3000/api/users
 */

import Hapi from '@hapi/hapi';
import { RateLimiter, RateLimitContext, RateLimitResult } from 'aws-rate-limiter';

async function main() {
  const limiter = new RateLimiter({
    redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
    rules: [
      {
        name: 'auth',
        match: { routes: ['POST /auth/*', 'POST /login'] },
        limits: { ip: { limit: 10, window: 60 } },
        failure: 'closed',
      },
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

  const server = Hapi.server({
    port: Number(process.env.PORT) || 3000,
    host: '0.0.0.0',
  });

  // Rate limiting as a Hapi lifecycle extension
  server.ext('onPreHandler', async (request, h) => {
    // Skip health checks
    if (request.path === '/health') {
      return h.continue;
    }

    const ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || request.info.remoteAddress
      || '0.0.0.0';
    const apiKey = request.headers['x-api-key'] || undefined;
    const userTier = request.headers['x-user-tier'] || undefined;

    const ctx: RateLimitContext = {
      ip,
      apiKey,
      route: request.path,
      method: request.method.toUpperCase(),
      userTier,
    };

    let result: RateLimitResult;
    try {
      result = await limiter.check(ctx);
    } catch {
      return h.continue;
    }

    // Set rate limit headers on the response
    const windowSecs = result.windowSecs ?? 60;
    const response = request.response;
    if (response && 'header' in response && typeof response.header === 'function') {
      response.header('X-RateLimit-Limit', String(result.limit));
      response.header('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
      response.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
      response.header('X-RateLimit-Policy', `${result.limit};w=${windowSecs}`);
    }

    if (!result.allowed) {
      const errorResponse = h.response({
        error: 'Too Many Requests',
        retryAfter: result.retryAfter,
      }).code(429);

      errorResponse.header('X-RateLimit-Limit', String(result.limit));
      errorResponse.header('X-RateLimit-Remaining', '0');
      errorResponse.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
      errorResponse.header('X-RateLimit-Policy', `${result.limit};w=${windowSecs}`);

      if (result.retryAfter !== undefined) {
        errorResponse.header('Retry-After', String(Math.ceil(result.retryAfter / 1000)));
      }
      return errorResponse.takeover();
    }

    return h.continue;
  });

  // Set rate limit headers on successful responses via onPreResponse
  server.ext('onPreResponse', (request, h) => {
    const response = request.response;
    if ('header' in response && typeof response.header === 'function') {
      const rl = (request.plugins as Record<string, unknown>)['rateLimitResult'] as RateLimitResult | undefined;
      if (rl) {
        const windowSecs = rl.windowSecs ?? 60;
        response.header('X-RateLimit-Limit', String(rl.limit));
        response.header('X-RateLimit-Remaining', String(Math.max(0, rl.remaining)));
        response.header('X-RateLimit-Reset', String(Math.ceil(rl.resetAt / 1000)));
        response.header('X-RateLimit-Policy', `${rl.limit};w=${windowSecs}`);
      }
    }
    return h.continue;
  });

  server.route({
    method: 'GET',
    path: '/health',
    handler: () => ({ status: 'ok', rateLimiterConnected: limiter.isConnected() }),
  });

  server.route({
    method: 'GET',
    path: '/api/users',
    handler: () => ({ users: [{ id: 1, name: 'Alice' }] }),
  });

  server.route({
    method: 'GET',
    path: '/api/users/{id}',
    handler: (request) => ({ id: request.params.id, name: 'Alice' }),
  });

  await server.start();
  console.log(`Hapi server listening on ${server.info.uri}`);

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await server.stop({ timeout: 5000 });
    await limiter.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
