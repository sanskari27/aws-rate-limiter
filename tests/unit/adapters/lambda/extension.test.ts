/**
 * @fileoverview Unit tests for the LambdaExtension class.
 *
 * register() tests spin up a real local HTTP server that mimics the Lambda
 * Extensions API — no jest.spyOn on http.request (non-configurable in Node 18).
 * Server-interaction tests (start/health/check/status/reset) make real HTTP
 * calls to the extension's own internal server.
 */

import * as http from 'http';
import { AddressInfo } from 'net';
import { LambdaExtension, ExtensionConfig } from '../../../../src/adapters/lambda/extension';
import { RateLimiter } from '../../../../src/rate-limiter';
import { RateLimitResult } from '../../../../src/core/types';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../../../src/rate-limiter');

const MockedRateLimiter = RateLimiter as jest.MockedClass<typeof RateLimiter>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const allowedResult: RateLimitResult = {
  allowed: true,
  dimension: 'none',
  effective: 5,
  limit: 100,
  remaining: 95,
  resetAt: Date.now() + 60000,
  source: 'redis',
};

// ---------------------------------------------------------------------------
// Real Extensions-API mock server helpers
// ---------------------------------------------------------------------------

interface MockApiServer {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Starts a minimal HTTP server that mimics the Lambda Extensions API.
 * - POST /2020-01-01/extension/register → 200 with Lambda-Extension-Identifier header
 * - GET /2020-01-01/extension/event/next → 200 SHUTDOWN (so run() exits quickly)
 */
async function startMockExtensionsApi(opts: {
  extensionId?: string;
  registerStatus?: number;
  missingHeader?: boolean;
}): Promise<MockApiServer> {
  const { extensionId = 'ext-test-123', registerStatus = 200, missingHeader = false } = opts;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/2020-01-01/extension/register') {
      if (registerStatus !== 200) {
        res.writeHead(registerStatus, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (!missingHeader) {
        headers['lambda-extension-identifier'] = extensionId;
      }
      res.writeHead(200, headers);
      res.end('{}');
      return;
    }

    if (req.method === 'GET' && req.url === '/2020-01-01/extension/event/next') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ eventType: 'SHUTDOWN', deadlineMs: Date.now() + 5000 }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Real HTTP helpers for testing the extension's internal server
// ---------------------------------------------------------------------------

async function postToServer(
  port: number,
  path: string,
  payload: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path, agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try { resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch { resolve({ statusCode: res.statusCode ?? 0, body: null }); }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getFromServer(
  port: number,
  path: string,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try { resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch { resolve({ statusCode: res.statusCode ?? 0, body: null }); }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LambdaExtension', () => {
  afterEach(() => {
    MockedRateLimiter.mockClear();
  });

  // -------------------------------------------------------------------------
  // register() — uses real mock Extensions API server
  // -------------------------------------------------------------------------

  describe('register()', () => {
    it('should POST to the correct Extensions API path and return extensionId', async () => {
      const api = await startMockExtensionsApi({ extensionId: 'ext-abc' });
      try {
        const config: ExtensionConfig = {
          rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
          extensionApiUrl: `http://127.0.0.1:${api.port}`,
        };
        const ext = new LambdaExtension(config);
        const reg = await ext.register();
        expect(reg.extensionId).toBe('ext-abc');
      } finally {
        await api.close();
      }
    });

    it('should extract the extensionId from the response header', async () => {
      const api = await startMockExtensionsApi({ extensionId: 'my-ext-456' });
      try {
        const ext = new LambdaExtension({
          rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
          extensionApiUrl: `http://127.0.0.1:${api.port}`,
        });
        const reg = await ext.register();
        expect(reg.extensionId).toBe('my-ext-456');
      } finally {
        await api.close();
      }
    });

    it('should throw when the Extensions API returns a non-200 status', async () => {
      const api = await startMockExtensionsApi({ registerStatus: 500 });
      try {
        const ext = new LambdaExtension({
          rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
          extensionApiUrl: `http://127.0.0.1:${api.port}`,
        });
        await expect(ext.register()).rejects.toThrow(
          'Lambda Extensions API registration failed',
        );
      } finally {
        await api.close();
      }
    });

    it('should throw when the response header is missing', async () => {
      const api = await startMockExtensionsApi({ missingHeader: true });
      try {
        const ext = new LambdaExtension({
          rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
          extensionApiUrl: `http://127.0.0.1:${api.port}`,
        });
        await expect(ext.register()).rejects.toThrow(
          'Lambda Extensions API did not return a Lambda-Extension-Identifier header',
        );
      } finally {
        await api.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // start() — creates HTTP server and connects limiter
  // -------------------------------------------------------------------------

  describe('start()', () => {
    it('should connect the RateLimiter and mark the extension as running', async () => {
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.isConnected = jest.fn().mockReturnValue(true);

      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port: 12340,
      });
      await ext.start();

      expect(MockedRateLimiter.prototype.connect).toHaveBeenCalledTimes(1);
      expect(ext.isRunning()).toBe(true);

      await ext.stop();
    });

    it('should expose an HTTP server that responds on the configured port', async () => {
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.isConnected = jest.fn().mockReturnValue(true);

      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port: 12341,
      });
      await ext.start();

      const { statusCode, body } = await getFromServer(12341, '/health');
      expect(statusCode).toBe(200);
      expect(body).toMatchObject({ ok: true, connected: true });

      await ext.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Internal HTTP server routes
  // -------------------------------------------------------------------------

  describe('internal HTTP server routes', () => {
    const PORT = 12342;
    let ext: LambdaExtension;

    beforeEach(async () => {
      MockedRateLimiter.mockClear();
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.isConnected = jest.fn().mockReturnValue(false);
      MockedRateLimiter.prototype.check = jest.fn().mockResolvedValue(allowedResult);
      MockedRateLimiter.prototype.status = jest.fn().mockResolvedValue(allowedResult);
      MockedRateLimiter.prototype.reset = jest.fn().mockResolvedValue(2);

      ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port: PORT,
      });
      await ext.start();
    });

    afterEach(async () => {
      await ext.stop();
      MockedRateLimiter.mockClear();
    });

    it('POST /check should call limiter.check() and return the result', async () => {
      const ctx = { ip: '1.2.3.4', route: '/api/test', method: 'GET' };
      const { statusCode, body } = await postToServer(PORT, '/check', ctx);

      expect(statusCode).toBe(200);
      expect(MockedRateLimiter.prototype.check).toHaveBeenCalledWith(ctx);
      expect(body).toMatchObject({ allowed: true });
    });

    it('GET /health should return { ok: true, connected: <bool> }', async () => {
      const { statusCode, body } = await getFromServer(PORT, '/health');
      expect(statusCode).toBe(200);
      expect(body).toMatchObject({ ok: true });
      expect(typeof (body as Record<string, unknown>)['connected']).toBe('boolean');
    });

    it('POST /reset should call limiter.reset() and return deleted count', async () => {
      const { statusCode, body } = await postToServer(PORT, '/reset', {
        dimension: 'ip',
        identifier: '1.2.3.4',
      });

      expect(statusCode).toBe(200);
      expect(MockedRateLimiter.prototype.reset).toHaveBeenCalledWith('ip', '1.2.3.4');
      expect(body).toMatchObject({ deleted: 2 });
    });

    it('GET /status should call limiter.status() and return the result', async () => {
      const ctx = { ip: '1.2.3.4', route: '/api/test', method: 'GET' };
      const encoded = encodeURIComponent(JSON.stringify(ctx));
      const { statusCode, body } = await getFromServer(PORT, `/status?ctx=${encoded}`);

      expect(statusCode).toBe(200);
      expect(MockedRateLimiter.prototype.status).toHaveBeenCalledWith(ctx);
      expect(body).toMatchObject({ allowed: true });
    });

    it('GET /status without ctx param should return 400', async () => {
      const { statusCode } = await getFromServer(PORT, '/status');
      expect(statusCode).toBe(400);
    });

    it('unknown route should return 404', async () => {
      const { statusCode } = await getFromServer(PORT, '/unknown');
      expect(statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe('stop()', () => {
    it('should call limiter.shutdown() and mark extension as not running', async () => {
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.isConnected = jest.fn().mockReturnValue(true);

      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port: 12343,
      });
      await ext.start();
      expect(ext.isRunning()).toBe(true);

      await ext.stop();
      expect(ext.isRunning()).toBe(false);
      expect(MockedRateLimiter.prototype.shutdown).toHaveBeenCalledTimes(1);
      expect(ext.getLimiter()).toBeNull();
    });

    it('should be idempotent — calling stop() twice should not throw', async () => {
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);

      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port: 12344,
      });
      await ext.start();
      await ext.stop();
      await expect(ext.stop()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // isRunning() / getLimiter()
  // -------------------------------------------------------------------------

  describe('isRunning() and getLimiter()', () => {
    it('isRunning() should return false before start()', () => {
      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
      });
      expect(ext.isRunning()).toBe(false);
    });

    it('getLimiter() should return null before start()', () => {
      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
      });
      expect(ext.getLimiter()).toBeNull();
    });

    it('getLimiter() should return the RateLimiter after start()', async () => {
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);

      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port: 12345,
      });
      await ext.start();

      expect(ext.getLimiter()).toBeInstanceOf(MockedRateLimiter);

      await ext.stop();
    });
  });

  // -------------------------------------------------------------------------
  // connect failure
  // -------------------------------------------------------------------------

  describe('connect failure', () => {
    it('should throw and not mark running when RateLimiter.connect() rejects', async () => {
      MockedRateLimiter.prototype.connect = jest
        .fn()
        .mockRejectedValue(new Error('Redis unavailable'));

      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port: 12346,
      });
      await expect(ext.start()).rejects.toThrow('Redis unavailable');

      expect(ext.isRunning()).toBe(false);
      expect(ext.getLimiter()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // run() — already registered / already running branches (lines 275-281)
  // -------------------------------------------------------------------------

  describe('run()', () => {
    it('calls register() and start() then enters event loop until SHUTDOWN', async () => {
      const api = await startMockExtensionsApi({ extensionId: 'run-ext-001' });
      try {
        MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
        MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);
        MockedRateLimiter.prototype.isConnected = jest.fn().mockReturnValue(false);

        const ext = new LambdaExtension({
          rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
          extensionApiUrl: `http://127.0.0.1:${api.port}`,
          port: 12350,
        });

        // run() should complete once SHUTDOWN event is received
        await ext.run();

        expect(ext.isRunning()).toBe(false);
      } finally {
        await api.close();
      }
    });

    it('skips register() if already registered', async () => {
      const api = await startMockExtensionsApi({ extensionId: 'run-ext-002' });
      try {
        MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
        MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);
        MockedRateLimiter.prototype.isConnected = jest.fn().mockReturnValue(false);

        const ext = new LambdaExtension({
          rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
          extensionApiUrl: `http://127.0.0.1:${api.port}`,
          port: 12351,
        });

        // Register first so run() skips the register() call
        await ext.register();
        await ext.start();

        // run() should skip register() and start() since both are done, then eventLoop
        await ext.run();

        expect(ext.isRunning()).toBe(false);
      } finally {
        await api.close();
      }
    });

    it('enters event loop with INVOKE events before SHUTDOWN', async () => {
      // Build a mock API that returns INVOKE once, then SHUTDOWN
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/2020-01-01/extension/register') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'lambda-extension-identifier': 'invoke-ext',
          });
          res.end('{}');
          return;
        }
        if (req.method === 'GET' && req.url === '/2020-01-01/extension/event/next') {
          // First call returns INVOKE; subsequent calls return SHUTDOWN
          const callCount = (req.socket as unknown as Record<string, number>)['__calls'] ?? 0;
          (req.socket as unknown as Record<string, number>)['__calls'] = callCount + 1;
          if (callCount === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ eventType: 'INVOKE', deadlineMs: Date.now() + 5000 }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ eventType: 'SHUTDOWN', deadlineMs: Date.now() + 5000 }));
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as import('net').AddressInfo).port;

      try {
        MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
        MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);
        MockedRateLimiter.prototype.isConnected = jest.fn().mockReturnValue(false);

        const ext = new LambdaExtension({
          rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
          extensionApiUrl: `http://127.0.0.1:${port}`,
          port: 12352,
        });

        await ext.run();
        expect(ext.isRunning()).toBe(false);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // -------------------------------------------------------------------------
  // getNextEvent() error paths
  // -------------------------------------------------------------------------

  describe('getNextEvent() error handling', () => {
    it('throws when event/next returns non-200 status', async () => {
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/2020-01-01/extension/register') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'lambda-extension-identifier': 'err-ext',
          });
          res.end('{}');
          return;
        }
        // Return 500 for event/next
        res.writeHead(500);
        res.end('{}');
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as import('net').AddressInfo).port;

      try {
        MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
        MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);

        const ext = new LambdaExtension({
          rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
          extensionApiUrl: `http://127.0.0.1:${port}`,
          port: 12353,
        });

        await expect(ext.run()).rejects.toThrow('event/next returned status');
        await ext.stop().catch(() => { /* ignore */ });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('throws when event/next returns invalid JSON', async () => {
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/2020-01-01/extension/register') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'lambda-extension-identifier': 'bad-json-ext',
          });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('not valid json');
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as import('net').AddressInfo).port;

      try {
        MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
        MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);

        const ext = new LambdaExtension({
          rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
          extensionApiUrl: `http://127.0.0.1:${port}`,
          port: 12354,
        });

        await expect(ext.run()).rejects.toThrow();
        await ext.stop().catch(() => { /* ignore */ });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('throws when event/next response has no eventType field', async () => {
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/2020-01-01/extension/register') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'lambda-extension-identifier': 'no-type-ext',
          });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ notEventType: 'foo' }));
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as import('net').AddressInfo).port;

