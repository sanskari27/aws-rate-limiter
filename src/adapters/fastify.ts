/**
 * @fileoverview Fastify preHandler hook adapter for the AWS Rate Limiter.
 *
 * Provides a factory function that creates a Fastify `preHandler` hook
 * performing multi-dimensional rate limiting via {@link RateLimiter}.
 * Does NOT depend on the `fastify` package at runtime — all required types
 * are declared inline.
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
// Minimal inline Fastify types — no `fastify` package required at runtime
// ---------------------------------------------------------------------------

/** Minimal subset of a Fastify Request used by this adapter. */
interface FastifyRequest {
  method: string;
  /** Full URL including query string, e.g. `/api/users/123?page=1`. */
  url: string;
  /** Matched route pattern, e.g. `/api/users/:id`. Set by Fastify router. */
  routerPath?: string;
  /** Client IP as resolved by Fastify (respects trust-proxy config). */
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Minimal subset of a Fastify Reply used by this adapter. */
interface FastifyReply {
  status(code: number): FastifyReply;
  send(payload: unknown): FastifyReply;
  header(key: string, value: string): FastifyReply;
}

/** Type of the hook function returned by {@link createFastifyHook}. */
export type FastifyHookHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Fastify preHandler rate-limit hook.
 */
export interface FastifyAdapterConfig {
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
  getUserTier?: (req: FastifyRequest) => string | undefined;
  /**
   * Route path patterns to skip entirely (no rate limiting applied).
   * Uses `minimatch` glob matching against the parsed request path.
   *
   * @example `['/health', '/metrics', '/internal/*']`
   */
  skipRoutes?: string[];
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Parses the path component from a Fastify request URL by stripping the
 * query string.
 *
 * @param url Full URL string, e.g. `/api/users/123?page=1`.
 * @returns   Path-only string, e.g. `/api/users/123`.
 */
export function parsePathFromUrl(url: string): string {
  const qIdx = url.indexOf('?');
  return qIdx === -1 ? url : url.slice(0, qIdx);
}

/**
 * Extracts the real client IP address from a Fastify request.
 *
 * Resolution order:
 * 1. `req.ip` (Fastify resolves this via its `trustProxy` option).
 * 2. `X-Real-IP` header.
 * 3. `X-Forwarded-For` header, respecting `config.trustedProxyCount`.
 *
 * @param req    Incoming Fastify request.
 * @param config Optional IP extraction configuration.
 * @returns      The best-effort real client IP, or `"0.0.0.0"` as a fallback.
 */
export function extractIPFromFastifyRequest(
  req: FastifyRequest,
  config?: IPExtractionConfig,
): string {
  // 1. Fastify-resolved IP (most reliable when trustProxy is configured).
  if (req.ip && req.ip.trim().length > 0) {
    return req.ip.trim();
  }

  // 2. X-Real-IP single-value header.
  const realIp = getFirstHeaderValue(req.headers['x-real-ip']);
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }

  // 3. X-Forwarded-For respecting trusted proxy count.
  const xffHeader = req.headers['x-forwarded-for'];
  if (xffHeader) {
    const xff = getFirstHeaderValue(xffHeader) ?? '';
    if (xff.trim().length > 0) {
      const trustXFF = config?.trustXForwardedFor ?? true;
      const proxyCount = config?.trustedProxyCount ?? 0;

      if (trustXFF) {
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
 * Extracts user identity information from a Fastify request.
 *
 * Resolution order:
 * 1. `Authorization: Bearer <token>` header — the token is treated as an API key
 *    and hashed if `config.hashIdentifiers` is true.
 * 2. `X-API-Key` header (or the header named by `config.apiKeyHeader`).
 *
 * @param req    Incoming Fastify request.
 * @param config Optional user extraction configuration.
 * @returns      Object with optional `userId` and `apiKey` fields.
 */
export function extractUserFromFastifyRequest(
  req: FastifyRequest,
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

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/**
 * Creates a Fastify `preHandler` hook that performs rate limiting.
 *
 * Register the returned hook with:
 * ```typescript
 * fastify.addHook('preHandler', createFastifyHook({ rateLimiter }))
 * ```
 *
 * Behaviour:
 * - Parses the path from `req.url` (strips query string).
 * - Skips rate limiting if the path matches any pattern in `skipRoutes`.
 * - Extracts IP and user identity from the request.
 * - Builds a {@link RateLimitContext} and calls `rateLimiter.check()`.
 * - Sets `X-RateLimit-*` response headers on every non-skipped request.
 * - Sends `429 Too Many Requests` with a JSON body and `Retry-After` header on denial.
 * - Rethrows errors from `rateLimiter.check()` so Fastify's error handler picks them up.
 *
 * @param config Hook configuration.
 * @returns      Fastify preHandler hook function.
 */
export function createFastifyHook(config: FastifyAdapterConfig): FastifyHookHandler {
  const {
    rateLimiter,
    ipExtraction,
    userExtraction,
    getUserTier,
    skipRoutes = [],
  } = config;

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = parsePathFromUrl(req.url);

    // Skip rate limiting for matching routes.
    if (skipRoutes.length > 0 && skipRoutes.some((pattern) => minimatch(path, pattern))) {
      return;
    }

    const ip = extractIPFromFastifyRequest(req, ipExtraction);
    const { userId, apiKey } = extractUserFromFastifyRequest(req, userExtraction);
    const userTier = getUserTier ? getUserTier(req) : undefined;

    const ctx: RateLimitContext = {
      ip,
      userId,
      apiKey,
      route: req.routerPath ?? path,
      method: req.method,
      userTier,
    };

    const result: RateLimitResult = await rateLimiter.check(ctx);

    // Set rate limit headers unconditionally (even on deny, so clients can adapt).
    const windowSecs = result.windowSecs ?? 60;
    reply
      .header('X-RateLimit-Limit', String(result.limit))
      .header('X-RateLimit-Remaining', String(Math.max(0, result.remaining)))
      .header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)))
      .header('X-RateLimit-Policy', `${result.limit};w=${windowSecs}`);

    if (!result.allowed) {
      if (result.retryAfter !== undefined) {
        reply.header('Retry-After', String(Math.ceil(result.retryAfter / 1000)));
      }
      reply.status(429).send({
        error: 'Too Many Requests',
        retryAfter: result.retryAfter,
      });
    }
    // If allowed: return normally — Fastify will call the next handler.
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
