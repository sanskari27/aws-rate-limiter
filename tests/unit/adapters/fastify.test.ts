/**
 * @fileoverview Unit tests for the Fastify preHandler hook adapter.
 * RateLimiter is mocked — no real Redis calls are made.
 */

import {
  createFastifyHook,
  extractIPFromFastifyRequest,
  extractUserFromFastifyRequest,
  parsePathFromUrl,
  FastifyAdapterConfig,
} from '../../../src/adapters/fastify';
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
    effective: 5,
    limit: 100,
    remaining: 95,
    resetAt: 1711670400000,
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
    retryAfter: 15000,
    source: 'redis',
    ...overrides,
  };
}

/** Builds a minimal mock Fastify Request. */
function makeFastifyRequest(overrides: {
  method?: string;
  url?: string;
  ip?: string;
  routerPath?: string;
  headers?: Record<string, string | string[] | undefined>;
} = {}): {
  method: string;
  url: string;
  ip: string;
  routerPath?: string;
  headers: Record<string, string | string[] | undefined>;
} {
  return {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/api/test',
    ip: overrides.ip ?? '1.2.3.4',
    routerPath: overrides.routerPath,
    headers: overrides.headers ?? {},
  };
}

/** Builds a mock Fastify Reply with jest spy methods. */
function makeFastifyReply(): {
  status: jest.Mock;
  send: jest.Mock;
  header: jest.Mock;
} {
  const reply = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
  };
  return reply;
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
// createFastifyHook — core behaviour
// ---------------------------------------------------------------------------

