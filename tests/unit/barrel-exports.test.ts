/**
 * @fileoverview Smoke tests for all barrel re-export index files.
 *
 * These tests verify that each public entry point (index.ts) correctly
 * re-exports the symbols consumers expect.  They also bring the barrel
 * files into Jest's coverage scope so the lines/functions counters reflect
 * actual executable re-export statements.
 */

// ---------------------------------------------------------------------------
// src/core/index.ts
// ---------------------------------------------------------------------------

describe('src/core/index barrel', () => {
  it('re-exports types, algorithm, and key-builder symbols', async () => {
    const mod = await import('../../src/core/index');

    // Types
    expect(mod.ConfigurationError).toBeDefined();
    expect(mod.RedisConnectionError).toBeDefined();

    // Algorithm
    expect(mod.computeWeight).toBeDefined();
    expect(mod.computeBucket).toBeDefined();
    expect(mod.isAllowed).toBeDefined();

    // Key-builder
    expect(mod.buildIPKey).toBeDefined();
    expect(mod.buildRouteKey).toBeDefined();
    expect(mod.buildUserKey).toBeDefined();
    expect(mod.buildUserRouteKey).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// src/redis/index.ts
// ---------------------------------------------------------------------------

describe('src/redis/index barrel', () => {
  it('re-exports CircuitBreaker, ScriptLoader, and RedisClientManager', async () => {
    const mod = await import('../../src/redis/index');

    expect(mod.CircuitBreaker).toBeDefined();
    expect(mod.ScriptLoader).toBeDefined();
    expect(mod.ScriptNotLoadedError).toBeDefined();
    expect(mod.ScriptBusyError).toBeDefined();
    expect(mod.RedisClientManager).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// src/observability/index.ts
// ---------------------------------------------------------------------------

describe('src/observability/index barrel', () => {
  it('re-exports Logger, createLogger, and metrics symbols', async () => {
    const mod = await import('../../src/observability/index');

    expect(mod.Logger).toBeDefined();
    expect(mod.createLogger).toBeDefined();
    expect(mod.NoopMetrics).toBeDefined();
    expect(mod.InMemoryMetrics).toBeDefined();
    expect(mod.MetricNames).toBeDefined();
    expect(mod.createMetrics).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// src/reservoir/index.ts
// ---------------------------------------------------------------------------

describe('src/reservoir/index barrel', () => {
  it('re-exports LocalReservoir', async () => {
    const mod = await import('../../src/reservoir/index');

    expect(mod.LocalReservoir).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// src/config/index.ts
// ---------------------------------------------------------------------------

describe('src/config/index barrel', () => {
  it('re-exports loader functions and SSMWatcher', async () => {
    const mod = await import('../../src/config/index');

    expect(mod.loadConfig).toBeDefined();
    expect(mod.loadConfigFromFile).toBeDefined();
    expect(mod.loadConfigFromEnv).toBeDefined();
    expect(mod.validateConfig).toBeDefined();
    expect(mod.SSMWatcher).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// src/adapters/index.ts
// ---------------------------------------------------------------------------

describe('src/adapters/index barrel', () => {
  it('re-exports Express and Fastify adapter functions', async () => {
    const mod = await import('../../src/adapters/index');

    expect(mod.createExpressMiddleware).toBeDefined();
    expect(mod.extractIPFromRequest).toBeDefined();
    expect(mod.extractUserFromRequest).toBeDefined();
    expect(mod.buildRateLimitHeaders).toBeDefined();
    expect(mod.createFastifyHook).toBeDefined();
    expect(mod.extractIPFromFastifyRequest).toBeDefined();
    expect(mod.extractUserFromFastifyRequest).toBeDefined();
    expect(mod.parsePathFromUrl).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// src/adapters/lambda/index.ts
// ---------------------------------------------------------------------------

describe('src/adapters/lambda/index barrel', () => {
  it('re-exports LambdaExtension and withRateLimit', async () => {
    const mod = await import('../../src/adapters/lambda/index');

    expect(mod.LambdaExtension).toBeDefined();
    expect(mod.withRateLimit).toBeDefined();
    expect(mod.extractContext).toBeDefined();
    expect(mod.buildRateLimitHeaders).toBeDefined();
  });
});
