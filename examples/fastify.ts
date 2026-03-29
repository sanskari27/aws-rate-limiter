/**
 * Fastify example — uses the built-in `createFastifyHook` adapter.
 *
 * Run:
 *   npx ts-node examples/fastify.ts
 *
 * Test:
 *   curl -i http://localhost:3000/api/users
 */

import Fastify from 'fastify';
import { RateLimiter } from 'aws-rate-limiter';
import { createFastifyHook } from 'aws-rate-limiter/adapters/fastify';

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
    failure: { default: 'open', circuitBreaker: { enabled: true, threshold: 5, recoveryTimeout: 30000 } },
  });

  await limiter.connect();

  const fastify = Fastify({ logger: true, trustProxy: true });

  // Register the rate limiter as a preHandler hook
  fastify.addHook(
    'preHandler',
    createFastifyHook({
      rateLimiter: limiter,
      skipRoutes: ['/health', '/metrics'],
      ipExtraction: {
        trustXForwardedFor: true,
        trustedProxyCount: 1,
      },
      getUserTier: (req) => {
        return req.headers['x-user-tier'] as string | undefined;
      },
    }),
  );

  fastify.get('/health', async () => {
    return { status: 'ok', rateLimiterConnected: limiter.isConnected() };
  });

  fastify.get('/api/users', async () => {
    return { users: [{ id: 1, name: 'Alice' }] };
  });

  fastify.get('/api/users/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { id, name: 'Alice' };
  });

  fastify.post('/api/users', async (request, reply) => {
    reply.code(201);
    return { created: request.body };
  });

  const port = Number(process.env.PORT) || 3000;
  await fastify.listen({ port, host: '0.0.0.0' });

  // Graceful shutdown
  const shutdown = async () => {
    await fastify.close();
    await limiter.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