describe('createFastifyHook', () => {
  it('calls rateLimiter.check() with the correct RateLimitContext', async () => {
    const mockLimiter = makeMockRateLimiter(makeAllowedResult());
    const hook = createFastifyHook({ rateLimiter: mockLimiter });
    const req = makeFastifyRequest({
      method: 'POST',
      url: '/api/orders',
      ip: '10.0.0.5',
    });
    const reply = makeFastifyReply();

    await hook(req, reply);

    expect(mockLimiter.check).toHaveBeenCalledTimes(1);
    const ctx = (mockLimiter.check as jest.Mock).mock.calls[0][0];
    expect(ctx.ip).toBe('10.0.0.5');
    expect(ctx.route).toBe('/api/orders');
    expect(ctx.method).toBe('POST');
  });

  it('sets X-RateLimit-* headers on an allowed request', async () => {
    const result = makeAllowedResult({ limit: 200, remaining: 180, resetAt: 1711670400000 });
    const mockLimiter = makeMockRateLimiter(result);
    const hook = createFastifyHook({ rateLimiter: mockLimiter });
    const req = makeFastifyRequest();
    const reply = makeFastifyReply();

    await hook(req, reply);

    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Limit', '200');
    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '180');
    expect(reply.header).toHaveBeenCalledWith(
      'X-RateLimit-Reset',
      String(Math.ceil(1711670400000 / 1000)),
    );
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('sends 429 with JSON body when the request is denied', async () => {
    const result = makeDeniedResult({ retryAfter: 15000 });
    const mockLimiter = makeMockRateLimiter(result);
    const hook = createFastifyHook({ rateLimiter: mockLimiter });
    const req = makeFastifyRequest();
    const reply = makeFastifyReply();

    await hook(req, reply);

    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Too Many Requests', retryAfter: 15000 }),
    );
    // Retry-After header should be in seconds
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '15');
  });

  it('skips rate limiting for routes matching skipRoutes patterns', async () => {
    const mockLimiter = makeMockRateLimiter(makeAllowedResult());
    const hook = createFastifyHook({
      rateLimiter: mockLimiter,
      skipRoutes: ['/health', '/metrics'],
    });
    const req = makeFastifyRequest({ url: '/health' });
    const reply = makeFastifyReply();

    await hook(req, reply);

    expect(mockLimiter.check).not.toHaveBeenCalled();
    expect(reply.header).not.toHaveBeenCalled();
  });

  it('applies rate limiting for routes NOT matching skipRoutes patterns', async () => {
    const mockLimiter = makeMockRateLimiter(makeAllowedResult());
    const hook = createFastifyHook({
      rateLimiter: mockLimiter,
      skipRoutes: ['/health'],
    });
    const req = makeFastifyRequest({ url: '/api/users' });
    const reply = makeFastifyReply();

    await hook(req, reply);

    expect(mockLimiter.check).toHaveBeenCalledTimes(1);
  });

  it('skips routes matching glob patterns in skipRoutes', async () => {
    const mockLimiter = makeMockRateLimiter(makeAllowedResult());
    const hook = createFastifyHook({
      rateLimiter: mockLimiter,
      skipRoutes: ['/internal/*'],
    });
    const req = makeFastifyRequest({ url: '/internal/debug' });
    const reply = makeFastifyReply();

    await hook(req, reply);

    expect(mockLimiter.check).not.toHaveBeenCalled();
  });

  it('strips query strings when matching skipRoutes', async () => {
    const mockLimiter = makeMockRateLimiter(makeAllowedResult());
    const hook = createFastifyHook({
      rateLimiter: mockLimiter,
      skipRoutes: ['/health'],
    });
    const req = makeFastifyRequest({ url: '/health?check=true' });
    const reply = makeFastifyReply();

    await hook(req, reply);

    expect(mockLimiter.check).not.toHaveBeenCalled();
  });

  it('rethrows errors from rateLimiter.check()', async () => {
    const error = new Error('Redis error');
    const mockLimiter = {
      check: jest.fn().mockRejectedValue(error),
    } as unknown as jest.Mocked<RateLimiter>;
    const hook = createFastifyHook({ rateLimiter: mockLimiter });
    const req = makeFastifyRequest();
    const reply = makeFastifyReply();

    await expect(hook(req, reply)).rejects.toThrow('Redis error');
  });

  it('includes userTier in context when getUserTier is provided', async () => {
    const mockLimiter = makeMockRateLimiter(makeAllowedResult());
    const hook = createFastifyHook({
      rateLimiter: mockLimiter,
      getUserTier: () => 'enterprise',
    });
    const req = makeFastifyRequest();
    const reply = makeFastifyReply();

    await hook(req, reply);

    const ctx = (mockLimiter.check as jest.Mock).mock.calls[0][0];
    expect(ctx.userTier).toBe('enterprise');
  });
});

// ---------------------------------------------------------------------------
// parsePathFromUrl
// ---------------------------------------------------------------------------

describe('parsePathFromUrl', () => {
  it('returns the path unchanged when there is no query string', () => {
    expect(parsePathFromUrl('/api/users')).toBe('/api/users');
  });

  it('strips the query string', () => {
    expect(parsePathFromUrl('/api/users?page=1&limit=20')).toBe('/api/users');
  });

  it('handles a URL with only a query string', () => {
    expect(parsePathFromUrl('/?foo=bar')).toBe('/');
  });

  it('handles an empty string gracefully', () => {
    expect(parsePathFromUrl('')).toBe('');
  });

  it('returns the root path as-is', () => {
    expect(parsePathFromUrl('/')).toBe('/');
  });

  it('preserves path with no trailing slash before query', () => {
    expect(parsePathFromUrl('/api/items/42?include=details')).toBe('/api/items/42');
  });
});

// ---------------------------------------------------------------------------
// extractIPFromFastifyRequest
// ---------------------------------------------------------------------------

