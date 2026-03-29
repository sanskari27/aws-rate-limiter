/**
 * @fileoverview CLI command: health
 *
 * Checks Redis connection health by issuing a PING and (optionally) reading
 * the INFO memory section to report memory statistics.
 */

import type { Redis, Cluster } from 'ioredis';
import { RateLimiterConfig } from '../../../src/core/types';

/** Arguments for the health command */
export interface HealthArgs {
  /** If true, also print Redis memory info section */
  verbose?: boolean;
}

/**
 * Parses selected fields from the Redis INFO memory response.
 *
 * Extracts `used_memory_human`, `maxmemory`, and `mem_fragmentation_ratio`.
 *
 * @param info Raw multi-line INFO response string.
 * @returns Record of field names to their string values.
 */
function parseMemoryInfo(info: string): Record<string, string> {
  const wanted = new Set([
    'used_memory_human',
    'maxmemory',
    'mem_fragmentation_ratio',
  ]);
  const result: Record<string, string> = {};
  for (const line of info.split('\n')) {
    const [rawKey, rawVal] = line.split(':');
    if (rawKey === undefined || rawVal === undefined) continue;
    const key = rawKey.trim();
    if (wanted.has(key)) {
      result[key] = rawVal.trim();
    }
  }
  return result;
}

/**
 * Check Redis connection health.
 *
 * Issues a PING to Redis and records round-trip latency. In verbose mode
 * also retrieves the INFO memory section and prints key statistics.
 *
 * @param args        Parsed CLI arguments (verbose flag).
 * @param _config     Top-level rate limiter config (reserved for future use).
 * @param redisClient Active ioredis Redis or Cluster instance.
 * @returns Resolves when health output has been printed.
 */
export async function runHealthCommand(
  args: HealthArgs,
  _config: RateLimiterConfig,
  redisClient: Redis | Cluster,
): Promise<void> {
  console.log('');
  console.log('Redis Health');
  console.log('============');

  const start = Date.now();
  let pingOk = false;
  let pingError: string | null = null;

  try {
    const pong = await (redisClient as Redis).ping();
    pingOk = pong === 'PONG';
  } catch (err: unknown) {
    pingOk = false;
    pingError = err instanceof Error ? err.message : String(err);
  }

  const latencyMs = Date.now() - start;
  const statusSymbol = pingOk ? 'Connected' : 'DISCONNECTED';

  console.log(`Status:    ${pingOk ? '\u2713' : '\u2717'} ${statusSymbol}`);
  if (pingOk) {
    console.log(`Ping:      OK (${latencyMs}ms)`);
  } else {
    console.log(`Ping:      FAILED${pingError !== null ? ` - ${pingError}` : ''}`);
  }

  if (args.verbose === true && pingOk) {
    try {
      const infoRaw = await (redisClient as Redis).info('memory');
      const fields = parseMemoryInfo(infoRaw);

      console.log('');
      const fieldNames = [
        'used_memory_human',
        'maxmemory',
        'mem_fragmentation_ratio',
      ] as const;
      fieldNames.forEach((field, idx) => {
        const val = fields[field] ?? 'N/A';
        const prefix = idx === 0 ? 'Memory:    ' : '           ';
        console.log(`${prefix}${field}: ${val}`);
      });
    } catch {
      console.log('Memory:    Unable to retrieve INFO memory');
    }
  }

  console.log('');
}
