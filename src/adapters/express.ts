/**
 * @fileoverview Express middleware adapter for the AWS Rate Limiter.
 *
 * Provides a factory function that creates Express middleware performing
 * multi-dimensional rate limiting via {@link RateLimiter}.  Does NOT depend on
 * the `express` package at runtime — all required types are declared inline.
 */

import { minimatch } from 'minimatch';

import { RateLimiter } from '../rate-limiter';
import {
  RateLimitContext,
  RateLimitResult,
  IPExtractionConfig,
  UserExtractionConfig,
} from '../core/types';
// hashIdentifier intentionally NOT imported — hashing is owned by RateLimiter core

// ---------------------------------------------------------------------------
// Minimal inline Express types — no `express` package required at runtime
// ---------------------------------------------------------------------------

/** Minimal subset of an Express Request used by this adapter. */
interface Request {
  method: string;
  path: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
}

/** Minimal subset of an Express Response used by this adapter. */
interface Response {
  status(code: number): Response;
  json(body: unknown): Response;
  set(field: string, value: string): Response;
  set(fields: Record<string, string>): Response;
  getHeader(field: string): string | string[] | number | undefined;
}

/** Express next-function signature. */
type NextFunction = (err?: unknown) => void;

/** Type of the middleware function returned by {@link createExpressMiddleware}. */
export type ExpressMiddleware = (req: Request, res: Response, next: NextFunction) => Promise<void>;

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Express rate-limit middleware.
 */
export interface ExpressAdapterConfig {
  /** Connected {@link RateLimiter} instance to use for checks. */
  rateLimiter: RateLimiter;
  /** Options controlling how the real client IP is extracted. */
  ipExtraction?: IPExtractionConfig;
  /** Options controlling how the user identity is extracted. */
  userExtraction?: UserExtractionConfig;
  /**
   * Optional callback to determine the user tier from a request.
   * If not provided, `userTier` is left undefined on the context.
   */
  getUserTier?: (req: Request) => string | undefined;
  /**
   * Whether to attach `X-RateLimit-*` response headers on allowed requests.
   * Defaults to `true`.
   */
  setHeaders?: boolean;
  /**
   * Route path patterns to skip entirely (no rate limiting applied).
   * Uses `minimatch` glob matching against `req.path`.
   *
   * @example `['/health', '/metrics', '/internal/*']`
   */
  skipRoutes?: string[];
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the real client IP address from an Express request.
 *
 * Resolution order:
 * 1. `req.ip` (set by Express when `trust proxy` is configured).
 * 2. `X-Real-IP` header.
 * 3. `X-Forwarded-For` header, respecting `config.trustedProxyCount`.
 *
 * @param req    Incoming Express request.
 * @param config Optional IP extraction configuration.
 * @returns      The best-effort real client IP, or `"0.0.0.0"` as a fallback.
 */
export function extractIPFromRequest(req: Request, config?: IPExtractionConfig): string {
  // 1. Express-set req.ip (most reliable when trust proxy is configured correctly).
  if (req.ip && req.ip.trim().length > 0) {
    return req.ip.trim();
  }

  // 2. X-Real-IP single-value header.
  const realIp = getFirstHeaderValue(req.headers['x-real-ip']);
  if (realIp) {
    return realIp;
  }

  // 3. X-Forwarded-For respecting trusted proxy count.
  const xffHeader = req.headers['x-forwarded-for'];
  if (xffHeader) {
    const xff = getFirstHeaderValue(xffHeader) ?? '';
    if (xff.trim().length > 0) {
      const trustXFF = config?.trustXForwardedFor ?? true;
      const proxyCount = config?.trustedProxyCount ?? 0;

      if (trustXFF) {
        // XFF: client, proxy1, proxy2 — take entry at (length - proxyCount - 1)
        const forwarded = xff.split(',').map((s) => s.trim()).filter(Boolean);
        const idx = Math.max(0, forwarded.length - proxyCount - 1);
        const ip = forwarded[idx];
        if (ip) return ip;
      }
    }
  }

  return '0.0.0.0';
}

/**
 * Extracts user identity information from an Express request.
 *
 * Resolution order:
 * 1. `Authorization: Bearer <token>` header — the token is treated as an API key
 *    and hashed if `config.hashIdentifiers` is true.
 * 2. `X-API-Key` header (or the header named by `config.apiKeyHeader`).
 *
 * @param req    Incoming Express request.
 * @param config Optional user extraction configuration.
 * @returns      Object with optional `userId` and `apiKey` fields.
 */
export function extractUserFromRequest(
  req: Request,
  _config?: UserExtractionConfig,
): { userId?: string; apiKey?: string } {
  // Return raw identifiers — RateLimiter.buildActiveDimensions owns hashing
  // to avoid double-hashing when adapters hash and the core hashes again.

  const authHeader = getFirstHeaderValue(req.headers['authorization']);
  if (authHeader) {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (match) {
      return { apiKey: match[1] };
    }
  }

  const apiKeyHeaderName = (_config?.apiKeyHeader ?? 'x-api-key').toLowerCase();
  const apiKeyHeader = getFirstHeaderValue(req.headers[apiKeyHeaderName]);
  if (apiKeyHeader && apiKeyHeader.trim().length > 0) {
    return { apiKey: apiKeyHeader.trim() };
  }

  return {};
}

/**
 * Builds a `Record<string, string>` of `X-RateLimit-*` response headers
 * from a {@link RateLimitResult}.
 *
 * Headers produced:
 * - `X-RateLimit-Limit`     — configured limit for the triggering dimension.
 * - `X-RateLimit-Remaining` — remaining quota (clamped to 0).
 * - `X-RateLimit-Reset`     — Unix timestamp (seconds) when the window resets.
 * - `X-RateLimit-Policy`    — human-readable policy string.
 *
 * @param result Rate limit check result.
 * @returns      Plain object mapping header names to string values.
 */
export function buildRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const windowSecs = result.windowSecs ?? 60;
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(Math.max(0, result.remaining)),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
    'X-RateLimit-Policy': `${result.limit};w=${windowSecs}`,
  };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express middleware function that performs rate limiting.
 *
 * Behaviour:
 * - Extracts the real client IP and user identity from the request.
 * - Builds a {@link RateLimitContext} and calls `rateLimiter.check()`.
 * - Sets `X-RateLimit-*` headers on every response (unless `setHeaders` is `false`).
 * - Returns `429 Too Many Requests` with a `Retry-After` header when denied.
 * - Calls `next(err)` if `rateLimiter.check()` throws.
 *
 * @param config Adapter configuration.
 * @returns      Express middleware function.
 *
 * @example
 * ```typescript
 * const app = express()
 * app.use(createExpressMiddleware({ rateLimiter }))
 * ```
 */
