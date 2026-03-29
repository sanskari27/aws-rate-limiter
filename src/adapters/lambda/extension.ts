/**
 * @fileoverview Lambda Extension adapter for the AWS Rate Limiter.
 *
 * Registers with the Lambda Extensions API to maintain a persistent Redis
 * connection across Lambda invocations, eliminating cold-start Redis overhead.
 * Exposes an internal HTTP server on localhost so the @RateLimit decorator
 * (running in the function process) can call check/status/reset via IPC.
 *
 * Lifecycle:
 *   1. `register()` — POST to Extensions API, obtain extension ID.
 *   2. `start()` — Connect to Redis, start internal HTTP server.
 *   3. `run()` — Long-poll event loop (INVOKE is a no-op; SHUTDOWN triggers stop()).
 *   4. `stop()` — Flush reservoir, close HTTP server, disconnect Redis.
 */

import * as http from 'http';
import { RateLimiter } from '../../rate-limiter';
import { RateLimiterConfig, RateLimitContext } from '../../core/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the LambdaExtension. */
export interface ExtensionConfig {
  /** Rate limiter configuration used to create the RateLimiter instance. */
  rateLimiterConfig: RateLimiterConfig;
  /**
   * Port for the internal HTTP server (decorator → extension IPC).
   * @default 2772
   */
  port?: number;
  /**
   * Base URL for the Lambda Extensions API.
   * @default `http://${process.env['AWS_LAMBDA_RUNTIME_API'] ?? 'localhost:9001'}`
   */
  extensionApiUrl?: string;
}

/** Result of a successful Extensions API registration. */
export interface ExtensionRegistration {
  /** Opaque extension ID assigned by the Lambda service. */
  extensionId: string;
}

