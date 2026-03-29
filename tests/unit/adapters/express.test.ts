/**
 * @fileoverview Unit tests for the Express middleware adapter.
 * RateLimiter is mocked — no real Redis calls are made.
 */

import {
  createExpressMiddleware,
  extractIPFromRequest,
  extractUserFromRequest,
  buildRateLimitHeaders,
  ExpressAdapterConfig,
} from '../../../src/adapters/express';
import { RateLimiter } from '../../../src/rate-limiter';
import { RateLimitResult } from '../../../src/core/types';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../../src/redis/client');
jest.mock('../../../src/redis/script-loader');
jest.mock('../../../src/redis/circuit-breaker');
jest.mock('../../../src/reservoir/local-reservoir');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAllowedResult(overrides: Partial<RateLimitResult> = {}): RateLimitResult {
  return {
    allowed: true,
    dimension: 'none',
    effective: 10,
    limit: 100,
    remaining: 90,
    resetAt: 1711670400000, // some fixed epoch ms
    source: 'redis',
    ...overrides,
  };
}

function makeDeniedResult(overrides: Partial<RateLimitResult> = {}): RateLimitResult {
  return {
    allowed: false,
    dimension: 'ip',
    effective: 100,
    limit: 100,
    remaining: 0,
    resetAt: 1711670400000,
    retryAfter: 30000,
    source: 'redis',
    ...overrides,
  };
}

/** Builds a minimal mock Request. */
function makeRequest(overrides: {
  method?: string;
  path?: string;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
} = {}): {
  method: string;
  path: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
} {
  return {
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/api/test',
    ip: overrides.ip,
    headers: overrides.headers ?? {},
    query: {},
  };
}

/** Builds a mock Response with jest spy methods. */
function makeResponse(): {
  status: jest.Mock;
  json: jest.Mock;
  set: jest.Mock;
  getHeader: jest.Mock;
} {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    getHeader: jest.fn(),
  };
  return res;
}

/** Creates a mock RateLimiter with a controllable `check` method. */
function makeMockRateLimiter(result: RateLimitResult): jest.Mocked<RateLimiter> {
  return {
    check: jest.fn().mockResolvedValue(result),
    connect: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
  } as unknown as jest.Mocked<RateLimiter>;
}

// ---------------------------------------------------------------------------
// createExpressMiddleware — core behaviour
// ---------------------------------------------------------------------------

