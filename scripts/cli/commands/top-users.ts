/**
 * @fileoverview CLI command: top-users
 *
 * Finds the top N identifiers by request volume for a given dimension using
 * cursor-based Redis SCAN (never KEYS — KEYS blocks Redis).
 */

import type { Redis, Cluster } from 'ioredis';
import { RateLimiterConfig } from '../../../src/core/types';

/** Arguments for the top-users command */
export interface TopUsersArgs {
  /** Dimension to scan: 'user' | 'ip' | 'route'. Defaults to 'user' */
  dimension?: string;
  /** Maximum number of results to display. Defaults to 10 */
  limit?: number;
  /** Window size in seconds for bucket computation. Defaults to 60 */
  window?: number;
}

/** A key/count pair discovered during the SCAN sweep */
interface KeyCount {
  key: string;
  count: number;
}

/**
 * Performs a non-blocking cursor-based Redis SCAN for keys matching a pattern.
 *
 * Uses COUNT 100 per iteration so each call returns a reasonable batch.
 * Iterates until the cursor wraps back to "0".
 *
 * @param client  Connected ioredis Redis or Cluster instance.
 * @param pattern Glob pattern to match keys against, e.g. `rl:v1:*user*:28433334`.
 * @returns Array of all matching key names.
 */
export async function scanKeys(
  client: Redis | Cluster,
  pattern: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await (client as Redis).scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      100,
    );
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

/**
 * Display the top N identifiers by current request count.
 *
 * Algorithm:
 * 1. Compute the current time-bucket for the given window.
 * 2. Build a SCAN pattern: `rl:v1:*{dimension}*:{bucket}`.
 * 3. SCAN all matching keys (cursor-based, non-blocking).
 * 4. GET each key's count value.
 * 5. Sort descending and print the top N.
 *
 * @param args        Parsed CLI arguments (dimension, limit, window).
 * @param _config     Top-level rate limiter config (reserved for future use).
 * @param redisClient Active ioredis Redis or Cluster instance.
 * @returns Resolves when the table has been printed.
 */
export async function runTopUsersCommand(
  args: TopUsersArgs,
  _config: RateLimiterConfig,
  redisClient: Redis | Cluster,
): Promise<void> {
  const dimension = args.dimension ?? 'user';
  const limit = args.limit ?? 10;
  const windowSec = args.window ?? 60;
  const windowMs = windowSec * 1000;

  const bucket = Math.floor(Date.now() / windowMs);
  const pattern = `rl:v1:*${dimension}*:${bucket}`;

  console.log('');
  console.log(`Top ${limit} Users by Request Volume`);
  console.log('==============================');
  console.log(`Window: ${windowSec}s | Bucket: ${bucket}`);
  console.log('');

  const keys = await scanKeys(redisClient, pattern);

  if (keys.length === 0) {
    console.log(`No keys found matching pattern: ${pattern}`);
    console.log('');
    return;
  }

  // Fetch all counts in parallel
  const keyCountPairs: KeyCount[] = await Promise.all(
    keys.map(async (key): Promise<KeyCount> => {
      const raw = await (redisClient as Redis).get(key);
      const count = raw !== null ? parseInt(raw, 10) : 0;
      return { key, count: isNaN(count) ? 0 : count };
    }),
  );

  // Sort descending by count and take top N
  keyCountPairs.sort((a, b) => b.count - a.count);
  const topN = keyCountPairs.slice(0, limit);

  // Extract the identifier portion from the key: rl:v1:{identifier}:bucket
  const extractIdentifier = (key: string): string => {
    // Key format: rl:v1:{tag}:bucket
    // The hash-tag is wrapped in braces: {user:abc123}
    const match = key.match(/\{([^}]+)\}/);
    if (match !== null) return match[1];
    // Fallback: strip prefix and suffix
    const parts = key.split(':');
    if (parts.length >= 4) {
      return parts.slice(2, -1).join(':');
    }
    return key;
  };

  // Column widths
  const RANK_W = 5;
  const ID_W = 24;
  const COUNT_W = 6;

  const header =
    'Rank'.padEnd(RANK_W) +
    '  ' +
    'Identifier'.padEnd(ID_W) +
    '  ' +
    'Count'.padEnd(COUNT_W);

  const separator =
    '-'.repeat(RANK_W) + '  ' + '-'.repeat(ID_W) + '  ' + '-'.repeat(COUNT_W);

  console.log(header);
  console.log(separator);

  topN.forEach(({ key, count }, idx) => {
    const rank = String(idx + 1).padEnd(RANK_W);
    const identifier = extractIdentifier(key).padEnd(ID_W);
    const countStr = String(count).padEnd(COUNT_W);
    console.log(`${rank}  ${identifier}  ${countStr}`);
  });

  console.log('');
}
