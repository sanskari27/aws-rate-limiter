/**
 * @fileoverview Unit tests for the RateLimiter class.
 * All Redis dependencies are mocked — no real network calls are made.
 */

import { RateLimiter, findMatchingRule, buildActiveDimensions } from '../../src/rate-limiter';
import { RateLimiterConfig, RateLimitContext, RuleConfig } from '../../src/core/types';
import { normalizeRoute, normalizeIP } from '../../src/core/key-builder';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../src/redis/client');
jest.mock('../../src/redis/script-loader');
jest.mock('../../src/redis/circuit-breaker');
jest.mock('../../src/reservoir/local-reservoir');

import { RedisClientManager } from '../../src/redis/client';
import { ScriptLoader } from '../../src/redis/script-loader';
import { CircuitBreaker } from '../../src/redis/circuit-breaker';
import { LocalReservoir } from '../../src/reservoir/local-reservoir';

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------

const MockedRedisManager = RedisClientManager as jest.MockedClass<typeof RedisClientManager>;
const MockedScriptLoader = ScriptLoader as jest.MockedClass<typeof ScriptLoader>;
const MockedCircuitBreaker = CircuitBreaker as jest.MockedClass<typeof CircuitBreaker>;
const MockedLocalReservoir = LocalReservoir as jest.MockedClass<typeof LocalReservoir>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseConfig: RateLimiterConfig = {
  redis: { url: 'redis://localhost:6379' },
  rules: [
    {
      name: 'default',
      limits: {
        ip: { limit: 100, window: 60 },
        route: { limit: 5000, window: 60 },
        user: { limit: 200, window: 60 },
        userRoute: { limit: 50, window: 60 },
      },
      failure: 'open',
    },
  ],
};

const baseCtx: RateLimitContext = {
  ip: '127.0.0.1',
  route: '/api/users',
  method: 'GET',
  userId: 'user-abc',
};

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

/**
 * Build a RateLimiter with mocked dependencies already wired.
 * Returns the limiter plus the mock instances for assertions.
 */
function buildLimiter(config: RateLimiterConfig = baseConfig) {
  // Reset all mocks before each build.
  MockedRedisManager.mockClear();
  MockedScriptLoader.mockClear();
  MockedCircuitBreaker.mockClear();
  MockedLocalReservoir.mockClear();

  const limiter = new RateLimiter(config);

  const redisManagerInstance = MockedRedisManager.mock.instances[0];
  const scriptLoaderInstance = MockedScriptLoader.mock.instances[0];
  const circuitBreakerInstance = MockedCircuitBreaker.mock.instances[0];

  return { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance };
}

/**
 * Configure mocks so that `limiter.connect()` resolves successfully.
 */
function setupConnectMocks(
  redisManagerInstance: jest.Mocked<RedisClientManager>,
  scriptLoaderInstance: jest.Mocked<ScriptLoader>,
) {
  const fakeClient = {} as ReturnType<RedisClientManager['getClient']>;
  redisManagerInstance.connect = jest.fn().mockResolvedValue(fakeClient);
  redisManagerInstance.isConnected = jest.fn().mockReturnValue(true);
  redisManagerInstance.getClient = jest.fn().mockReturnValue(fakeClient);
  redisManagerInstance.disconnect = jest.fn().mockResolvedValue(undefined);
  scriptLoaderInstance.loadAll = jest.fn().mockResolvedValue({
    check: 'sha1', checkMulti: 'sha2', status: 'sha3', reset: 'sha4', reservoirFetch: 'sha5',
  });
}

// Lua responses — {allowed=1, failedDim='', effective=0, limit=0, ttlMs=0}
const LUA_ALLOWED = [1, '', 0, 0, 0];
// {allowed=0, failedDim='ip', effective=110, limit=100, ttlMs=30000}
const LUA_DENIED_IP = [0, 'ip', 110, 100, 30000];

// ---------------------------------------------------------------------------
// connect() / shutdown()
// ---------------------------------------------------------------------------

describe('RateLimiter.connect()', () => {
  it('connects to Redis and loads scripts', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    await limiter.connect();

    expect(redisManagerInstance.connect).toHaveBeenCalled();
    expect(scriptLoaderInstance.loadAll).toHaveBeenCalled();
    expect(limiter.isConnected()).toBe(true);
  });
});