export function createExpressMiddleware(config: ExpressAdapterConfig): ExpressMiddleware {
  const {
    rateLimiter,
    ipExtraction,
    userExtraction,
    getUserTier,
    setHeaders = true,
    skipRoutes = [],
  } = config;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (skipRoutes.length > 0 && skipRoutes.some((pattern) => minimatch(req.path, pattern))) {
        next();
        return;
      }

      const ip = extractIPFromRequest(req, ipExtraction);
      const { userId, apiKey } = extractUserFromRequest(req, userExtraction);
      const userTier = getUserTier ? getUserTier(req) : undefined;

      const ctx: RateLimitContext = {
        ip,
        userId,
        apiKey,
        route: req.path,
        method: req.method,
        userTier,
      };

      const result = await rateLimiter.check(ctx);

      const headers = buildRateLimitHeaders(result);

      if (setHeaders) {
        res.set(headers);
      }

      if (!result.allowed) {
        if (result.retryAfter !== undefined) {
          res.set('Retry-After', String(Math.ceil(result.retryAfter / 1000)));
        }
        res.status(429).json({
          error: 'Too Many Requests',
          retryAfter: result.retryAfter,
        });
        return;
      }

      next();
    } catch (err: unknown) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the first string value from a header that may be a string, an array
 * of strings, or undefined.
 *
 * @param header Raw header value.
 * @returns      First string value, or `undefined`.
 */
function getFirstHeaderValue(
  header: string | string[] | undefined,
): string | undefined {
  if (header === undefined) return undefined;
  if (Array.isArray(header)) return header[0];
  return header;
}