describe('createExpressMiddleware', () => {
  it('calls rateLimiter.check() with the correct RateLimitContext', async () => {
    const mockLimiter = makeMockRateLimiter(makeAllowedResult());
    const middleware = createExpressMiddleware({ rateLimiter: mockLimiter });
    const req = makeRequest({
      method: 'POST',
      path: '/api/orders',
      ip: '1.2.3.4',
      headers: { 'x-api-key': 'secret-key' },
    });
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(mockLimiter.check).toHaveBeenCalledTimes(1);
    const ctx = (mockLimiter.check as jest.Mock).mock.calls[0][0];
    expect(ctx.ip).toBe('1.2.3.4');
    expect(ctx.route).toBe('/api/orders');
    expect(ctx.method).toBe('POST');
  });

  it('calls next() and sets X-RateLimit-* headers when the request is allowed', async () => {
    const result = makeAllowedResult({ limit: 100, remaining: 90, resetAt: 1711670400000 });
    const mockLimiter = makeMockRateLimiter(result);
    const middleware = createExpressMiddleware({ rateLimiter: mockLimiter });
    const req = makeRequest({ ip: '5.6.7.8' });
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(); // called with no args
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'X-RateLimit-Limit': '100',
        'X-RateLimit-Remaining': '90',
      }),
    );
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 429 and sets Retry-After header when the request is denied', async () => {
    const result = makeDeniedResult({ retryAfter: 30000 });
    const mockLimiter = makeMockRateLimiter(result);
    const middleware = createExpressMiddleware({ rateLimiter: mockLimiter });
    const req = makeRequest({ ip: '9.9.9.9' });
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Too Many Requests', retryAfter: 30000 }),
    );
    // Retry-After should be set as seconds (ceil of ms/1000)
    const setCalls: Array<unknown[]> = (res.set as jest.Mock).mock.calls;
    const retryAfterCall = setCalls.find(
      (args) => typeof args[0] === 'string' && args[0] === 'Retry-After',
    );
    expect(retryAfterCall).toBeDefined();
    expect(retryAfterCall![1]).toBe('30'); // 30000ms → 30s
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next(err) when rateLimiter.check() throws', async () => {
    const error = new Error('Redis unavailable');
    const mockLimiter = {
      check: jest.fn().mockRejectedValue(error),
    } as unknown as jest.Mocked<RateLimiter>;
    const middleware = createExpressMiddleware({ rateLimiter: mockLimiter });
    const req = makeRequest();
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('does not set headers when setHeaders is false', async () => {
    const mockLimiter = makeMockRateLimiter(makeAllowedResult());
    const middleware = createExpressMiddleware({
      rateLimiter: mockLimiter,
      setHeaders: false,
    });
    const req = makeRequest();
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.set).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('includes userTier in context when getUserTier callback is provided', async () => {
    const mockLimiter = makeMockRateLimiter(makeAllowedResult());
    const middleware = createExpressMiddleware({
      rateLimiter: mockLimiter,
      getUserTier: () => 'pro',
    });
    const req = makeRequest();
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);

    const ctx = (mockLimiter.check as jest.Mock).mock.calls[0][0];
    expect(ctx.userTier).toBe('pro');
  });

  it('skips rate limiting and calls next() when the route matches a skipRoutes pattern', async () => {
    const mockLimiter = makeMockRateLimiter(makeAllowedResult());
    const middleware = createExpressMiddleware({
      rateLimiter: mockLimiter,
      skipRoutes: ['/health', '/metrics'],
    });
    const req = makeRequest({ path: '/health' });
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);

    // Should skip rate limiting — check() is never called
    expect(mockLimiter.check).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('applies rate limiting when route does NOT match skipRoutes pattern', async () => {
    const mockLimiter = makeMockRateLimiter(makeAllowedResult());
    const middleware = createExpressMiddleware({
      rateLimiter: mockLimiter,
      skipRoutes: ['/health'],
    });
    const req = makeRequest({ path: '/api/users' });
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);

    // Not a skipped route — check() SHOULD be called
    expect(mockLimiter.check).toHaveBeenCalledTimes(1);
  });

  it('skips rate limiting for glob patterns in skipRoutes', async () => {
    const mockLimiter = makeMockRateLimiter(makeAllowedResult());
    const middleware = createExpressMiddleware({
      rateLimiter: mockLimiter,
      skipRoutes: ['/internal/*'],
    });
    const req = makeRequest({ path: '/internal/admin' });
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(mockLimiter.check).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// extractIPFromRequest
// ---------------------------------------------------------------------------

describe('extractIPFromRequest', () => {
  it('returns req.ip when set', () => {
    const req = makeRequest({ ip: '1.2.3.4' });
    expect(extractIPFromRequest(req)).toBe('1.2.3.4');
  });

  it('falls back to X-Real-IP header when req.ip is absent', () => {
    const req = makeRequest({ headers: { 'x-real-ip': '5.5.5.5' } });
    expect(extractIPFromRequest(req)).toBe('5.5.5.5');
  });

  it('falls back to X-Forwarded-For when req.ip and X-Real-IP are absent', () => {
    const req = makeRequest({
      headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
    });
    const ip = extractIPFromRequest(req, {
      trustXForwardedFor: true,
      trustedProxyCount: 0,
    });
    // With 0 trusted proxies, take the last entry
    expect(ip).toBe('10.0.0.2');
  });

  it('respects trustedProxyCount when parsing X-Forwarded-For', () => {
    // XFF: client, proxy1, proxy2  — trustedProxyCount=1 → second-to-last = proxy1 addr
    // client IP is at index: length - trustedProxyCount - 1 = 3 - 1 - 1 = 1
    const req = makeRequest({
      headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1, 10.0.0.2' },
    });
    const ip = extractIPFromRequest(req, {
      trustXForwardedFor: true,
      trustedProxyCount: 1,
    });
    expect(ip).toBe('10.0.0.1');
  });

  it('returns 0.0.0.0 when no IP can be determined', () => {
    const req = makeRequest();
    expect(extractIPFromRequest(req)).toBe('0.0.0.0');
  });

  it('uses the first value when X-Real-IP is an array', () => {
    const req = makeRequest({ headers: { 'x-real-ip': ['7.7.7.7', '8.8.8.8'] } });
    expect(extractIPFromRequest(req)).toBe('7.7.7.7');
  });

  it('falls back to 0.0.0.0 when X-Forwarded-For is empty array (hits ?? "" branch)', () => {
    // getFirstHeaderValue([]) returns undefined → xff = '' → trim().length === 0
    const req = makeRequest({ headers: { 'x-forwarded-for': [] as unknown as string[] } });
    expect(extractIPFromRequest(req)).toBe('0.0.0.0');
  });

  it('uses default trustXForwardedFor=true when no config is provided (hits ?? true branch)', () => {
    // Calling extractIPFromRequest without config → config is undefined
    // config?.trustXForwardedFor ?? true → true
    const req = makeRequest({
      headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.2' },
    });
    // With no config, trustedProxyCount defaults to 0 and trustXFF defaults to true
    // So it parses XFF normally, taking last entry: 10.0.0.2
    const ip = extractIPFromRequest(req); // no config passed
    expect(ip).toBe('10.0.0.2');
  });

  it('uses default trustedProxyCount=0 when not set in config (hits ?? 0 branch)', () => {
    // Passing partial config without trustedProxyCount (cast to any to bypass TS strict)
    const req = makeRequest({
      headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.2' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ip = extractIPFromRequest(req, { trustXForwardedFor: true } as any);
    // trustedProxyCount defaults to 0 → index = length - 0 - 1 = 1 → '10.0.0.2'
    expect(ip).toBe('10.0.0.2');
  });

  it('returns 0.0.0.0 when trustXForwardedFor is false (hits if(trustXFF) false branch)', () => {
    const req = makeRequest({
      headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.2' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ip = extractIPFromRequest(req, { trustXForwardedFor: false } as any);
    // trustXFF = false → the if block is skipped, no IP extracted from XFF
    expect(ip).toBe('0.0.0.0');
  });
});

// ---------------------------------------------------------------------------
// extractUserFromRequest
// ---------------------------------------------------------------------------

describe('extractUserFromRequest', () => {
  it('extracts raw apiKey from Authorization Bearer header (hashing owned by core)', () => {
    const req = makeRequest({
      headers: { authorization: 'Bearer my-secret-token' },
    });
    const { apiKey, userId } = extractUserFromRequest(req);
    expect(apiKey).toBe('my-secret-token');
    expect(userId).toBeUndefined();
  });

  it('returns raw token regardless of hashIdentifiers config', () => {
    const req = makeRequest({
      headers: { authorization: 'Bearer raw-token' },
    });
    const { apiKey } = extractUserFromRequest(req, { hashIdentifiers: false });
    expect(apiKey).toBe('raw-token');
  });

  it('extracts raw apiKey from X-API-Key header (hashing owned by core)', () => {
    const req = makeRequest({
      headers: { 'x-api-key': 'api-key-value' },
    });
    const { apiKey, userId } = extractUserFromRequest(req);
    expect(apiKey).toBe('api-key-value');
    expect(userId).toBeUndefined();
  });

  it('returns empty object when no identity headers are present', () => {
    const req = makeRequest();
    const result = extractUserFromRequest(req);
    expect(result.apiKey).toBeUndefined();
    expect(result.userId).toBeUndefined();
  });

  it('uses a custom apiKeyHeader when configured', () => {
    const req = makeRequest({
      headers: { 'x-custom-key': 'custom-value' },
    });
    const { apiKey } = extractUserFromRequest(req, {
      apiKeyHeader: 'x-custom-key',
      hashIdentifiers: false,
    });
    expect(apiKey).toBe('custom-value');
  });

  it('ignores Authorization header that is not a Bearer scheme', () => {
    const req = makeRequest({
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    const result = extractUserFromRequest(req);
    expect(result.apiKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildRateLimitHeaders
// ---------------------------------------------------------------------------

describe('buildRateLimitHeaders', () => {
  it('produces the correct set of X-RateLimit-* headers', () => {
    const result = makeAllowedResult({
      limit: 200,
      remaining: 150,
      resetAt: 1711670460000, // 1711670460 seconds
    });
    const headers = buildRateLimitHeaders(result);

    expect(headers['X-RateLimit-Limit']).toBe('200');
    expect(headers['X-RateLimit-Remaining']).toBe('150');
    expect(headers['X-RateLimit-Reset']).toBe('1711670460');
    expect(headers['X-RateLimit-Policy']).toBe('200;w=60');
  });

  it('clamps X-RateLimit-Remaining to 0 when remaining is negative', () => {
    const result = makeAllowedResult({ remaining: -5 });
    const headers = buildRateLimitHeaders(result);
    expect(headers['X-RateLimit-Remaining']).toBe('0');
  });

  it('returns string values for all headers (not numbers)', () => {
    const result = makeAllowedResult();
    const headers = buildRateLimitHeaders(result);
    Object.values(headers).forEach((value) => {
      expect(typeof value).toBe('string');
    });
  });

  it('rounds up fractional reset seconds via Math.ceil', () => {
    const result = makeAllowedResult({ resetAt: 1711670400500 }); // 500ms past second
    const headers = buildRateLimitHeaders(result);
    expect(headers['X-RateLimit-Reset']).toBe('1711670401');
  });
});