      try {
        MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
        MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);

        const ext = new LambdaExtension({
          rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
          extensionApiUrl: `http://127.0.0.1:${port}`,
          port: 12355,
        });

        await expect(ext.run()).rejects.toThrow('Unexpected event/next response');
        await ext.stop().catch(() => { /* ignore */ });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('throws when event/next returns a JSON primitive (typeof !== object, line 390 TRUE branch)', async () => {
      // JSON.parse('42') = 42; typeof 42 !== 'object' → TRUE → short-circuit → throw
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/2020-01-01/extension/register') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'lambda-extension-identifier': 'prim-ext',
          });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('42');
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as import('net').AddressInfo).port;

      try {
        MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
        MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);

        const ext = new LambdaExtension({
          rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
          extensionApiUrl: `http://127.0.0.1:${port}`,
          port: 12356,
        });

        await expect(ext.run()).rejects.toThrow('Unexpected event/next response');
        await ext.stop().catch(() => { /* ignore */ });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('throws when event/next returns JSON null (parsed === null, line 391 TRUE branch)', async () => {
      // JSON.parse('null') = null; typeof null === 'object' (falsy for first check),
      // but null === null → TRUE → short-circuit → throw
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/2020-01-01/extension/register') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'lambda-extension-identifier': 'null-ext',
          });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('null');
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as import('net').AddressInfo).port;

      try {
        MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
        MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);

        const ext = new LambdaExtension({
          rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
          extensionApiUrl: `http://127.0.0.1:${port}`,
          port: 12357,
        });

        await expect(ext.run()).rejects.toThrow('Unexpected event/next response');
        await ext.stop().catch(() => { /* ignore */ });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('uses port 80 when extensionApiUrl has no port (line 108 FALSE branch)', async () => {
      // 'http://127.0.0.1' → portPart=undefined → port=80 (connection will fail with ECONNREFUSED)
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);

      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        extensionApiUrl: 'http://127.0.0.1', // no port → portPart=undefined → port=80
        port: 12358,
      });

      await expect(ext.register()).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // IPC routes when limiter is null (503 responses — lines 437, 468, 503)
  // -------------------------------------------------------------------------

  describe('IPC routes when limiter is not started (503)', () => {
    const NULL_LIMITER_PORT = 12360;
    let nullExt: LambdaExtension;

    beforeEach(async () => {
      MockedRateLimiter.mockClear();
      // Spy on constructor — create the server without actually connecting
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);

      nullExt = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port: NULL_LIMITER_PORT,
      });

      // Start the HTTP server but forcefully null the limiter after
      await nullExt.start();
      // Directly null the internal limiter to simulate "not started" scenario
      (nullExt as unknown as Record<string, unknown>)['limiter'] = null;
    });

    afterEach(async () => {
      await nullExt.stop();
      MockedRateLimiter.mockClear();
    });

    it('POST /check returns 503 when limiter is null', async () => {
      const { statusCode, body } = await postToServer(NULL_LIMITER_PORT, '/check', {
        ip: '1.2.3.4', route: '/api', method: 'GET',
      });
      expect(statusCode).toBe(503);
      expect((body as Record<string, unknown>)['error']).toBe('Rate limiter not started');
    });

    it('GET /status returns 503 when limiter is null', async () => {
      const ctx = encodeURIComponent(JSON.stringify({ ip: '1.2.3.4', route: '/api', method: 'GET' }));
      const { statusCode, body } = await getFromServer(NULL_LIMITER_PORT, `/status?ctx=${ctx}`);
      expect(statusCode).toBe(503);
      expect((body as Record<string, unknown>)['error']).toBe('Rate limiter not started');
    });

    it('POST /reset returns 503 when limiter is null', async () => {
      const { statusCode, body } = await postToServer(NULL_LIMITER_PORT, '/reset', {
        dimension: 'ip', identifier: '1.2.3.4',
      });
      expect(statusCode).toBe(503);
      expect((body as Record<string, unknown>)['error']).toBe('Rate limiter not started');
    });

    it('GET /health returns connected: false when limiter is null (line 420 branch)', async () => {
      const { statusCode, body } = await getFromServer(NULL_LIMITER_PORT, '/health');
      expect(statusCode).toBe(200);
      // this.limiter is null → ?.isConnected() = undefined → ?? false = false
      expect((body as Record<string, unknown>)['connected']).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // IPC routes — invalid JSON body handling (lines 446-447, 483-484, 512-513)
  // -------------------------------------------------------------------------

  describe('IPC routes — invalid JSON handling', () => {
    const INVALID_JSON_PORT = 12361;
    let jsonExt: LambdaExtension;

    beforeEach(async () => {
      MockedRateLimiter.mockClear();
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.isConnected = jest.fn().mockReturnValue(false);
      MockedRateLimiter.prototype.check = jest.fn().mockResolvedValue(allowedResult);
      MockedRateLimiter.prototype.status = jest.fn().mockResolvedValue(allowedResult);
      MockedRateLimiter.prototype.reset = jest.fn().mockResolvedValue(2);

      jsonExt = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port: INVALID_JSON_PORT,
      });
      await jsonExt.start();
    });

    afterEach(async () => {
      await jsonExt.stop();
      MockedRateLimiter.mockClear();
    });

    it('POST /check returns 400 for invalid JSON body', async () => {
      const { statusCode, body } = await new Promise<{ statusCode: number; body: unknown }>(
        (resolve, reject) => {
          const rawBody = '{not valid json}';
          const req = http.request(
            {
              host: '127.0.0.1',
              port: INVALID_JSON_PORT,
              method: 'POST',
              path: '/check',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(rawBody),
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () => {
                try {
                  resolve({
                    statusCode: res.statusCode ?? 0,
                    body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                  });
                } catch {
                  resolve({ statusCode: res.statusCode ?? 0, body: null });
                }
              });
              res.on('error', reject);
            },
          );
          req.on('error', reject);
          req.write(rawBody);
          req.end();
        },
      );
      expect(statusCode).toBe(400);
      expect((body as Record<string, unknown>)['error']).toBe('Invalid JSON body');
    });

    it('GET /status returns 400 for invalid JSON in ctx param', async () => {
      const badCtx = encodeURIComponent('{not valid json}');
      const { statusCode, body } = await getFromServer(
        INVALID_JSON_PORT,
        `/status?ctx=${badCtx}`,
      );
      expect(statusCode).toBe(400);
      expect((body as Record<string, unknown>)['error']).toBe('Invalid JSON in ctx query parameter');
    });

    it('POST /reset returns 400 for invalid JSON body', async () => {
      const { statusCode, body } = await new Promise<{ statusCode: number; body: unknown }>(
        (resolve, reject) => {
          const rawBody = 'not json at all';
          const req = http.request(
            {
              host: '127.0.0.1',
              port: INVALID_JSON_PORT,
              method: 'POST',
              path: '/reset',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(rawBody),
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () => {
                try {
                  resolve({
                    statusCode: res.statusCode ?? 0,
                    body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                  });
                } catch {
                  resolve({ statusCode: res.statusCode ?? 0, body: null });
                }
              });
              res.on('error', reject);
            },
          );
          req.on('error', reject);
          req.write(rawBody);
          req.end();
        },
      );
      expect(statusCode).toBe(400);
      expect((body as Record<string, unknown>)['error']).toBe('Invalid JSON body');
    });
  });

  // -------------------------------------------------------------------------
  // stop() — server.close() callback coverage (lines 256-257)
  // -------------------------------------------------------------------------

  describe('stop() server.close() path', () => {
    it('resolves the stop promise via server.close() callback', async () => {
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.isConnected = jest.fn().mockReturnValue(false);

      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port: 12362,
      });

      await ext.start();
      expect(ext.isRunning()).toBe(true);

      // This explicitly exercises the server.close() callback path
      await expect(ext.stop()).resolves.toBeUndefined();
      expect(ext.isRunning()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // handleRequest catch path — lines 256-257 (non-Error and Error throws)
  // Each test creates its own extension on a unique port to avoid state bleed.
  // -------------------------------------------------------------------------

  describe('handleRequest catch path (lines 256-257)', () => {
    it('returns 500 with Error.message when handleRequest throws an Error', async () => {
      const port = 12363;
      MockedRateLimiter.mockClear();
      // Set check mock BEFORE start() so the created instance inherits it
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.isConnected = jest.fn().mockReturnValue(true);
      // check throws an Error → handleCheck rejects → .catch fires → line 256-257
      MockedRateLimiter.prototype.check = jest.fn().mockRejectedValue(new Error('Internal failure'));

      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port,
      });
      await ext.start();

      try {
        const { statusCode, body } = await postToServer(port, '/check', {
          ip: '1.2.3.4',
          route: '/api',
          method: 'GET',
        });
        expect(statusCode).toBe(500);
        expect((body as Record<string, unknown>)['error']).toBe('Internal Server Error');
        expect((body as Record<string, unknown>)['message']).toBe('Internal failure');
      } finally {
        await ext.stop();
        MockedRateLimiter.mockClear();
      }
    });

    it('returns 500 with String(err) when handleRequest throws a non-Error (line 257 String branch)', async () => {
      const port = 12364;
      MockedRateLimiter.mockClear();
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.isConnected = jest.fn().mockReturnValue(true);
      // check throws a plain string (non-Error) → String(err) branch at line 257
      MockedRateLimiter.prototype.check = jest.fn().mockRejectedValue('plain string thrown from limiter');

      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port,
      });
      await ext.start();

      try {
        const { statusCode, body } = await postToServer(port, '/check', {
          ip: '1.2.3.4',
          route: '/api',
          method: 'GET',
        });
        expect(statusCode).toBe(500);
        expect((body as Record<string, unknown>)['error']).toBe('Internal Server Error');
        expect((body as Record<string, unknown>)['message']).toBe('plain string thrown from limiter');
      } finally {
        await ext.stop();
        MockedRateLimiter.mockClear();
      }
    });
  });

  // -------------------------------------------------------------------------
  // handleRequest — req.method undefined fallback (line 391 branch)
  // -------------------------------------------------------------------------

  describe('handleRequest — req.method undefined branch (line 391)', () => {
    it('falls back to GET when req.method is undefined', async () => {
      const port = 12366;
      MockedRateLimiter.mockClear();
      MockedRateLimiter.prototype.connect = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.shutdown = jest.fn().mockResolvedValue(undefined);
      MockedRateLimiter.prototype.isConnected = jest.fn().mockReturnValue(true);

      const ext = new LambdaExtension({
        rateLimiterConfig: { redis: { url: 'redis://localhost' }, rules: [] },
        port,
      });
      await ext.start();

      try {
        let capturedStatus: number | undefined;
        let capturedBody: Record<string, unknown> | undefined;

        // Minimal duck-type mock for http.ServerResponse — only what sendJson needs
        const mockRes = {
          writeHead: (code: number) => { capturedStatus = code; },
          end: (body: string) => { capturedBody = JSON.parse(body) as Record<string, unknown>; },
        } as unknown as http.ServerResponse;

        // req.method is undefined → ??.toUpperCase() returns undefined → ?? 'GET' branch fires
        const mockReq = { url: '/health', method: undefined } as unknown as http.IncomingMessage;

        type HandleRequest = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
        await (ext as unknown as { handleRequest: HandleRequest }).handleRequest(mockReq, mockRes);

        expect(capturedStatus).toBe(200);
        expect(capturedBody).toMatchObject({ ok: true, connected: true });
      } finally {
        await ext.stop();
        MockedRateLimiter.mockClear();
      }
    });
  });
});
