/**
 * Express example — uses the built-in `createExpressMiddleware` adapter.
 *
 * Run:
 *   npx ts-node examples/express.ts
 *
 * Test:
 *   curl -i http://localhost:3000/api/users
 *   curl -i -H "X-API-Key: my-secret" http://localhost:3000/api/users
 */

import express from 'express';
import { RateLimiter } from 'aws-rate-limiter';
import { createExpressMiddleware } from 'aws-rate-limiter/adapters/express';
import { loadConfig } from 'aws-rate-limiter/config';

async function main() {
  // Load config from YAML (or fall back to RATE_LIMITER_* env vars)
  const config = loadConfig('./rate-limiter.yaml');
  const limiter = new RateLimiter(config);
  await limiter.connect();

  const app = express();
  app.set('trust proxy', 1);

  // Apply rate limiting globally
  app.use(
    createExpressMiddleware({
      rateLimiter: limiter,
      skipRoutes: ['/health', '/metrics'],
      setHeaders: true,
      ipExtraction: {
        trustXForwardedFor: true,
        trustedProxyCount: 1,
      },
      // getUserTier tells the rate limiter which rule tier to match.
      // Without this, rules with `match.userTiers` (like "premium-tier"
      // in rate-limiter.yaml) will NEVER match — all requests fall through
      // to the default catch-all rule.
      //
      // Common strategies:
      //   - Read from a header set by your API gateway / auth layer
      //   - Decode from a JWT claim (e.g. after passport/auth middleware)
      //   - Look up from a database based on the authenticated user
      getUserTier: (req) => {
        // Option A: header set by upstream (API Gateway, auth proxy, etc.)
        const tierHeader = req.headers['x-user-tier'] as string | undefined;
        if (tierHeader) return tierHeader;

        // Option B: from a decoded JWT attached by earlier auth middleware
        // (e.g. req.user is populated by passport or a custom middleware)
        const user = (req as any).user as { tier?: string } | undefined;
        if (user?.tier) return user.tier;

        // No tier detected — "premium-tier" YAML rule won't match;
        // request falls through to "default"
        return undefined;
      },
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', rateLimiterConnected: limiter.isConnected() });
  });

  app.get('/api/users', (_req, res) => {
    res.json({ users: [{ id: 1, name: 'Alice' }] });
  });

  app.post('/api/users', express.json(), (req, res) => {
    res.status(201).json({ created: req.body });
  });

  app.get('/api/users/:id', (req, res) => {
    res.json({ id: req.params.id, name: 'Alice' });
  });

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Express server listening on http://localhost:${port}`);
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
