/**
 * @fileoverview Unit tests for the Lambda handler decorator.
 *
 * http.request is replaced via jest.mock factory (jest.spyOn is not usable
 * on non-configurable properties in Node 18+). The mock is reset before each
 * test and the actual implementation is accessible via jest.requireActual.
 */

import {
  withRateLimit,
  extractContext,
  buildRateLimitHeaders,
  APIGatewayProxyEventV2,
  Context,
} from '../../../../src/adapters/lambda/decorator';
import { RateLimitResult } from '../../../../src/core/types';

// ---------------------------------------------------------------------------
// Mock http module — replace only `request` with a jest.fn()
// ---------------------------------------------------------------------------

const mockRequest = jest.fn();

jest.mock('http', () => ({
  ...jest.requireActual<typeof import('http')>('http'),
  request: (...args: unknown[]) => mockRequest(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseEvent: APIGatewayProxyEventV2 = {
  headers: {
    'x-user-id': 'user-abc',
    'x-api-key': 'key-xyz',
    'x-forwarded-for': '10.0.0.1, 172.16.0.1, 1.2.3.4',
  },
  requestContext: {
    http: {
      method: 'GET',
      path: '/api/users',
      sourceIp: '1.2.3.4',
    },
    requestId: 'req-001',
  },
};

const baseContext: Context = {
  functionName: 'my-function',
  awsRequestId: 'aws-req-001',
};

const allowedResult: RateLimitResult = {
  allowed: true,
  dimension: 'none',
  effective: 5,
  limit: 100,
  remaining: 95,
  resetAt: 1700000000000,
  source: 'redis',
};

const deniedResult: RateLimitResult = {
  allowed: false,
  dimension: 'ip',
  effective: 100,
  limit: 100,
  remaining: 0,
  resetAt: 1700000030000,
  retryAfter: 30000,
  source: 'redis',
};

// ---------------------------------------------------------------------------
// HTTP mock helpers
// ---------------------------------------------------------------------------

const { EventEmitter } = jest.requireActual<typeof import('events')>('events');
const { PassThrough } = jest.requireActual<typeof import('stream')>('stream');

/**
 * Configures mockRequest to simulate an extension server returning the given payload.
 */
function setupExtensionResponse(payload: unknown, statusCode = 200): void {
  mockRequest.mockImplementation((...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as
      | ((res: import('http').IncomingMessage) => void)
      | undefined;

    const fakeRes = new PassThrough();
    (fakeRes as unknown as Record<string, unknown>).statusCode = statusCode;
    (fakeRes as unknown as Record<string, unknown>).headers = {};

    const fakeReq = new EventEmitter();
    (fakeReq as unknown as Record<string, unknown>).write = jest.fn();
    (fakeReq as unknown as Record<string, unknown>).end = jest.fn(() => {
      if (cb) cb(fakeRes as unknown as import('http').IncomingMessage);
      process.nextTick(() => {
        fakeRes.emit('data', Buffer.from(JSON.stringify(payload)));
        fakeRes.emit('end');
      });
    });

    return fakeReq;
  });
}

/**
 * Configures mockRequest to simulate a network failure (ECONNREFUSED).
 */
function setupExtensionUnreachable(): void {
  mockRequest.mockImplementation((..._args: unknown[]) => {
    const fakeReq = new EventEmitter();
    (fakeReq as unknown as Record<string, unknown>).write = jest.fn();
    (fakeReq as unknown as Record<string, unknown>).end = jest.fn(() => {
      process.nextTick(() => {
        fakeReq.emit('error', new Error('ECONNREFUSED'));
      });
    });
    return fakeReq;
  });
}

// ---------------------------------------------------------------------------
// Tests: withRateLimit decorator
// ---------------------------------------------------------------------------

describe('withRateLimit', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('should return 429 when extension returns allowed: false', async () => {
    setupExtensionResponse(deniedResult);

    const handler = withRateLimit(async () => ({ statusCode: 200, body: 'OK' }));
    const response = await handler(baseEvent, baseContext);

    expect(response.statusCode).toBe(429);
    expect(response.headers?.['Content-Type']).toBe('application/json');
    expect(response.headers?.['Retry-After']).toBeDefined();
  });

  it('should include the rate limit error details in the 429 body', async () => {
    setupExtensionResponse(deniedResult);

    const handler = withRateLimit(async () => ({ statusCode: 200, body: 'OK' }));
    const response = await handler(baseEvent, baseContext);

    const body = JSON.parse(response.body ?? '{}') as Record<string, unknown>;
    expect(body['error']).toBe('Too Many Requests');
    expect(body['message']).toContain('ip');
    expect(typeof body['retryAfter']).toBe('number');
  });

  it('should set Retry-After header in seconds on 429 response', async () => {
    setupExtensionResponse(deniedResult); // retryAfter: 30000ms

    const handler = withRateLimit(async () => ({ statusCode: 200, body: 'OK' }));
    const response = await handler(baseEvent, baseContext);

    expect(response.headers?.['Retry-After']).toBe('30');
  });

  it('should set Retry-After to 0 when result.retryAfter is undefined (line 332 ?? 0 branch)', async () => {
    // Denied result with no retryAfter field → result.retryAfter ?? 0 → retryAfterMs = 0
    const deniedNoRetry: RateLimitResult = {
      allowed: false,
      dimension: 'ip',
      effective: 100,
      limit: 100,
      remaining: 0,
      resetAt: 1700000030000,
      source: 'redis',
      // retryAfter intentionally omitted
    };
    setupExtensionResponse(deniedNoRetry);

    const handler = withRateLimit(async () => ({ statusCode: 200, body: 'OK' }));
    const response = await handler(baseEvent, baseContext);

    expect(response.statusCode).toBe(429);
    expect(response.headers?.['Retry-After']).toBe('0');
  });

  it('should call the handler and return 200 when extension returns allowed: true', async () => {
    setupExtensionResponse(allowedResult);

    const innerHandler = jest.fn().mockResolvedValue({ statusCode: 200, body: 'hello' });
    const handler = withRateLimit(innerHandler);
    const response = await handler(baseEvent, baseContext);

    expect(innerHandler).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('hello');
  });

  it('should merge X-RateLimit-* headers into the handler response when allowed', async () => {
    setupExtensionResponse(allowedResult);

    const handler = withRateLimit(
      async () => ({ statusCode: 200, headers: { 'X-Custom': 'value' }, body: 'OK' }),
    );
    const response = await handler(baseEvent, baseContext);

    expect(response.headers?.['X-RateLimit-Limit']).toBeDefined();
    expect(response.headers?.['X-RateLimit-Remaining']).toBeDefined();
    expect(response.headers?.['X-RateLimit-Reset']).toBeDefined();
    expect(response.headers?.['X-Custom']).toBe('value');
  });

  it('should also include X-RateLimit-* headers on 429 responses', async () => {
    setupExtensionResponse(deniedResult);

    const handler = withRateLimit(async () => ({ statusCode: 200, body: 'OK' }));
    const response = await handler(baseEvent, baseContext);

    expect(response.headers?.['X-RateLimit-Limit']).toBe('100');
    expect(response.headers?.['X-RateLimit-Remaining']).toBe('0');
  });

  it('should allow through (fail open) when extension is unreachable', async () => {
    setupExtensionUnreachable();

    const innerHandler = jest.fn().mockResolvedValue({ statusCode: 200, body: 'OK' });
    const handler = withRateLimit(innerHandler);
    const response = await handler(baseEvent, baseContext);

    expect(innerHandler).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
  });

  it('should use the configured extensionUrl', async () => {
    setupExtensionResponse(allowedResult);

    const handler = withRateLimit(
      async () => ({ statusCode: 200, body: 'OK' }),
      { extensionUrl: 'http://localhost:9999' },
    );
    await handler(baseEvent, baseContext);

    const callOptions = mockRequest.mock.calls[0]?.[0] as import('http').RequestOptions;
    expect(callOptions.port).toBe(9999);
  });

  it('should pass the extracted context to the extension /check endpoint', async () => {
    setupExtensionResponse(allowedResult);

    const handler = withRateLimit(
      async () => ({ statusCode: 200, body: 'OK' }),
      { userIdHeader: 'x-user-id' },
    );
    await handler(baseEvent, baseContext);

    const callOptions = mockRequest.mock.calls[0]?.[0] as import('http').RequestOptions;
    expect(callOptions.path).toBe('/check');
  });

  it('should fail-open when extension returns invalid (non-JSON) response body (line 147)', async () => {
    // Simulate extension server returning non-JSON body → JSON.parse throws → resolve(null)
    mockRequest.mockImplementation((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as
        | ((res: import('http').IncomingMessage) => void)
        | undefined;

      const { PassThrough: PT } = jest.requireActual<typeof import('stream')>('stream');
      const { EventEmitter: EE } = jest.requireActual<typeof import('events')>('events');

      const fakeRes = new PT();
      (fakeRes as unknown as Record<string, unknown>).statusCode = 200;
      (fakeRes as unknown as Record<string, unknown>).headers = {};

      const fakeReq = new EE();
      (fakeReq as unknown as Record<string, unknown>).write = jest.fn();
      (fakeReq as unknown as Record<string, unknown>).end = jest.fn(() => {
        if (cb) cb(fakeRes as unknown as import('http').IncomingMessage);
        process.nextTick(() => {
          // Send invalid JSON to trigger the catch → resolve(null) branch
          fakeRes.emit('data', Buffer.from('NOT_VALID_JSON'));
          fakeRes.emit('end');
        });
      });

      return fakeReq;
    });

    const innerHandler = jest.fn().mockResolvedValue({ statusCode: 200, body: 'OK' });
    const handler = withRateLimit(innerHandler);
    const response = await handler(baseEvent, baseContext);

    // result = null → fail-open: handler is called
    expect(innerHandler).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
  });

  it('should use default port 80 when extensionUrl has no port (line 126 FALSE branch)', async () => {
    // baseUrl = 'http://localhost' → portPart is undefined → port = 80
    setupExtensionResponse(allowedResult);

    const innerHandler = jest.fn().mockResolvedValue({ statusCode: 200, body: 'ok' });
    const handler = withRateLimit(innerHandler, { extensionUrl: 'http://localhost' });
    const response = await handler(baseEvent, baseContext);

    expect(innerHandler).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
  });

  it('should destroy the request and fail-open on IPC timeout (line 154)', async () => {
    // Simulate timeout event being emitted on the request object
    mockRequest.mockImplementation((...args: unknown[]) => {
      const { EventEmitter: EE } = jest.requireActual<typeof import('events')>('events');

      const fakeReq = new EE() as import('events').EventEmitter & {
        write: jest.Mock;
        end: jest.Mock;
        destroy: jest.Mock;
      };

      fakeReq.write = jest.fn();
      fakeReq.destroy = jest.fn().mockImplementation((err: Error) => {
        // Destroying the request emits 'error', which rejects postJson
        process.nextTick(() => fakeReq.emit('error', err));
      });
      fakeReq.end = jest.fn(() => {
        // Emit timeout to trigger the req.on('timeout') handler (line 153-155)
        process.nextTick(() => fakeReq.emit('timeout'));
      });

      return fakeReq;
    });

    const innerHandler = jest.fn().mockResolvedValue({ statusCode: 200, body: 'OK' });
    const handler = withRateLimit(innerHandler);
    const response = await handler(baseEvent, baseContext);

    // After timeout → destroy called → error emitted → postJson rejects → fail-open
    expect(innerHandler).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: extractContext
// ---------------------------------------------------------------------------

describe('extractContext', () => {
  it('should extract IP from sourceIp by default', () => {
    const ctx = extractContext(baseEvent);
    expect(ctx.ip).toBe('1.2.3.4');
  });

  it('should extract IP from a custom ipHeader when provided', () => {
    const event: APIGatewayProxyEventV2 = {
      ...baseEvent,
      headers: { ...baseEvent.headers, 'cf-connecting-ip': '5.6.7.8' },
    };
    const ctx = extractContext(event, { ipHeaders: ['cf-connecting-ip'] });
    expect(ctx.ip).toBe('5.6.7.8');
  });

  it('should extract the real IP from X-Forwarded-For with trustedProxyCount', () => {
    // XFF: '10.0.0.1, 172.16.0.1, 1.2.3.4' — last 2 are trusted proxies
    const ctx = extractContext(baseEvent, { trustedProxyCount: 2 });
    expect(ctx.ip).toBe('10.0.0.1');
  });

  it('should fallback to 0.0.0.0 when sourceIp is absent', () => {
    const event: APIGatewayProxyEventV2 = {
      headers: {},
      requestContext: {
        http: { method: 'GET', path: '/test', sourceIp: '' },
        requestId: 'r1',
      },
    };
    const ctx = extractContext(event);
    expect(ctx.ip).toBe('0.0.0.0');
  });

  it('should extract userId from the configured userIdHeader', () => {
    const ctx = extractContext(baseEvent, { userIdHeader: 'x-user-id' });
    expect(ctx.userId).toBe('user-abc');
  });

  it('should extract apiKey from the configured apiKeyHeader', () => {
    const ctx = extractContext(baseEvent, { apiKeyHeader: 'x-api-key' });
    expect(ctx.apiKey).toBe('key-xyz');
  });

  it('should set userId and apiKey to undefined when headers are absent', () => {
    const ctx = extractContext(baseEvent);
    expect(ctx.userId).toBeUndefined();
    expect(ctx.apiKey).toBeUndefined();
  });

  it('should extract route and method from requestContext', () => {
    const ctx = extractContext(baseEvent);
    expect(ctx.route).toBe('/api/users');
    expect(ctx.method).toBe('GET');
  });

  it('should handle case-insensitive header lookup for userIdHeader', () => {
    const event: APIGatewayProxyEventV2 = {
      ...baseEvent,
      headers: { 'x-user-id': 'lowercase-user' },
    };
    const ctx = extractContext(event, { userIdHeader: 'X-User-Id' });
    expect(ctx.userId).toBe('lowercase-user');
  });

  it('falls through to sourceIp when XFF contains only separators (line 172 parts.length===0)', () => {
    // ',' splits to ['',''] → filter(Boolean) → [] → parts.length===0 → return null → fall through
    const event: APIGatewayProxyEventV2 = {
      headers: { 'x-forwarded-for': ',' },
      requestContext: {
        http: { method: 'GET', path: '/test', sourceIp: '5.5.5.5' },
        requestId: 'r2',
      },
    };
    const ctx = extractContext(event, { trustedProxyCount: 1 });
    expect(ctx.ip).toBe('5.5.5.5');
  });

  it('uses parts[0] fallback when trustedProxyCount exceeds XFF array length (line 175 idx<0)', () => {
    // '1.2.3.4' → parts=['1.2.3.4'] → idx = 1 - 5 - 1 = -5 < 0 → return parts[0]
    const event: APIGatewayProxyEventV2 = {
      headers: { 'x-forwarded-for': '1.2.3.4' },
      requestContext: {
        http: { method: 'GET', path: '/test', sourceIp: '9.9.9.9' },
        requestId: 'r3',
      },
    };
    const ctx = extractContext(event, { trustedProxyCount: 5 });
    expect(ctx.ip).toBe('1.2.3.4');
  });
});

// ---------------------------------------------------------------------------
// Tests: buildRateLimitHeaders
// ---------------------------------------------------------------------------

describe('buildRateLimitHeaders', () => {
  it('should produce X-RateLimit-Limit from result.limit', () => {
    const headers = buildRateLimitHeaders(allowedResult);
    expect(headers['X-RateLimit-Limit']).toBe('100');
  });

  it('should produce X-RateLimit-Remaining as max(0, remaining)', () => {
    const headers = buildRateLimitHeaders(allowedResult);
    expect(headers['X-RateLimit-Remaining']).toBe('95');
  });

  it('should clamp X-RateLimit-Remaining to 0 when remaining is negative', () => {
    const result: RateLimitResult = { ...deniedResult, remaining: -5 };
    const headers = buildRateLimitHeaders(result);
    expect(headers['X-RateLimit-Remaining']).toBe('0');
  });

  it('should produce X-RateLimit-Reset as Unix seconds (ceil of resetAt/1000)', () => {
    const result: RateLimitResult = { ...allowedResult, resetAt: 1700000001500 };
    const headers = buildRateLimitHeaders(result);
    expect(headers['X-RateLimit-Reset']).toBe(String(Math.ceil(1700000001500 / 1000)));
  });

  it('should produce X-RateLimit-Policy in limit;w=seconds format', () => {
    const headers = buildRateLimitHeaders(allowedResult);
    expect(headers['X-RateLimit-Policy']).toMatch(/^100;w=\d+$/);
  });

  it('should use retryAfter as window seconds in policy header when present', () => {
    const result: RateLimitResult = { ...deniedResult, retryAfter: 60000 };
    const headers = buildRateLimitHeaders(result);
    expect(headers['X-RateLimit-Policy']).toBe('100;w=60');
  });
});
