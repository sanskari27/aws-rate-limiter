/**
 * @fileoverview CLI command: reset
 *
 * Deletes all Redis rate-limit keys for a given dimension and identifier,
 * effectively resetting the counter for that entity.
 */

import { RateLimiter } from '../../../src/rate-limiter';
import { RateLimiterConfig, ConfigurationError } from '../../../src/core/types';

/** Valid rate-limit dimensions that can be reset */
export type ResetDimension = 'ip' | 'user' | 'route' | 'user-route';

const VALID_DIMENSIONS: ReadonlySet<string> = new Set<ResetDimension>([
  'ip',
  'user',
  'route',
  'user-route',
]);

/** Arguments for the reset command */
export interface ResetArgs {
  /** Which dimension to reset */
  dimension: ResetDimension;
  /** Raw identifier value (IP address, user ID, route string, or "userId:route") */
  identifier: string;
}

/**
 * Reset rate limit counters for a specific dimension and identifier.
 *
 * Validates the dimension, connects to Redis, calls `limiter.reset()`, and
 * prints the number of keys deleted.
 *
 * @param args   Parsed CLI arguments (dimension, identifier).
 * @param config Top-level rate limiter configuration.
 * @returns Resolves when the reset is complete and the limiter shut down.
 * @throws {ConfigurationError} If the dimension is not one of the 4 valid values.
 */
export async function runResetCommand(
  args: ResetArgs,
  config: RateLimiterConfig,
): Promise<void> {
  if (!VALID_DIMENSIONS.has(args.dimension)) {
    throw new ConfigurationError(
      `Invalid dimension "${args.dimension}". ` +
        `Must be one of: ${Array.from(VALID_DIMENSIONS).join(', ')}`,
    );
  }

  if (!args.identifier || args.identifier.trim() === '') {
    throw new ConfigurationError('identifier must be a non-empty string');
  }

  const limiter = new RateLimiter(config);
  await limiter.connect();

  try {
    const deleted = await limiter.reset(args.dimension, args.identifier);
    console.log(
      `Reset: deleted ${deleted} Redis keys for ${args.dimension}:${args.identifier}`,
    );
  } finally {
    await limiter.shutdown();
  }
}