describe('extractIPFromFastifyRequest', () => {
  it('returns req.ip when set', () => {
    const req = makeFastifyRequest({ ip: '192.168.0.1' });
    expect(extractIPFromFastifyRequest(req)).toBe('192.168.0.1');
  });

  it('falls back to X-Real-IP when req.ip is empty', () => {
    const req = makeFastifyRequest({
      ip: '',
      headers: { 'x-real-ip': '172.16.0.1' },
    });
    expect(extractIPFromFastifyRequest(req)).toBe('172.16.0.1');
  });

  it('falls back to X-Forwarded-For respecting trustedProxyCount', () => {
    const req = makeFastifyRequest({
      ip: '',
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
    });
    const ip = extractIPFromFastifyRequest(req, {
      trustXForwardedFor: true,
      trustedProxyCount: 1,
    });
    expect(ip).toBe('203.0.113.5');
  });

  it('falls back to X-Forwarded-For with default config (no config passed) — covers ?? true and ?? 0 defaults', () => {
    const req = makeFastifyRequest({
      ip: '',
      headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
    });
    // No config passed → trustXForwardedFor defaults to true, trustedProxyCount defaults to 0
    const ip = extractIPFromFastifyRequest(req);
    // With proxyCount=0, takes the last entry
    expect(ip).toBe('10.0.0.2');
  });

  it('uses array XFF header — covers Array.isArray branch in getFirstHeaderValue', () => {
    const req = makeFastifyRequest({
      ip: '',
      headers: { 'x-forwarded-for': ['203.0.113.1', '10.0.0.1'] },
    });
    const ip = extractIPFromFastifyRequest(req);
    // getFirstHeaderValue(['203.0.113.1', '10.0.0.1']) → '203.0.113.1'
    // Then split by ',' → ['203.0.113.1'], last = '203.0.113.1'
    expect(ip).toBe('203.0.113.1');
  });

  it('falls back to 0.0.0.0 when XFF header is present but empty after getFirstHeaderValue', () => {
    const req = makeFastifyRequest({
      ip: '',
      // Empty array → getFirstHeaderValue returns undefined → ?? '' → ''.trim().length === 0
      headers: { 'x-forwarded-for': [] },
    });
    const ip = extractIPFromFastifyRequest(req);
    expect(ip).toBe('0.0.0.0');
  });

  it('returns 0.0.0.0 when no IP can be determined', () => {
    const req = makeFastifyRequest({ ip: '' });
    expect(extractIPFromFastifyRequest(req)).toBe('0.0.0.0');
  });
});

// ---------------------------------------------------------------------------
// extractUserFromFastifyRequest
// ---------------------------------------------------------------------------

describe('extractUserFromFastifyRequest', () => {
  it('extracts raw apiKey from Authorization Bearer header (hashing owned by core)', () => {
    const req = makeFastifyRequest({
      headers: { authorization: 'Bearer fastify-token' },
    });
    const { apiKey, userId } = extractUserFromFastifyRequest(req);
    expect(apiKey).toBe('fastify-token');
    expect(userId).toBeUndefined();
  });

  it('returns raw value regardless of hashIdentifiers config', () => {
    const req = makeFastifyRequest({
      headers: { authorization: 'Bearer plain-token' },
    });
    const { apiKey } = extractUserFromFastifyRequest(req, { hashIdentifiers: false });
    expect(apiKey).toBe('plain-token');
  });

  it('extracts apiKey from X-API-Key header', () => {
    const req = makeFastifyRequest({
      headers: { 'x-api-key': 'fastify-api-key' },
    });
    const { apiKey } = extractUserFromFastifyRequest(req, { hashIdentifiers: false });
    expect(apiKey).toBe('fastify-api-key');
  });

  it('returns empty object when no identity headers are present', () => {
    const req = makeFastifyRequest();
    const result = extractUserFromFastifyRequest(req);
    expect(result.apiKey).toBeUndefined();
    expect(result.userId).toBeUndefined();
  });

  it('ignores non-Bearer Authorization schemes', () => {
    const req = makeFastifyRequest({
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    const result = extractUserFromFastifyRequest(req);
    expect(result.apiKey).toBeUndefined();
  });
});