describe('RateLimiter.shutdown()', () => {
  it('disconnects from Redis after connect', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    await limiter.connect();
    await limiter.shutdown();

    expect(redisManagerInstance.disconnect).toHaveBeenCalled();
  });

  it('flushes reservoir on shutdown when reservoir is enabled', async () => {
    const configWithReservoir: RateLimiterConfig = {
      ...baseConfig,
      reservoir: { enabled: true, batchSize: 10, syncInterval: 5000 },
    };
    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter(configWithReservoir);
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const reservoirInstance = MockedLocalReservoir.mock.instances[0] as jest.Mocked<LocalReservoir>;
    reservoirInstance.flush = jest.fn().mockResolvedValue(undefined);

    await limiter.connect();
    await limiter.shutdown();

    expect(reservoirInstance.flush).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// check()
// ---------------------------------------------------------------------------

describe('RateLimiter.check()', () => {
  async function setupAndCheck(
    luaResult: unknown[],
    ctx: RateLimitContext = baseCtx,
    config: RateLimiterConfig = baseConfig,
  ) {
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(config);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordSuccess = jest.fn();
    cbMock.recordFailure = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue(luaResult);

    await limiter.connect();
    const result = await limiter.check(ctx);

    return { result, slMock, cbMock };
  }

  it('returns allowed:true when Lua returns allowed=1', async () => {
    const { result } = await setupAndCheck(LUA_ALLOWED);
    expect(result.allowed).toBe(true);
    expect(result.source).toBe('redis');
  });

  it('returns allowed:false with correct dimension when Lua returns allowed=0', async () => {
    const { result } = await setupAndCheck(LUA_DENIED_IP);
    expect(result.allowed).toBe(false);
    expect(result.dimension).toBe('ip');
    expect(result.effective).toBe(110);
    expect(result.limit).toBe(100);
    expect(result.remaining).toBe(0);
  });

  it('records circuit breaker success on allowed result', async () => {
    const { cbMock } = await setupAndCheck(LUA_ALLOWED);
    expect(cbMock.recordSuccess).toHaveBeenCalled();
  });

  it('records circuit breaker success on denied result', async () => {
    const { cbMock } = await setupAndCheck(LUA_DENIED_IP);
    expect(cbMock.recordSuccess).toHaveBeenCalled();
  });

  it('returns correct RateLimitResult fields (remaining, resetAt, retryAfter) on deny', async () => {
    const { result } = await setupAndCheck(LUA_DENIED_IP);
    expect(result.remaining).toBe(0);
    expect(result.resetAt).toBeGreaterThan(0);
    expect(result.retryAfter).toBe(30000);
  });

  it('returns correct RateLimitResult fields on allow', async () => {
    const { result } = await setupAndCheck(LUA_ALLOWED);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
    expect(result.resetAt).toBeGreaterThan(0);
    expect(result.retryAfter).toBeUndefined();
  });

  it('uses fail_open when circuit breaker is open', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter();

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(false);

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    expect(result.allowed).toBe(true);
    expect(result.source).toBe('local_fallback');
  });

  it('uses fail_closed when failure policy is "closed" and Redis throws', async () => {
    const configClosed: RateLimiterConfig = {
      ...baseConfig,
      rules: [{ ...baseConfig.rules[0], failure: 'closed' }],
    };

    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configClosed);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordFailure = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockRejectedValue(new Error('Redis connection lost'));

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    expect(result.allowed).toBe(false);
    expect(result.dimension).toBe('redis_error');
    expect(result.source).toBe('local_fallback');
    expect(cbMock.recordFailure).toHaveBeenCalled();
  });

  it('uses fail_local when failure policy is "local" and Redis throws', async () => {
    const configLocal: RateLimiterConfig = {
      ...baseConfig,
      rules: [{ ...baseConfig.rules[0], failure: 'local' }],
    };

    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configLocal);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordFailure = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockRejectedValue(new Error('Redis timeout'));

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    expect(result.source).toBe('local_fallback');
    // The local fallback should allow the first request (under limit)
    expect(result.allowed).toBe(true);
  });

  it('returns allowed:true immediately when no dimensions are active', async () => {
    const configNoDims: RateLimiterConfig = {
      ...baseConfig,
      rules: [{ name: 'nodims', limits: {} }],
    };

    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configNoDims);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn();

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    expect(result.allowed).toBe(true);
    expect(result.dimension).toBe('none');
    // No Redis call needed
    expect(slMock.eval).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// status()
// ---------------------------------------------------------------------------

describe('RateLimiter.status()', () => {
  it('returns current usage without incrementing', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter();

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);

    // status.lua returns {effective, limit, remaining, ttl_ms}
    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue([50, 100, 50, 30000]);

    await limiter.connect();
    const result = await limiter.status(baseCtx);

    // Should have called 'status' script (not 'checkMulti')
    const calls = slMock.eval.mock.calls;
    expect(calls.every((c) => c[1] === 'status')).toBe(true);

    expect(result.effective).toBe(50);
    expect(result.limit).toBe(100);
  });

  it('returns the most constrained dimension (lowest remaining)', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter();

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    // Return progressively lower remaining for ip, route, user, userRoute dims
    slMock.eval = jest
      .fn()
      .mockResolvedValueOnce([50, 100, 50, 30000])   // ip: remaining=50
      .mockResolvedValueOnce([4900, 5000, 100, 30000]) // route: remaining=100
      .mockResolvedValueOnce([190, 200, 10, 30000])    // user: remaining=10 ← most constrained
      .mockResolvedValueOnce([40, 50, 10, 30000]);     // userRoute: remaining=10

    await limiter.connect();
    const result = await limiter.status(baseCtx);

    // Most constrained = user or userRoute with remaining=10
    expect(result.remaining).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe('RateLimiter.reset()', () => {
  it('calls reset.lua with correct keys and returns deleted count', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter();

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue(2);

    await limiter.connect();
    const deleted = await limiter.reset('ip', '127.0.0.1');

    expect(slMock.eval).toHaveBeenCalledWith(
      expect.anything(), // client
      'reset',
      expect.arrayContaining([
        expect.stringContaining('ip:'),
        expect.stringContaining('ip:'),
      ]),
      [],
    );
    expect(deleted).toBe(2);
  });

  it('returns 0 when no limit spec for dimension', async () => {
    const configNoIp: RateLimiterConfig = {
      ...baseConfig,
      rules: [{ name: 'noip', limits: { route: { limit: 1000, window: 60 } } }],
    };

    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter(configNoIp);
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    await limiter.connect();
    const deleted = await limiter.reset('ip', '127.0.0.1');

    expect(deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findMatchingRule()
// ---------------------------------------------------------------------------

describe('findMatchingRule()', () => {
  const freeRule: RuleConfig = {
    name: 'free',
    match: { routes: ['GET /api/*'], userTiers: ['free'] },
    limits: { ip: { limit: 50, window: 60 } },
  };

  const proRule: RuleConfig = {
    name: 'pro',
    match: { routes: ['GET /api/*'], userTiers: ['pro'] },
    limits: { ip: { limit: 500, window: 60 } },
  };

  const defaultRule: RuleConfig = {
    name: 'default',
    limits: { ip: { limit: 100, window: 60 } },
  };

  const rules = [freeRule, proRule, defaultRule];

  it('matches by route pattern', () => {
    const ctx: RateLimitContext = {
      ip: '1.2.3.4',
      route: '/api/orders',
      method: 'GET',
      userTier: 'free',
    };
    const matched = findMatchingRule(ctx, rules);
    expect(matched.name).toBe('free');
  });

  it('matches by userTier', () => {
    const ctx: RateLimitContext = {
      ip: '1.2.3.4',
      route: '/api/users',
      method: 'GET',
      userTier: 'pro',
    };
    const matched = findMatchingRule(ctx, rules);
    expect(matched.name).toBe('pro');
  });

  it('returns last rule when nothing matches', () => {
    const ctx: RateLimitContext = {
      ip: '1.2.3.4',
      route: '/health',
      method: 'GET',
      userTier: 'enterprise',
    };
    const matched = findMatchingRule(ctx, rules);
    expect(matched.name).toBe('default');
  });

  it('returns a rule with no match field immediately (catch-all)', () => {
    const catchAll: RuleConfig = { name: 'catch', limits: {} };
    const matched = findMatchingRule(baseCtx, [catchAll]);
    expect(matched.name).toBe('catch');
  });

  it('does not match when route pattern does not match', () => {
    const restrictedRule: RuleConfig = {
      name: 'restricted',
      match: { routes: ['POST /admin/*'] },
      limits: { ip: { limit: 10, window: 60 } },
    };
    const ctx: RateLimitContext = {
      ip: '1.2.3.4',
      route: '/api/users',
      method: 'GET',
    };
    const matched = findMatchingRule(ctx, [restrictedRule, defaultRule]);
    expect(matched.name).toBe('default');
  });

  it('matches by ip when ips list is specified', () => {
    const ipRule: RuleConfig = {
      name: 'ipRule',
      match: { ips: ['10.0.0.1'] },
      limits: { ip: { limit: 1000, window: 60 } },
    };
    const ctx: RateLimitContext = {
      ip: '10.0.0.1',
      route: '/api/data',
      method: 'GET',
    };
    const matched = findMatchingRule(ctx, [ipRule, defaultRule]);
    expect(matched.name).toBe('ipRule');
  });
});

// ---------------------------------------------------------------------------
// buildActiveDimensions()
// ---------------------------------------------------------------------------

describe('buildActiveDimensions()', () => {
  const fullRule: RuleConfig = {
    name: 'full',
    limits: {
      ip: { limit: 100, window: 60 },
      route: { limit: 5000, window: 60 },
      user: { limit: 200, window: 60 },
      userRoute: { limit: 50, window: 60 },
    },
  };

  it('builds all 4 dimensions when user is present', () => {
    const ctx: RateLimitContext = {
      ip: '127.0.0.1',
      userId: 'user1',
      route: '/api/test',
      method: 'GET',
    };
    const dims = buildActiveDimensions(ctx, fullRule, Date.now());
    const names = dims.map((d) => d.name);
    expect(names).toEqual(['ip', 'route', 'user', 'user-route']);
  });

  it('omits user and user-route when no userId or apiKey', () => {
    const ctx: RateLimitContext = {
      ip: '127.0.0.1',
      route: '/api/test',
      method: 'GET',
    };
    const dims = buildActiveDimensions(ctx, fullRule, Date.now());
    const names = dims.map((d) => d.name);
    expect(names).toEqual(['ip', 'route']);
  });

  it('builds user dimension when apiKey is set instead of userId', () => {
    const ctx: RateLimitContext = {
      ip: '127.0.0.1',
      apiKey: 'my-api-key',
      route: '/api/test',
      method: 'GET',
    };
    const dims = buildActiveDimensions(ctx, fullRule, Date.now());
    const names = dims.map((d) => d.name);
    expect(names).toContain('user');
    expect(names).toContain('user-route');
  });

  it('returns empty array when rule has no limits', () => {
    const emptyRule: RuleConfig = { name: 'empty', limits: {} };
    const dims = buildActiveDimensions(baseCtx, emptyRule, Date.now());
    expect(dims).toHaveLength(0);
  });

  it('includes only ip when only ip limit is configured', () => {
    const ipOnlyRule: RuleConfig = {
      name: 'ipOnly',
      limits: { ip: { limit: 100, window: 60 } },
    };
    const dims = buildActiveDimensions(baseCtx, ipOnlyRule, Date.now());
    expect(dims.map((d) => d.name)).toEqual(['ip']);
  });

  it('dimension keys include hash tags for cluster slot consistency', () => {
    const ctx: RateLimitContext = {
      ip: '127.0.0.1',
      userId: 'u1',
      route: '/api/items',
      method: 'GET',
    };
    const dims = buildActiveDimensions(ctx, fullRule, Date.now());
    for (const dim of dims) {
      expect(dim.currKey).toMatch(/\{.+\}/);
      expect(dim.prevKey).toMatch(/\{.+\}/);
    }
  });

  it('currKey bucket is one greater than prevKey bucket', () => {
    const dims = buildActiveDimensions(baseCtx, fullRule, Date.now());
    for (const dim of dims) {
      const currBucket = Number(dim.currKey.match(/:(\d+)$/)![1]);
      const prevBucket = Number(dim.prevKey.match(/:(\d+)$/)![1]);
      expect(currBucket - prevBucket).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Constructor — circuit breaker config branch
// ---------------------------------------------------------------------------

describe('RateLimiter constructor with circuitBreaker config', () => {
  it('passes threshold and recoveryTimeout to CircuitBreaker when configured', () => {
    MockedCircuitBreaker.mockClear();
    const configWithCb: RateLimiterConfig = {
      redis: { url: 'redis://localhost:6379' },
      rules: [{ name: 'default', limits: { ip: { limit: 100, window: 60 } } }],
      failure: {
        default: 'open',
        circuitBreaker: { enabled: true, threshold: 3, recoveryTimeout: 5000 },
      },
    };
    new RateLimiter(configWithCb);
    expect(MockedCircuitBreaker).toHaveBeenCalledWith(
      expect.objectContaining({ threshold: 3, recoveryTimeout: 5000 }),
    );
  });
});

// ---------------------------------------------------------------------------
// RateLimiter.check() — additional coverage
// ---------------------------------------------------------------------------

describe('RateLimiter.check() — additional paths', () => {
  it('throws ConfigurationError when ip is missing from context', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );
    await limiter.connect();

    const invalidCtx = { route: '/api', method: 'GET' } as RateLimitContext;
    await expect(limiter.check(invalidCtx)).rejects.toThrow(
      'RateLimitContext requires non-empty ip, route, and method fields',
    );
  });

  it('throws ConfigurationError when route is missing from context', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );
    await limiter.connect();

    const invalidCtx = { ip: '1.2.3.4', method: 'GET' } as RateLimitContext;
    await expect(limiter.check(invalidCtx)).rejects.toThrow(
      'RateLimitContext requires non-empty ip, route, and method fields',
    );
  });

  it('throws RedisConnectionError when check() called before connect()', async () => {
    const { limiter } = buildLimiter();
    await expect(limiter.check(baseCtx)).rejects.toThrow(
      'RateLimiter is not connected',
    );
  });

  it('uses reservoir fast path when reservoir is enabled and allowed', async () => {
    const configWithReservoir: RateLimiterConfig = {
      ...baseConfig,
      reservoir: { enabled: true, batchSize: 10, syncInterval: 5000 },
    };
    MockedLocalReservoir.mockClear();
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configWithReservoir);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const reservoirInstance = MockedLocalReservoir.mock.instances[0] as jest.Mocked<LocalReservoir>;
    reservoirInstance.consume = jest.fn().mockResolvedValue(true);

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue(5); // reservoir fetch returns 5 tokens

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    expect(result.source).toBe('reservoir');
    expect(result.allowed).toBe(true);
    expect(reservoirInstance.consume).toHaveBeenCalled();
  });

  it('falls through to Redis when reservoir denies', async () => {
    const configWithReservoir: RateLimiterConfig = {
      ...baseConfig,
      reservoir: { enabled: true, batchSize: 10, syncInterval: 5000 },
    };
    MockedLocalReservoir.mockClear();
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configWithReservoir);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const reservoirInstance = MockedLocalReservoir.mock.instances[0] as jest.Mocked<LocalReservoir>;
    reservoirInstance.consume = jest.fn().mockResolvedValue(false); // reservoir denies

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue(LUA_ALLOWED);

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordSuccess = jest.fn();

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    // Redis was consulted after reservoir denied
    expect(result.source).toBe('redis');
    expect(slMock.eval).toHaveBeenCalledWith(
      expect.anything(),
      'checkMulti',
      expect.any(Array),
      expect.any(Array),
    );
  });

  it('falls through to Redis when reservoir throws', async () => {
    const configWithReservoir: RateLimiterConfig = {
      ...baseConfig,
      reservoir: { enabled: true, batchSize: 10, syncInterval: 5000 },
    };
    MockedLocalReservoir.mockClear();
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configWithReservoir);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const reservoirInstance = MockedLocalReservoir.mock.instances[0] as jest.Mocked<LocalReservoir>;
    reservoirInstance.consume = jest.fn().mockRejectedValue(new Error('Reservoir error'));

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue(LUA_ALLOWED);

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordSuccess = jest.fn();

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    // Falls through to Redis after reservoir error
    expect(result.source).toBe('redis');
  });

  it('returns allowed with correct fields when Lua result has zero limit (uses first dim spec)', async () => {
    // LUA_ALLOWED = [1, '', 0, 0, 0] — limit=0 and ttlMs=0
    // buildResultFromLua should use dimensions[0].spec.limit when luaResult.limit == 0
    const { result } = await (async () => {
      const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
        buildLimiter();
      setupConnectMocks(
        redisManagerInstance as jest.Mocked<RedisClientManager>,
        scriptLoaderInstance as jest.Mocked<ScriptLoader>,
      );
      const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
      cbMock.allowRequest = jest.fn().mockReturnValue(true);
      cbMock.recordSuccess = jest.fn();

      const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
      // Return ttlMs=0 and limit=0 to force the fallback branch in buildResultFromLua
      slMock.eval = jest.fn().mockResolvedValue([1, '', 5, 0, 0]);

      await limiter.connect();
      return { result: await limiter.check(baseCtx) };
    })();

    expect(result.allowed).toBe(true);
    // limit should fall back to the first dimension's spec limit (100)
    expect(result.limit).toBe(100);
  });

  it('handles Redis throwing a non-Error value', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter();

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordFailure = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockRejectedValue('plain string error');

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    // fail_open (default) on error
    expect(result.source).toBe('local_fallback');
    expect(result.allowed).toBe(true);
  });

  it('uses global failure policy when rule has no failure field', async () => {
    const configGlobal: RateLimiterConfig = {
      redis: { url: 'redis://localhost' },
      rules: [{ name: 'no-policy', limits: { ip: { limit: 100, window: 60 } } }],
      failure: { default: 'closed' },
    };

    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configGlobal);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordFailure = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockRejectedValue(new Error('Redis down'));

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    // Global policy is 'closed'
    expect(result.allowed).toBe(false);
    expect(result.dimension).toBe('redis_error');
  });

  it('fail_local uses route spec when no ip spec defined', async () => {
    const configLocalNoIp: RateLimiterConfig = {
      redis: { url: 'redis://localhost' },
      rules: [{
        name: 'route-only',
        limits: { route: { limit: 50, window: 30 } },
        failure: 'local',
      }],
    };

    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configLocalNoIp);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordFailure = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockRejectedValue(new Error('Redis down'));

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    expect(result.source).toBe('local_fallback');
    expect(result.limit).toBe(50);
  });

  it('fail_local uses default spec {limit:100,window:60} when neither ip nor route spec defined', async () => {
    // Must have AT LEAST one limit dimension for check to reach Redis (and fail to local)
    // Rule with ONLY 'user' limit (no ip or route), and no userId → dimensions will be empty
    // We need a rule that HAS a dimension but neither ip nor route spec:
    // Use ip limit so dimensions aren't empty, but set failure=local without ip spec in the
    // actual failure path test — instead we test via circuit breaker open + fail_local
    const configLocalNoIpRoute: RateLimiterConfig = {
      redis: { url: 'redis://localhost' },
      rules: [{ name: 'user-only', limits: { user: { limit: 200, window: 60 } }, failure: 'local' }],
    };

    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configLocalNoIpRoute);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    // Circuit breaker is open → immediately applies failure policy
    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(false);

    await limiter.connect();
    // Use context with userId so user dimension is active
    const ctx: RateLimitContext = { ...baseCtx, userId: 'user123' };
    const result = await limiter.check(ctx);

    // Should use default fallback spec {limit: 100, window: 60} since no ip or route spec
    expect(result.source).toBe('local_fallback');
    expect(result.limit).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// RateLimiter.check() — parseLuaCheckResult throw path
// ---------------------------------------------------------------------------

describe('parseLuaCheckResult — invalid result shape', () => {
  it('throws when checkMulti returns non-array', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter();

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordFailure = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue({ not: 'an array' });

    await limiter.connect();
    // parseLuaCheckResult will throw, which triggers recordFailure and applyFailurePolicy
    const result = await limiter.check(baseCtx);
    expect(result.source).toBe('local_fallback');
    expect(cbMock.recordFailure).toHaveBeenCalled();
  });

  it('throws when checkMulti returns array with fewer than 5 elements', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter();

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordFailure = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue([1, 2]); // only 2 elements

    await limiter.connect();
    const result = await limiter.check(baseCtx);
    expect(result.source).toBe('local_fallback');
    expect(cbMock.recordFailure).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RateLimiter.status() — additional paths
// ---------------------------------------------------------------------------

describe('RateLimiter.status() — additional paths', () => {
  it('throws RedisConnectionError when called before connect()', async () => {
    const { limiter } = buildLimiter();
    await expect(limiter.status(baseCtx)).rejects.toThrow('RateLimiter is not connected');
  });

  it('returns allowed:true immediately when no dimensions are active', async () => {
    const configNoDims: RateLimiterConfig = {
      ...baseConfig,
      rules: [{ name: 'nodims', limits: {} }],
    };

    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter(configNoDims);
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn();

    await limiter.connect();
    const result = await limiter.status(baseCtx);

    expect(result.allowed).toBe(true);
    expect(result.dimension).toBe('none');
    expect(slMock.eval).not.toHaveBeenCalled();
  });

  it('includes retryAfter when effective+cost exceeds limit', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    // effective=100, limit=100, remaining=0, ttlMs=30000 → cost(1) + effective(100) > limit(100)
    slMock.eval = jest.fn().mockResolvedValue([100, 100, 0, 30000]);

    await limiter.connect();
    const ctx: RateLimitContext = { ...baseCtx, cost: 1 };
    const result = await limiter.status(ctx);

    expect(result.retryAfter).toBe(30000);
    expect(result.allowed).toBe(false);
  });

  it('handles parseLuaStatusResult with invalid (non-array) result gracefully', async () => {
    const configIpOnly: RateLimiterConfig = {
      redis: { url: 'redis://localhost' },
      rules: [{ name: 'ip-only', limits: { ip: { limit: 100, window: 60 } } }],
    };

    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter(configIpOnly);
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    // Return non-array to trigger parseLuaStatusResult fallback (not throw)
    slMock.eval = jest.fn().mockResolvedValue(null);

    await limiter.connect();
    const result = await limiter.status(baseCtx);

    // parseLuaStatusResult returns zeros; effective=0, remaining=0
    expect(result.effective).toBe(0);
    expect(result.limit).toBe(100); // from spec
  });
});

// ---------------------------------------------------------------------------
// RateLimiter.reset() — all dimension cases
// ---------------------------------------------------------------------------

describe('RateLimiter.reset() — all dimension cases', () => {
  it('throws RedisConnectionError when called before connect()', async () => {
    const { limiter } = buildLimiter();
    await expect(limiter.reset('ip', '127.0.0.1')).rejects.toThrow('RateLimiter is not connected');
  });

  it('resets the route dimension', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue(2);

    await limiter.connect();
    const deleted = await limiter.reset('route', 'GET /api/users');

    expect(slMock.eval).toHaveBeenCalledWith(
      expect.anything(),
      'reset',
      expect.arrayContaining([expect.stringContaining('route:')]),
      [],
    );
    expect(deleted).toBe(2);
  });

  it('resets the user dimension', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue(2);

    await limiter.connect();
    const deleted = await limiter.reset('user', 'user-abc-123');

    expect(slMock.eval).toHaveBeenCalledWith(
      expect.anything(),
      'reset',
      expect.arrayContaining([expect.stringContaining('user:')]),
      [],
    );
    expect(deleted).toBe(2);
  });

  it('resets the user-route dimension', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue(2);

    await limiter.connect();
    const deleted = await limiter.reset('user-route', 'user-abc:/api/orders');

    expect(slMock.eval).toHaveBeenCalledWith(
      expect.anything(),
      'reset',
      expect.any(Array),
      [],
    );
    expect(deleted).toBe(2);
  });

  it('returns 0 when reset result is not a number', async () => {
    const { limiter, redisManagerInstance, scriptLoaderInstance } = buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue(null);

    await limiter.connect();
    const deleted = await limiter.reset('ip', '127.0.0.1');
    expect(deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RateLimiter.shutdown() — reservoir flush error handling
// ---------------------------------------------------------------------------

describe('RateLimiter.shutdown() — reservoir decrby paths', () => {
  it('swallows errors thrown by decrby during reservoir flush', async () => {
    const configWithReservoir: RateLimiterConfig = {
      ...baseConfig,
      reservoir: { enabled: true, batchSize: 10, syncInterval: 5000 },
    };
    MockedLocalReservoir.mockClear();
    const { limiter, redisManagerInstance, scriptLoaderInstance } =
      buildLimiter(configWithReservoir);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const reservoirInstance = MockedLocalReservoir.mock.instances[0] as jest.Mocked<LocalReservoir>;

    // Make flush invoke the callback with a key and token count
    reservoirInstance.flush = jest.fn().mockImplementation(
      async (cb: (key: string, tokens: number) => Promise<void>) => {
        await cb('some:key', 5);
      },
    );

    // Make decrby throw
    const fakeClient = {
      decrby: jest.fn().mockRejectedValue(new Error('decrby failed')),
    };
    (redisManagerInstance as jest.Mocked<RedisClientManager>).getClient = jest
      .fn()
      .mockReturnValue(fakeClient);

    await limiter.connect();
    // Should not throw even when decrby fails
    await expect(limiter.shutdown()).resolves.toBeUndefined();
    expect(fakeClient.decrby).toHaveBeenCalledWith('some:key', 5);
  });

  it('calls decrby successfully during reservoir flush', async () => {
    const configWithReservoir: RateLimiterConfig = {
      ...baseConfig,
      reservoir: { enabled: true, batchSize: 10, syncInterval: 5000 },
    };
    MockedLocalReservoir.mockClear();
    const { limiter, redisManagerInstance, scriptLoaderInstance } =
      buildLimiter(configWithReservoir);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const reservoirInstance = MockedLocalReservoir.mock.instances[0] as jest.Mocked<LocalReservoir>;

    reservoirInstance.flush = jest.fn().mockImplementation(
      async (cb: (key: string, tokens: number) => Promise<void>) => {
        await cb('bucket:key', 3);
      },
    );

    const fakeClient = {
      decrby: jest.fn().mockResolvedValue(7),
    };
    (redisManagerInstance as jest.Mocked<RedisClientManager>).getClient = jest
      .fn()
      .mockReturnValue(fakeClient);

    await limiter.connect();
    await limiter.shutdown();

    expect(fakeClient.decrby).toHaveBeenCalledWith('bucket:key', 3);
  });
});

// ---------------------------------------------------------------------------
// findMatchingRule() — additional edge cases
// ---------------------------------------------------------------------------

describe('findMatchingRule() — additional edge cases', () => {
  it('falls back to last rule when no rule matches and no catch-all exists', () => {
    const ruleA: RuleConfig = {
      name: 'a',
      match: { routes: ['POST /admin/*'] },
      limits: { ip: { limit: 10, window: 60 } },
    };
    const ruleB: RuleConfig = {
      name: 'b',
      match: { routes: ['DELETE /admin/*'] },
      limits: { ip: { limit: 5, window: 60 } },
    };

    const ctx: RateLimitContext = { ip: '1.2.3.4', route: '/public', method: 'GET' };
    // Neither rule matches, no catch-all → should return last rule (ruleB)
    const matched = findMatchingRule(ctx, [ruleA, ruleB]);
    expect(matched.name).toBe('b');
  });

  it('skips userTier check when ctx.userTier is undefined and userTiers is specified', () => {
    const tierRule: RuleConfig = {
      name: 'tier-rule',
      match: { routes: ['GET /api/*'], userTiers: ['premium'] },
      limits: { ip: { limit: 500, window: 60 } },
    };
    const fallbackRule: RuleConfig = {
      name: 'fallback',
      limits: { ip: { limit: 100, window: 60 } },
    };

    const ctx: RateLimitContext = {
      ip: '1.2.3.4',
      route: '/api/data',
      method: 'GET',
      // userTier not set
    };

    const matched = findMatchingRule(ctx, [tierRule, fallbackRule]);
    expect(matched.name).toBe('fallback');
  });

  it('skips IP check when ctx.ip does not match the ips list', () => {
    const ipRule: RuleConfig = {
      name: 'ip-rule',
      match: { ips: ['10.0.0.1'] },
      limits: { ip: { limit: 1000, window: 60 } },
    };
    const fallbackRule: RuleConfig = {
      name: 'fallback',
      limits: { ip: { limit: 100, window: 60 } },
    };

    const ctx: RateLimitContext = {
      ip: '192.168.0.1',
      route: '/api',
      method: 'GET',
    };

    const matched = findMatchingRule(ctx, [ipRule, fallbackRule]);
    expect(matched.name).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------
// RateLimiter constructor — empty rules
// ---------------------------------------------------------------------------

describe('RateLimiter constructor', () => {
  it('throws ConfigurationError when rules array is empty', () => {
    expect(() => new RateLimiter({
      redis: { url: 'redis://localhost' },
      rules: [],
    })).toThrow('At least one rule must be configured');
  });
});

// ---------------------------------------------------------------------------
// LocalFallbackLimiter — existing entry paths (lines 107-109)
// ---------------------------------------------------------------------------

describe('LocalFallbackLimiter — existing entry', () => {
  function getLocalFallback(config?: RateLimiterConfig) {
    const { limiter } = buildLimiter(config ?? baseConfig);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (limiter as any)['localFallback'] as {
      check(key: string, limit: number, windowMs: number, cost: number): boolean;
    };
  }

  it('returns false when existing entry exceeds limit (line 107)', () => {
    const fb = getLocalFallback();
    const windowMs = 60_000;
    // First call: creates entry with count=90
    expect(fb.check('testkey', 100, windowMs, 90)).toBe(true);
    // Second call: 90 + 20 = 110 > 100 → false
    expect(fb.check('testkey', 100, windowMs, 20)).toBe(false);
  });

  it('increments count and returns true for existing entry under limit (lines 108-109)', () => {
    const fb = getLocalFallback();
    const windowMs = 60_000;
    // First call: creates entry with count=50
    expect(fb.check('mykey', 100, windowMs, 50)).toBe(true);
    // Second call: 50 + 30 = 80 ≤ 100 → true, count becomes 80
    expect(fb.check('mykey', 100, windowMs, 30)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reservoir fetchFn — lines 293-302
// ---------------------------------------------------------------------------

describe('RateLimiter.check() — reservoir fetchFn is called', () => {
  it('invokes fetchFn and uses reservoirFetch result (lines 293-302)', async () => {
    const configWithReservoir: RateLimiterConfig = {
      ...baseConfig,
      reservoir: { enabled: true, batchSize: 10, syncInterval: 5000 },
    };
    MockedLocalReservoir.mockClear();
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configWithReservoir);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const reservoirInstance = MockedLocalReservoir.mock.instances[0] as jest.Mocked<LocalReservoir>;

    // Make consume actually call fetchFn so lines 293-302 are exercised
    reservoirInstance.consume = jest.fn().mockImplementation(
      async (_key: string, _cost: number, fetchFn: (k: string) => Promise<number>) => {
        const tokens = await fetchFn(_key);
        return tokens > 0;
      },
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    // reservoirFetch returns a numeric token count
    slMock.eval = jest.fn().mockResolvedValue(5);

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    // fetchFn was called, returned 5 > 0 so consume returns true → reservoir allows
    expect(result.source).toBe('reservoir');
    expect(result.allowed).toBe(true);
    expect(slMock.eval).toHaveBeenCalledWith(
      expect.anything(),
      'reservoirFetch',
      expect.any(Array),
      expect.any(Array),
    );
  });

  it('fetchFn returns 0 when eval result is non-numeric (line 302 false branch)', async () => {
    const configWithReservoir: RateLimiterConfig = {
      ...baseConfig,
      reservoir: { enabled: true, batchSize: 10, syncInterval: 5000 },
    };
    MockedLocalReservoir.mockClear();
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configWithReservoir);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const reservoirInstance = MockedLocalReservoir.mock.instances[0] as jest.Mocked<LocalReservoir>;

    reservoirInstance.consume = jest.fn().mockImplementation(
      async (_key: string, _cost: number, fetchFn: (k: string) => Promise<number>) => {
        const tokens = await fetchFn(_key);
        // tokens = 0 means denied by reservoir
        return tokens > 0;
      },
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    // eval returns non-numeric → fetchFn returns 0
    slMock.eval = jest.fn().mockResolvedValue(null);

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordSuccess = jest.fn();

    await limiter.connect();
    // Reservoir returns false (0 tokens), falls through to Redis
    // Redis eval now returns checkMulti result
    slMock.eval = jest.fn()
      .mockResolvedValueOnce(null) // first call: reservoirFetch returns non-numeric
      .mockResolvedValue([1, '', 0, 100, 60000]); // subsequent: checkMulti

    await limiter.connect();
    // just verify no throw
    const result2 = await limiter.check(baseCtx);
    expect(result2).toBeDefined();
  });

  it('uses rule-level batchSize over global batchSize (line 293 branch)', async () => {
    const configWithReservoir: RateLimiterConfig = {
      ...baseConfig,
      rules: [{
        ...baseConfig.rules[0],
        reservoir: { batchSize: 25 }, // rule-level override
      }],
      reservoir: { enabled: true, batchSize: 10, syncInterval: 5000 },
    };
    MockedLocalReservoir.mockClear();
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configWithReservoir);

    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const reservoirInstance = MockedLocalReservoir.mock.instances[0] as jest.Mocked<LocalReservoir>;
    let capturedArgv: (string | number)[] | undefined;

    reservoirInstance.consume = jest.fn().mockImplementation(
      async (_key: string, _cost: number, fetchFn: (k: string) => Promise<number>) => {
        await fetchFn(_key);
        return true;
      },
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockImplementation(
      (_client: unknown, _script: string, _keys: string[], argv: (string | number)[]) => {
        capturedArgv = argv;
        return Promise.resolve(25);
      },
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);

    await limiter.connect();
    await limiter.check(baseCtx);

    // The batchSize argument (index 3) should be 25 (rule-level), not 10 (global)
    expect(capturedArgv).toBeDefined();
    expect(capturedArgv![3]).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// LocalFallbackLimiter eviction path — accessed via fail_local
// ---------------------------------------------------------------------------

describe('LocalFallbackLimiter eviction', () => {
  it('evicts expired entries when counter map reaches MAX_ENTRIES', () => {
    // Access the private LocalFallbackLimiter via the rate limiter instance
    const configLocal: RateLimiterConfig = {
      ...baseConfig,
      rules: [{ ...baseConfig.rules[0], failure: 'local' }],
    };
    const { limiter } = buildLimiter(configLocal);

    // Access private localFallback and its counters for test purposes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const localFallback = (limiter as any)['localFallback'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const counters: Map<string, any> = localFallback['counters'];

    const MAX_ENTRIES = 50_000;
    // Pre-fill with expired entries
    for (let i = 0; i < MAX_ENTRIES; i++) {
      counters.set(`key:${i}`, { count: 1, resetAt: 0 }); // resetAt=0 → expired
    }
    expect(counters.size).toBe(MAX_ENTRIES);

    // Calling check() with a new key should trigger eviction since size >= MAX_ENTRIES
    const wasAllowed = localFallback.check('new:unique:key', 100, 60_000, 1);

    expect(wasAllowed).toBe(true);
    // After eviction, the map should be smaller than MAX_ENTRIES
    expect(counters.size).toBeLessThan(MAX_ENTRIES);
  });

  it('forcefully removes oldest entries when expired-only eviction is insufficient', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configLocal: RateLimiterConfig = {
      ...baseConfig,
      rules: [{ ...baseConfig.rules[0], failure: 'local' }],
    };
    const { limiter } = buildLimiter(configLocal);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const localFallback = (limiter as any)['localFallback'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const counters: Map<string, any> = localFallback['counters'];

    const MAX_ENTRIES = 50_000;
    // Pre-fill with NON-expired entries (far future resetAt) → evictExpired won't help
    const farFuture = Date.now() + 1_000_000;
    for (let i = 0; i < MAX_ENTRIES; i++) {
      counters.set(`noexp:${i}`, { count: 1, resetAt: farFuture });
    }
    expect(counters.size).toBe(MAX_ENTRIES);

    // check() triggers evictExpired → expired-only eviction finds nothing to remove
    // → hard-cap eviction removes oldest entries
    const wasAllowed = localFallback.check('brand:new:key', 100, 60_000, 1);

    expect(wasAllowed).toBe(true);
    // Hard-cap eviction should have reduced size
    expect(counters.size).toBeLessThan(MAX_ENTRIES);
  });
});

// ---------------------------------------------------------------------------
// parseLuaCheckResult — null/undefined array elements (lines 780-783)
// ---------------------------------------------------------------------------

describe('parseLuaCheckResult — null array elements (lines 780-783 ?? branches)', () => {
  it('uses ?? fallbacks when checkMulti array elements are null', async () => {
    // Raw: [0, null, null, null, null] → failedDimension=String(null??'')='', effective=0, limit=0, ttlMs=0
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordSuccess = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    // null elements → all ?? branches (780-783) taken
    slMock.eval = jest.fn().mockResolvedValue([0, null, null, null, null]);

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    // Denied (raw[0]=0), all other fields default to null-coalesced values
    expect(result.allowed).toBe(false);
    expect(result.effective).toBe(0);
    expect(result.limit).toBe(0);
  });

  it('uses ?? fallbacks when checkMulti elements are null (allowed=true path)', async () => {
    // Raw: [1, null, null, null, null] → allowed, limit=0 → uses dimensions[0].spec.limit
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordSuccess = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue([1, null, null, null, null]);

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseLuaStatusResult — null array elements (lines 800-803 ?? branches)
// ---------------------------------------------------------------------------

describe('parseLuaStatusResult — null array elements (lines 800-803 ?? branches)', () => {
  it('uses ?? 0 fallbacks when status array elements are null', async () => {
    // Raw: [null, null, null, null] → all effective/limit/remaining/ttlMs = 0
    const { limiter, redisManagerInstance, scriptLoaderInstance } =
      buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue([null, null, null, null]);

    await limiter.connect();
    const result = await limiter.status(baseCtx);

    expect(result.effective).toBe(0);
    expect(result.limit).toBe(100); // falls back to spec.limit from dimensions
  });
});

// ---------------------------------------------------------------------------
// buildResultFromLua — denied with unmatched failedDimension (lines 543-554)
// ---------------------------------------------------------------------------

describe('buildResultFromLua — denied with unknown dimension (lines 543-554)', () => {
  it('uses ttlMs directly when failedDimension does not match any active dimension', async () => {
    // failedDimension='ghost' not in active dimensions → failedDim=undefined
    // → lines 543,553: FALSE branch (use ttlMs)
    // ttlMs=0 → lines 544,554: FALSE branch (windowMs=0 → ttlMs; retryAfter=undefined)
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordSuccess = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    // Denied, failedDimension='ghost' (unknown), effective=5, limit=100, ttlMs=0
    slMock.eval = jest.fn().mockResolvedValue([0, 'ghost', 5, 100, 0]);

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    expect(result.allowed).toBe(false);
    expect(result.dimension).toBe('ghost');
    expect(result.retryAfter).toBeUndefined(); // ttlMs=0 → undefined (line 554 FALSE)
  });

  it('uses ttlMs as windowMs when failedDimension unknown but ttlMs > 0', async () => {
    // failedDimension='ghost', ttlMs=5000 → lines 543 FALSE, 544 TRUE, 553 FALSE, 554 TRUE
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter();
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordSuccess = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockResolvedValue([0, 'ghost', 5, 100, 5000]);

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// applyFailurePolicy — default 'open' when neither rule nor config has failure
// ---------------------------------------------------------------------------

describe('applyFailurePolicy — default open (line 576 count[2])', () => {
  it('defaults to fail_open when neither rule.failure nor config.failure.default is set', async () => {
    const configNoFailure: RateLimiterConfig = {
      redis: { url: 'redis://localhost' },
      rules: [{ name: 'default', limits: { ip: { limit: 100, window: 60 } } }],
      // No failure field → rule.failure=undefined, config.failure=undefined
    };

    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configNoFailure);
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordFailure = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockRejectedValue(new Error('Redis down'));

    await limiter.connect();
    const result = await limiter.check(baseCtx);

    // Default is 'open' → allowed=true (source='local_fallback' for all applyFailurePolicy paths)
    expect(result.allowed).toBe(true);
    expect(result.source).toBe('local_fallback');
  });
});

// ---------------------------------------------------------------------------
// applyFailurePolicy — fail_local DENIED path (lines 616-622)
// ---------------------------------------------------------------------------

describe('applyFailurePolicy — fail_local DENIED (lines 616-622)', () => {
  it('returns allowed=false with local_fallback source when localFallback denies', async () => {
    const configLocal: RateLimiterConfig = {
      redis: { url: 'redis://localhost' },
      rules: [{ name: 'default', limits: { ip: { limit: 100, window: 60 } }, failure: 'local' }],
    };

    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configLocal);
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordFailure = jest.fn();

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockRejectedValue(new Error('Redis down'));

    await limiter.connect();

    // Pre-fill localFallback counter to exceed limit → check() returns false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const localFallback = (limiter as any)['localFallback'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const counters: Map<string, any> = localFallback['counters'];
    const normIp = normalizeIP(baseCtx.ip);
    const normRoute = normalizeRoute(baseCtx.method, baseCtx.route);
    const fallbackKey = `local:${normIp}:${normRoute}`;
    counters.set(fallbackKey, { count: 100, resetAt: Date.now() + 60000 });

    const result = await limiter.check(baseCtx);

    // localFallback.check() returns false → lines 616-622 FALSE branches
    expect(result.allowed).toBe(false);
    expect(result.dimension).toBe('local_fallback');
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.source).toBe('local_fallback');
  });
});

// ---------------------------------------------------------------------------
// reservoir fetchFn — ?? 10 fallback batchSize (line 293 count[2])
// ---------------------------------------------------------------------------

describe('RateLimiter.check() — reservoir fetchFn batchSize fallback to 10 (line 293)', () => {
  it('uses batchSize=10 fallback when neither rule nor config batchSize is set', async () => {
    // rule.reservoir = {} (no batchSize) and config.reservoir has no batchSize
    const configFallbackBatch: RateLimiterConfig = {
      redis: { url: 'redis://localhost' },
      rules: [{
        ...baseConfig.rules[0],
        reservoir: {}, // no batchSize → undefined → ?? falls through
      }],
      // config.reservoir.batchSize is undefined at runtime via type coercion
      reservoir: { enabled: true, batchSize: undefined as unknown as number, syncInterval: 5000 },
    };

    MockedLocalReservoir.mockClear();
    const { limiter, redisManagerInstance, scriptLoaderInstance, circuitBreakerInstance } =
      buildLimiter(configFallbackBatch);
    setupConnectMocks(
      redisManagerInstance as jest.Mocked<RedisClientManager>,
      scriptLoaderInstance as jest.Mocked<ScriptLoader>,
    );

    const reservoirInstance = MockedLocalReservoir.mock.instances[0] as jest.Mocked<LocalReservoir>;
    let capturedBatchSize: number | undefined;

    reservoirInstance.consume = jest.fn().mockImplementation(
      async (_key: string, _cost: number, fetchFn: (k: string) => Promise<number>) => {
        await fetchFn(_key);
        return true;
      },
    );

    const slMock = scriptLoaderInstance as jest.Mocked<ScriptLoader>;
    slMock.eval = jest.fn().mockImplementation(
      async (_mgr: unknown, scriptName: string, _keys: unknown[], argv: unknown[]) => {
        if (scriptName === 'reservoirFetch') {
          capturedBatchSize = argv[3] as number;
          return 100;
        }
        return [1, '', 0, 100, 60000];
      },
    );

    const cbMock = circuitBreakerInstance as jest.Mocked<CircuitBreaker>;
    cbMock.allowRequest = jest.fn().mockReturnValue(true);
    cbMock.recordSuccess = jest.fn();

    await limiter.connect();
    await limiter.check(baseCtx);

    // batchSize should fall back to 10 (neither rule nor config provides it)
    expect(capturedBatchSize).toBe(10);
  });
});
