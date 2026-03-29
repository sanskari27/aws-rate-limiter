/**
 * Plain Node.js HTTP server example — uses the core RateLimiter directly.
 *
 * Demonstrates how to integrate rate limiting with no framework at all.
 *
 * Run:
 *   npx ts-node examples/node-http.ts
 *
 * Test:
 *   curl -i http://localhost:3000/api/users
 *   for i in $(seq 1 110); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/users; done
 */

import * as http from 'http';
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
        },
      },
    ],
    failure: { default: 'open' },
  });

  await limiter.connect();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost`);
    const path = url.pathname;
    const method = req.method || 'GET';

    // Skip rate limiting for health checks
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Extract client IP from headers or socket
    const forwarded = req.headers['x-forwarded-for'];
    const ip = typeof forwarded === 'string'
      ? forwarded.split(',')[0].trim()
      : req.socket.remoteAddress || '0.0.0.0';

    // Extract API key if present
    const apiKey = req.headers['x-api-key'] as string | undefined;

    const ctx: RateLimitContext = { ip, route: path, method, apiKey };

    let result: RateLimitResult;
    try {
      result = await limiter.check(ctx);
    } catch {
      // If rate limiter fails, allow the request through (fail-open)
      result = {
        allowed: true,
        dimension: 'none',
        effective: 0,
        limit: 0,
        remaining: 0,
        resetAt: 0,
        source: 'local_fallback',
      };
    }

    // Set rate limit headers
    const windowSecs = result.windowSecs ?? 60;
    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    res.setHeader('X-RateLimit-Policy', `${result.limit};w=${windowSecs}`);

    if (!result.allowed) {
      if (result.retryAfter !== undefined) {
        res.setHeader('Retry-After', String(Math.ceil(result.retryAfter / 1000)));
      }
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter: result.retryAfter }));
      return;
    }

    // Route handling
    if (method === 'GET' && path === '/api/users') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ users: [{ id: 1, name: 'Alice' }] }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
  });

  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => {
    console.log(`Node.js HTTP server listening on http://localhost:${port}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    server.close();
    await limiter.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
