/**
 * @fileoverview Integration tests for the RateLimiter class against a real Redis instance.
 *
 * These tests require either:
 *  - `REDIS_URL` environment variable pointing at a running Redis instance, or
 *  - `INTEGRATION_TESTS=true` environment variable (uses redis://localhost:6379 by default).
 *
 * If neither is set the entire suite is skipped automatically.
 *
 * Run with a local Redis:
 *   REDIS_URL=redis://localhost:6379 npx jest tests/integration
 *
 * Run with testcontainers (if wired in CI):
 *   INTEGRATION_TESTS=true npx jest tests/integration
 */

import { RateLimiter } from '../../src/rate-limiter';

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

const SKIP =
  !process.env['REDIS_URL'] && process.env['INTEGRATION_TESTS'] !== 'true';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('RateLimiter integration', () => {
  let limiter: RateLimiter;
  const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

  beforeAll(async () => {
    if (SKIP) return;

    limiter = new RateLimiter({
      redis: { url: REDIS_URL, connectTimeout: 5000, maxRetriesPerRequest: 1 },
      rules: [
        {
          name: 'test-rule',
          limits: {
            ip: { limit: 10, window: 60 },
            user: { limit: 5, window: 60 },
          },
        },
      ],
      reservoir: { enabled: false, batchSize: 10, syncInterval: 5000 },
    });

    await limiter.connect();
  }, 15_000);

  afterAll(async () => {
    if (SKIP || !limiter) return;
    await limiter.shutdown();
  });

  // Helper: use test.skip when Redis is not available.
  const itWithRedis = SKIP ? test.skip : test;

  // -------------------------------------------------------------------------
  // Basic allow
  // -------------------------------------------------------------------------

  itWithRedis('allows the first request', async () => {
    const result = await limiter.check({
      ip: '10.0.0.1',
      route: '/api/test',
      method: 'GET',
    });

    expect(result.allowed).toBe(true);
    expect(result.source).toBe('redis');
  });

  // -------------------------------------------------------------------------
  // Counter increments
  // -------------------------------------------------------------------------

  itWithRedis('increments the counter on successive requests', async () => {
    // Use a unique IP to avoid cross-test interference.
    const ip = `10.99.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    const ctx = { ip, route: '/api/counter-test', method: 'GET' };

    // Sequential requests so Redis processes them in order; each sees the
    // pre-increment count, so results[4] will have effective >= 1.
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await limiter.check(ctx));
    }

    expect(results.every((r) => r.allowed)).toBe(true);
    // After 5 increments the effective count must be >= 1.
    expect(results[4]?.effective).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Deny when limit exceeded
  // -------------------------------------------------------------------------

  itWithRedis('denies when the IP limit is exceeded', async () => {
    const ip = `11.${Math.floor(Math.random() * 255)}.0.1`;
    const ctx = { ip, route: '/api/deny-test', method: 'GET' };

    // Exhaust the limit of 10.
    for (let i = 0; i < 10; i++) {
      await limiter.check(ctx);
    }

    // The 11th request must be denied.
    const result = await limiter.check(ctx);

    expect(result.allowed).toBe(false);
    expect(result.dimension).toBe('ip');
    expect(result.remaining).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Status does not increment
  // -------------------------------------------------------------------------

  itWithRedis('status returns current count without incrementing', async () => {
    const ip = `12.0.0.${Math.floor(Math.random() * 250) + 1}`;
    const ctx = { ip, route: '/api/status-test', method: 'GET' };

    // Issue one real request so the counter is non-zero.
    await limiter.check(ctx);

    const before = await limiter.status(ctx);
    const after = await limiter.status(ctx);

    // Two consecutive status calls must return the same effective count.
    expect(after.effective).toBe(before.effective);
  });

  // -------------------------------------------------------------------------
  // Reset clears the counter
  // -------------------------------------------------------------------------

  itWithRedis('reset clears the counter', async () => {
    const ip = `13.0.0.${Math.floor(Math.random() * 250) + 1}`;
    const ctx = { ip, route: '/api/reset-test', method: 'GET' };

    // Build up some count.
    for (let i = 0; i < 8; i++) {
      await limiter.check(ctx);
    }

    const beforeReset = await limiter.status(ctx);
    expect(beforeReset.effective).toBeGreaterThan(0);

    // Reset the IP dimension.
    const deleted = await limiter.reset('ip', ip);
    expect(deleted).toBeGreaterThan(0);

    // After reset the effective count must have dropped.
    const afterReset = await limiter.status(ctx);
    expect(afterReset.effective).toBeLessThan(beforeReset.effective);
  });

  // -------------------------------------------------------------------------
  // User dimension
  // -------------------------------------------------------------------------

  itWithRedis('applies per-user limits independently of IP limits', async () => {
    const userId = `user-integration-${Math.floor(Math.random() * 1_000_000)}`;
    const ip = `14.0.0.${Math.floor(Math.random() * 250) + 1}`;
    const ctx = { ip, userId, route: '/api/user-test', method: 'POST' };

    // User limit is 5; exhaust it.
    for (let i = 0; i < 5; i++) {
      await limiter.check(ctx);
    }

    const denied = await limiter.check(ctx);

    // Could be denied on the user dimension (limit=5) before IP limit (10).
    expect(denied.allowed).toBe(false);
    expect(['user', 'ip']).toContain(denied.dimension);
  });

  // -------------------------------------------------------------------------
  // retryAfter on deny
  // -------------------------------------------------------------------------

  itWithRedis('denied result includes retryAfter', async () => {
    const ip = `15.${Math.floor(Math.random() * 255)}.0.1`;
    const ctx = { ip, route: '/api/retry-after-test', method: 'GET' };

    for (let i = 0; i < 10; i++) {
      await limiter.check(ctx);
    }

    const denied = await limiter.check(ctx);

    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeDefined();
    expect(typeof denied.retryAfter).toBe('number');
    expect(denied.retryAfter!).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // isConnected
  // -------------------------------------------------------------------------

  itWithRedis('isConnected returns true after connect()', () => {
    expect(limiter.isConnected()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // resetAt is in the future
  // -------------------------------------------------------------------------

  itWithRedis('resetAt is a future Unix epoch milliseconds value', async () => {
    const ip = `16.0.0.${Math.floor(Math.random() * 250) + 1}`;
    const result = await limiter.check({ ip, route: '/api/reset-at', method: 'GET' });

    expect(result.resetAt).toBeGreaterThan(Date.now());
  });
});