/** An event received from the Lambda Extensions API event loop. */
export interface LambdaEvent {
  /** Type of event: function invocation or shutdown. */
  eventType: 'INVOKE' | 'SHUTDOWN';
  /** Absolute deadline in Unix epoch milliseconds. */
  deadlineMs: number;
  /** Unique request ID (INVOKE only). */
  requestId?: string;
  /** ARN of the invoked function (INVOKE only). */
  invokedFunctionArn?: string;
  /** Reason for shutdown (SHUTDOWN only). */
  shutdownReason?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extension name reported to the Lambda Extensions API. */
const EXTENSION_NAME = 'rate-limiter-extension';

/**
 * Sends a raw HTTP request using the `http` module and collects the full
 * response body. Returns both the response object and the body string.
 *
 * @param options Node.js `http.RequestOptions`.
 * @param body    Optional request body string.
 * @returns Resolved with `{ res, body }` or rejected on network error.
 */
function httpRequest(
  options: http.RequestOptions,
  body?: string,
): Promise<{ res: http.IncomingMessage; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Parses the host and port from a URL string of the form `http://host:port`.
 * Query strings and paths are deliberately not handled here — callers supply
 * the path separately via `RequestOptions.path`.
 *
 * @param baseUrl Base URL, e.g. `http://localhost:9001`.
 * @returns `{ host, port }` tuple.
 */
function parseBaseUrl(baseUrl: string): { host: string; port: number } {
  // Strip leading scheme.
  const withoutScheme = baseUrl.replace(/^https?:\/\//, '');
  const [hostPart, portPart] = withoutScheme.split(':');
  return {
    host: hostPart ?? /* istanbul ignore next */ 'localhost',
    port: portPart !== undefined ? parseInt(portPart, 10) : 80,
  };
}

/**
 * Collects the body from an incoming HTTP request stream.
 *
 * @param req The incoming HTTP request.
 * @returns Resolved with the request body string.
 */
function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Sends a JSON response on an HTTP server response object.
 *
 * @param res        Server response.
 * @param statusCode HTTP status code.
 * @param payload    Object to JSON-serialize as the body.
 */
function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// LambdaExtension
// ---------------------------------------------------------------------------

/**
 * Lambda Extension that maintains a persistent Redis connection across
 * Lambda invocations, reducing cold-start latency.
 *
 * The extension registers with the Lambda Extensions API and starts an
 * internal HTTP server for IPC with the rate limit decorator. It then
 * enters a long-poll event loop, keeping the process (and Redis connection)
 * alive between invocations.
 *
 * @example
 * ```typescript
 * const ext = new LambdaExtension({
 *   rateLimiterConfig: { redis: { url: 'redis://...' }, rules: [...] },
 * });
 * await ext.run(); // Blocks until Lambda SHUTDOWN event
 * ```
 */
export class LambdaExtension {
  private limiter: RateLimiter | null = null;
  private server: http.Server | null = null;
  private extensionId: string = '';
  private readonly config: Required<ExtensionConfig>;
  private running = false;
  private registered = false;

  /**
   * @param config Extension configuration including rate limiter config.
   */
  constructor(config: ExtensionConfig) {
    const runtimeApi = process.env['AWS_LAMBDA_RUNTIME_API'] ?? 'localhost:9001';
    this.config = {
      rateLimiterConfig: config.rateLimiterConfig,
      port: config.port ?? 2772,
      extensionApiUrl: config.extensionApiUrl ?? `http://${runtimeApi}`,
    };
  }

  // -------------------------------------------------------------------------
  // Public lifecycle API
  // -------------------------------------------------------------------------

  /**
   * Register this extension with the Lambda Extensions API.
   * Must be called before `startEventLoop()`.
   *
   * @returns Registration result containing the assigned extension ID.
   * @throws {Error} If the registration HTTP call fails or returns a non-200 status.
   */
  async register(): Promise<ExtensionRegistration> {
    const { host, port } = parseBaseUrl(this.config.extensionApiUrl);
    const body = JSON.stringify({ events: ['INVOKE', 'SHUTDOWN'] });

    const { res } = await httpRequest(
      {
        host,
        port,
        method: 'POST',
        path: '/2020-01-01/extension/register',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Lambda-Extension-Name': EXTENSION_NAME,
        },
      },
      body,
    );

    if (res.statusCode !== 200) {
      throw new Error(
        `Lambda Extensions API registration failed with status ${res.statusCode ?? /* istanbul ignore next */ 'unknown'}`,
      );
    }

    const extensionId = res.headers['lambda-extension-identifier'];
    if (typeof extensionId !== 'string' || extensionId.length === 0) {
      throw new Error(
        'Lambda Extensions API did not return a Lambda-Extension-Identifier header',
      );
    }

    this.extensionId = extensionId;
    this.registered = true;
    return { extensionId };
  }

  /**
   * Start the RateLimiter (connects to Redis) and the internal HTTP server.
   * The HTTP server handles IPC requests from the decorator process.
   *
   * Routes exposed:
   * - `POST /check`   — rate limit check (consumes quota)
   * - `GET /status`   — read-only status query
   * - `POST /reset`   — admin reset for a dimension+identifier
   * - `GET /health`   — liveness probe
   *
   * @throws {Error} If the Redis connection cannot be established.
   */
  async start(): Promise<void> {
    // Create and connect the rate limiter.
    // Create instance first; only assign to this.limiter after connect() succeeds
    // so getLimiter() stays null if connect() throws.
    const limiter = new RateLimiter(this.config.rateLimiterConfig);
    await limiter.connect();
    this.limiter = limiter;

    // Start the internal HTTP server.
    await new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 500, { error: 'Internal Server Error', message });
        });
      });

      this.server.once('error', reject);
      this.server.listen(this.config.port, '127.0.0.1', () => resolve());
    });

    this.running = true;
  }

  /**
   * Start the Lambda event loop — blocks until a SHUTDOWN event is received.
   * Calls `register()` and `start()` if they have not been called yet.
   *
   * @throws {Error} If registration or start-up fails.
   */
  async run(): Promise<void> {
    if (!this.registered) {
      await this.register();
    }
    if (!this.running) {
      await this.start();
    }
    await this.eventLoop();
  }

  /**
   * Gracefully shut down: flush the reservoir, close the HTTP server, and
   * disconnect from Redis.
   */
  async stop(): Promise<void> {
    this.running = false;

    // Close the HTTP server first so no new IPC requests are accepted.
    if (this.server !== null) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Disconnect the rate limiter (flushes reservoir internally).
    if (this.limiter !== null) {
      await this.limiter.shutdown();
      this.limiter = null;
    }
  }

  /**
   * Returns the running {@link RateLimiter} instance, or `null` before `start()`.
   *
   * @returns The rate limiter instance or `null`.
   */
  getLimiter(): RateLimiter | null {
    return this.limiter;
  }

  /**
   * Returns `true` if the extension has been started and not yet stopped.
   *
   * @returns Boolean running state.
   */
  isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Long-polls the Lambda Extensions API event loop until a SHUTDOWN event.
   * INVOKE events are no-ops — the RateLimiter is stateless per invocation.
   */
  private async eventLoop(): Promise<void> {
    while (this.running) {
      const event = await this.getNextEvent();
      if (event.eventType === 'SHUTDOWN') {
        await this.stop();
        break;
      }
      // INVOKE: no-op — rate limiter state is shared in-process.
    }
  }

  /**
   * Long-polls `GET /2020-01-01/extension/event/next` for the next event.
   *
   * @returns The next Lambda event.
   * @throws {Error} If the HTTP call fails or returns a non-200 status.
   */
  private async getNextEvent(): Promise<LambdaEvent> {
    const { host, port } = parseBaseUrl(this.config.extensionApiUrl);

    const { res, body } = await httpRequest({
      host,
      port,
      method: 'GET',
      path: '/2020-01-01/extension/event/next',
      headers: {
        'Lambda-Extension-Identifier': this.extensionId,
      },
    });

    if (res.statusCode !== 200) {
      throw new Error(
        `Extensions API event/next returned status ${res.statusCode ?? /* istanbul ignore next */ 'unknown'}`,
      );
    }

    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('eventType' in parsed)
    ) {
      throw new Error(`Unexpected event/next response: ${body}`);
    }

    return parsed as LambdaEvent;
  }

  /**
   * Routes an incoming IPC request to the appropriate RateLimiter method.
   *
   * @param req Incoming HTTP request.
   * @param res Outgoing HTTP response.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = req.url ?? /* istanbul ignore next */ '/';
    const method = req.method?.toUpperCase() ?? 'GET';

    if (method === 'GET' && url === '/health') {
      return this.handleHealth(res);
    }

    if (method === 'POST' && url === '/check') {
      return this.handleCheck(req, res);
    }

    if (method === 'GET' && url.startsWith('/status')) {
      return this.handleStatus(req, res);
    }

    if (method === 'POST' && url === '/reset') {
      return this.handleReset(req, res);
    }

    sendJson(res, 404, { error: 'Not Found' });
  }

  /**
   * `GET /health` — returns liveness status.
   *
   * @param res HTTP response.
   */
  private handleHealth(res: http.ServerResponse): void {
    sendJson(res, 200, {
      ok: true,
      connected: this.limiter?.isConnected() ?? false,
    });
  }

  /**
   * `POST /check` — performs a rate limit check and increments counters.
   * Request body: {@link RateLimitContext} as JSON.
   * Response body: {@link RateLimitResult} as JSON.
   *
   * @param req HTTP request.
   * @param res HTTP response.
   */
  private async handleCheck(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (this.limiter === null) {
      sendJson(res, 503, { error: 'Rate limiter not started' });
      return;
    }

    const rawBody = await readRequestBody(req);
    let ctx: RateLimitContext;
    try {
      ctx = JSON.parse(rawBody) as RateLimitContext;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const result = await this.limiter.check(ctx);
    sendJson(res, 200, result);
  }

  /**
   * `GET /status?dimension=ip&identifier=...` — read-only status query.
   * Query params: must include enough context to build a {@link RateLimitContext}.
   * For simplicity the caller passes a minimal context as a JSON query param `ctx`.
   *
   * Response body: {@link RateLimitResult} as JSON.
   *
   * @param req HTTP request.
   * @param res HTTP response.
   */
  private async handleStatus(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (this.limiter === null) {
      sendJson(res, 503, { error: 'Rate limiter not started' });
      return;
    }

    const urlObj = new URL(req.url ?? /* istanbul ignore next */ '/status', `http://localhost:${this.config.port}`);
    const ctxParam = urlObj.searchParams.get('ctx');
    if (ctxParam === null) {
      sendJson(res, 400, { error: 'Missing required query parameter: ctx' });
      return;
    }

    let ctx: RateLimitContext;
    try {
      ctx = JSON.parse(decodeURIComponent(ctxParam)) as RateLimitContext;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON in ctx query parameter' });
      return;
    }
    const result = await this.limiter.status(ctx);
    sendJson(res, 200, result);
  }

  /**
   * `POST /reset` — deletes rate limit keys for a dimension+identifier.
   * Request body: `{ dimension: string; identifier: string }` as JSON.
   * Response body: `{ deleted: number }` as JSON.
   *
   * @param req HTTP request.
   * @param res HTTP response.
   */
  private async handleReset(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (this.limiter === null) {
      sendJson(res, 503, { error: 'Rate limiter not started' });
      return;
    }

    const rawBody = await readRequestBody(req);
    let parsed: { dimension: 'ip' | 'user' | 'route' | 'user-route'; identifier: string };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const deleted = await this.limiter.reset(parsed.dimension, parsed.identifier);
    sendJson(res, 200, { deleted });
  }
}
