/**
 * @fileoverview CLI command: status
 *
 * Displays the current rate limit status for a given request context
 * by calling RateLimiter.status() and printing a formatted table.
 */

import { RateLimiter } from '../../../src/rate-limiter';
import { RateLimiterConfig, RateLimitResult } from '../../../src/core/types';

/** Arguments for the status command */
export interface StatusArgs {
  /** IP address to check (defaults to '0.0.0.0') */
  ip?: string;
  /** Optional user identifier */
  userId?: string;
  /** Route path to check (defaults to '/') */
  route?: string;
  /** HTTP method (defaults to 'GET') */
  method?: string;
}

/**
 * Formats a Unix epoch millisecond timestamp as a human-readable date string.
 *
 * @param epochMs Unix epoch milliseconds.
 * @returns Formatted date string, e.g. "2024-01-01 10:00:30".
 */
function formatResetTime(epochMs: number): string {
  if (epochMs === 0) return 'N/A';
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/**
 * Left-pads a string to the given width using spaces.
 *
 * @param value  String value to pad.
 * @param width  Target column width.
 * @returns Padded string.
 */
function col(value: string | number, width: number): string {
  const s = String(value);
  return s + ' '.repeat(Math.max(0, width - s.length));
}

/**
 * Display rate limit status for a given context.
 *
 * Connects to Redis via the provided config, calls `limiter.status()` for
 * each relevant dimension, and prints a formatted multi-dimension table.
 *
 * @param args   Parsed CLI arguments (ip, userId, route, method).
 * @param config Top-level rate limiter configuration.
 * @returns Resolves when output has been printed and the limiter shut down.
 */
export async function runStatusCommand(
  args: StatusArgs,
  config: RateLimiterConfig,
): Promise<void> {
  const ip = args.ip ?? '0.0.0.0';
  const userId = args.userId;
  const route = args.route ?? '/';
  const method = args.method ?? 'GET';

  const limiter = new RateLimiter(config);
  await limiter.connect();

  try {
    const result: RateLimitResult = await limiter.status({
      ip,
      userId,
      route,
      method,
    });

    console.log('');
    console.log('Rate Limit Status');
    console.log('=================');
    console.log(`IP:      ${ip}`);
    console.log(`Route:   ${method.toUpperCase()} ${route}`);
    if (userId !== undefined) {
      console.log(`User:    ${userId}`);
    }
    console.log('');

    // Column widths
    const DIM_W = 11;
    const EFF_W = 10;
    const LIM_W = 6;
    const REM_W = 10;
    const RST_W = 20;

    const header =
      col('Dimension', DIM_W) +
      '  ' +
      col('Effective', EFF_W) +
      '  ' +
      col('Limit', LIM_W) +
      '  ' +
      col('Remaining', REM_W) +
      '  ' +
      col('Reset', RST_W);

    const separator =
      '-'.repeat(DIM_W) +
      '  ' +
      '-'.repeat(EFF_W) +
      '  ' +
      '-'.repeat(LIM_W) +
      '  ' +
      '-'.repeat(REM_W) +
      '  ' +
      '-'.repeat(RST_W);

    console.log(header);
    console.log(separator);

    const dimension = result.dimension === 'none' ? 'all' : result.dimension;
    const resetStr = formatResetTime(result.resetAt);

    console.log(
      col(dimension, DIM_W) +
        '  ' +
        col(Math.round(result.effective), EFF_W) +
        '  ' +
        col(result.limit === Infinity ? 'inf' : result.limit, LIM_W) +
        '  ' +
        col(result.remaining === Infinity ? 'inf' : result.remaining, REM_W) +
        '  ' +
        col(resetStr, RST_W),
    );

    console.log('');

    if (!result.allowed) {
      console.log(`Status: DENIED (dimension: ${result.dimension})`);
      if (result.retryAfter !== undefined) {
        console.log(`Retry-After: ${result.retryAfter}ms`);
      }
    } else {
      console.log('Status: ALLOWED');
    }
    console.log('');
  } finally {
    await limiter.shutdown();
  }
}
