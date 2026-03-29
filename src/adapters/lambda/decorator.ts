/**
 * @fileoverview Lambda handler decorator for the AWS Rate Limiter.
 *
 * Wraps an API Gateway v2 Lambda handler with rate limiting by delegating
 * all checks to the Lambda Extension's internal HTTP server (IPC over localhost).
 * This keeps the function process stateless — all Redis state lives in the
 * extension process which persists across invocations.
 *
 * Fail-open by design: if the extension server is unreachable the request is
 * allowed through to preserve availability.
 */

import * as http from 'http';
import { RateLimitContext, RateLimitResult } from '../../core/types';

// ---------------------------------------------------------------------------
// Minimal inline Lambda types
// (aws-lambda package is not a dependency; we define only what we need.)
// ---------------------------------------------------------------------------

/** Minimal HTTP context within an API Gateway v2 event. */
interface APIGatewayRequestContext {
  http: { method: string; path: string; sourceIp: string };
  requestId: string;
}

/** Minimal API Gateway HTTP API (v2) event shape. */
interface APIGatewayProxyEventV2 {
  headers: Record<string, string | undefined>;
  requestContext: APIGatewayRequestContext;
  body?: string;
}

/** Minimal API Gateway HTTP API (v2) result shape. */
interface APIGatewayProxyResultV2 {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Minimal Lambda execution context. */
interface Context {
  functionName: string;
  awsRequestId: string;
}

// ---------------------------------------------------------------------------
// Re-export for consumers
// ---------------------------------------------------------------------------

export type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the `withRateLimit` decorator. */
export interface DecoratorConfig {
  /**
   * Base URL of the Lambda Extension's internal HTTP server.
   * @default 'http://localhost:2772'
   */
  extensionUrl?: string;
  /**
   * Ordered list of headers to inspect for the client IP address.
   * Checked before falling back to `event.requestContext.http.sourceIp`.
   */
  ipHeaders?: string[];
  /**
   * Number of trusted reverse proxies in front of this function.
   * When > 0 the `X-Forwarded-For` header is parsed to extract the real IP.
   * @default 0
   */
  trustedProxyCount?: number;
  /**
   * Name of the request header that carries the authenticated user ID.
   * @example 'x-user-id'
   */
  userIdHeader?: string;
  /**
   * Name of the request header that carries the API key.
   * @example 'x-api-key'
   */
  apiKeyHeader?: string;
}

/** A Lambda handler function compatible with API Gateway HTTP API (v2). */
type LambdaHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => Promise<APIGatewayProxyResultV2>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Default extension server URL. */
const DEFAULT_EXTENSION_URL = 'http://localhost:2772';

/**
 * Sends a POST request with a JSON body to the given URL path on a localhost
 * HTTP server and returns the parsed JSON response body.
 *
 * @param baseUrl  Base URL of the target server, e.g. `http://localhost:2772`.
 * @param path     Request path, e.g. `/check`.
 * @param payload  Object to JSON-serialize as the request body.
 * @returns Parsed response body, or `null` if the connection fails.
 */
/** IPC timeout for requests to the extension server (ms). */
const IPC_TIMEOUT_MS = 2000;

function postJson(
  baseUrl: string,
  path: string,
  payload: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const withoutScheme = baseUrl.replace(/^https?:\/\//, '');
    const [hostPart, portPart] = withoutScheme.split(':');
    const host = hostPart ?? /* istanbul ignore next */ 'localhost';
    const port = portPart !== undefined ? parseInt(portPart, 10) : 80;

    const options: http.RequestOptions = {
      host,
      port,
      method: 'POST',
      path,
      timeout: IPC_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(null);
        }
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy(new Error('Extension IPC timeout'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Extracts the real client IP from an X-Forwarded-For header by skipping
 * the last `trustedProxyCount` entries (added by proxies we trust).
 *
 * @param xff               Raw `X-Forwarded-For` header value.
 * @param trustedProxyCount Number of trusted proxies to skip from the right.
 * @returns                 The extracted IP, or `null` if the header is unusable.
 */
function extractIpFromXff(xff: string, trustedProxyCount: number): string | null {
  const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  // The real IP sits at index: length - trustedProxyCount - 1
  const idx = parts.length - trustedProxyCount - 1;
  return idx >= 0 ? (parts[idx] ?? /* istanbul ignore next */ null) : (parts[0] ?? /* istanbul ignore next */ null);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts a {@link RateLimitContext} from an API Gateway v2 event.
 *
 * IP extraction order:
 * 1. Configured `ipHeaders` (checked left-to-right).
 * 2. `X-Forwarded-For` when `trustedProxyCount > 0`.
 * 3. `event.requestContext.http.sourceIp` (always present).
 * 4. `'0.0.0.0'` as a safe fallback.
 *
 * @param event  API Gateway HTTP API event.
 * @param config Optional decorator configuration.
 * @returns      Populated rate limit context.
 */
export function extractContext(
  event: APIGatewayProxyEventV2,
  config?: DecoratorConfig,
): RateLimitContext {
  const httpCtx = event.requestContext.http;
  const headers = event.headers;

  // --- IP extraction ---
  let ip: string | undefined;

  // 1. Custom IP headers (e.g. CF-Connecting-IP, True-Client-IP)
  if (config?.ipHeaders && config.ipHeaders.length > 0) {
    for (const header of config.ipHeaders) {
      const val = headers[header.toLowerCase()];
      if (val && val.trim().length > 0) {
        ip = val.trim();
        break;
      }
    }
  }

  // 2. X-Forwarded-For with trusted proxy stripping
  if (ip === undefined && config?.trustedProxyCount && config.trustedProxyCount > 0) {
    const xff = headers['x-forwarded-for'];
    if (xff) {
      const extracted = extractIpFromXff(xff, config.trustedProxyCount);
      if (extracted !== null) ip = extracted;
    }
  }

  // 3. API Gateway source IP
  if (ip === undefined && httpCtx.sourceIp && httpCtx.sourceIp.length > 0) {
    ip = httpCtx.sourceIp;
  }

  // 4. Safe fallback
  if (ip === undefined) {
    ip = '0.0.0.0';
  }

  // --- User/API key extraction ---
  let userId: string | undefined;
  let apiKey: string | undefined;

  if (config?.userIdHeader) {
    const val = headers[config.userIdHeader.toLowerCase()];
    if (val && val.trim().length > 0) userId = val.trim();
  }

  if (config?.apiKeyHeader) {
    const val = headers[config.apiKeyHeader.toLowerCase()];
    if (val && val.trim().length > 0) apiKey = val.trim();
  }

  return {
    ip,
    userId,
    apiKey,
    route: httpCtx.path,
    method: httpCtx.method,
  };
}

/**
 * Builds standard X-RateLimit-* response headers from a {@link RateLimitResult}.
 *
 * Headers produced:
 * - `X-RateLimit-Limit`     — configured limit for the triggering dimension.
 * - `X-RateLimit-Remaining` — remaining requests (floored at 0).
 * - `X-RateLimit-Reset`     — window reset time as a Unix timestamp in seconds.
 * - `X-RateLimit-Policy`    — limit and window in RFC-8941 structured field format.
 *
 * @param result Rate limit result from the extension's `/check` endpoint.
 * @returns      Record of header name → value strings.
 */
export function buildRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const resetSecs = Math.ceil(result.resetAt / 1000);
  const remaining = Math.max(0, result.remaining);
  const windowSecs = result.windowSecs ?? 60;

  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(resetSecs),
    'X-RateLimit-Policy': `${result.limit};w=${windowSecs}`,
  };
}

/**
 * Wraps a Lambda handler with rate limiting via the Lambda Extension IPC server.
 *
 * On each invocation:
 * 1. Extracts {@link RateLimitContext} from the API Gateway event.
 * 2. POSTs the context to the extension's `/check` endpoint.
 * 3. If `allowed === false`, returns a `429 Too Many Requests` response.
 * 4. If the extension is unreachable (network error), allows through (fail-open).
 * 5. Otherwise calls the original handler and merges X-RateLimit-* headers.
 *
 * @param handler Original Lambda handler to wrap.
 * @param config  Optional decorator configuration.
 * @returns       Wrapped handler with rate limiting applied.
 *
 * @example
 * ```typescript
 * export const handler = withRateLimit(async (event, context) => {
 *   return { statusCode: 200, body: 'OK' };
 * }, { userIdHeader: 'x-user-id' });
 * ```
 */
export function withRateLimit(
  handler: LambdaHandler,
  config?: DecoratorConfig,
): LambdaHandler {
  const extensionUrl = config?.extensionUrl ?? DEFAULT_EXTENSION_URL;

  return async (
    event: APIGatewayProxyEventV2,
    context: Context,
  ): Promise<APIGatewayProxyResultV2> => {
    const ctx = extractContext(event, config);

    let result: RateLimitResult | null = null;

    try {
      const raw = await postJson(extensionUrl, '/check', ctx);
      result = raw as RateLimitResult;
    } catch {
      // Extension unreachable — fail open to preserve availability.
      result = null;
    }

    // Build rate limit headers (only when we got a valid result).
    const rlHeaders: Record<string, string> =
      result !== null ? buildRateLimitHeaders(result) : {};

    // Deny if the result explicitly disallows.
    if (result !== null && !result.allowed) {
      const retryAfterMs = result.retryAfter ?? 0;
      const retryAfterSecs = Math.ceil(retryAfterMs / 1000);
      const responseBody = JSON.stringify({
        error: 'Too Many Requests',
        message: `Rate limit exceeded on ${result.dimension}`,
        retryAfter: retryAfterMs,
      });

      return {
        statusCode: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfterSecs),
          ...rlHeaders,
        },
        body: responseBody,
      };
    }

    // Allowed — invoke the original handler.
    const response = await handler(event, context);

    // Merge rate limit headers into the handler's response.
    return {
      ...response,
      headers: {
        ...response.headers,
        ...rlHeaders,
      },
    };
  };
}
