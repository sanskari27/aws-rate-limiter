/**
 * @fileoverview In-memory token pre-fetch cache that reduces Redis calls by 100x.
 *
 * The reservoir pre-fetches a batch of tokens from Redis atomically using
 * `reservoir_fetch.lua`, then serves subsequent requests from local memory
 * until the batch is exhausted.  Only when the local bucket is empty does it
 * round-trip to Redis again.
 *
 * Over-allow tolerance: up to `batchSize × instances` per window, because each
 * Lambda / container instance pre-fetches independently.
 */

/** Internal state for a single rate-limit key's token bucket. */
interface ReservoirBucket {
  /** Remaining locally pre-fetched tokens for this key. */
  tokens: number;
  /** Unix epoch ms when this bucket last synced with Redis. */
  lastSync: number;
  /** True while a background fetch from Redis is in progress. */
  syncInProgress: boolean;
}

/**
 * A function that fetches (claims) a batch of tokens from Redis for the given key.
 * Implemented externally so that the reservoir is decoupled from the Redis client.
 *
 * @param key - The fully qualified rate-limit Redis key.
 * @returns The number of tokens actually granted by Redis (may be 0 if rate limited).
 */
export interface ReservoirFetchFn {
  (key: string): Promise<number>;
}

/**
 * In-process token reservoir that pre-fetches batches of tokens from Redis,
 * serving hot-path requests from local memory to eliminate per-request Redis round-trips.
 *
 * @example
 * ```typescript
 * const reservoir = new LocalReservoir({ batchSize: 10, syncInterval: 5000 })
 * const allowed = await reservoir.consume('rl:v1:{ip:127.0.0.1}:bucket', 1, fetchFn)
 * ```
 */
export class LocalReservoir {
  private readonly buckets = new Map<string, ReservoirBucket>();
  private readonly batchSize: number;
  private readonly syncInterval: number;

  /**
   * @param config Optional configuration; missing fields use defaults.
   * @param config.batchSize   Number of tokens to claim per Redis batch fetch. Default: 10.
   * @param config.syncInterval Milliseconds before a bucket is considered stale. Default: 5000.
   */
  constructor(config?: { batchSize?: number; syncInterval?: number }) {
    this.batchSize = config?.batchSize ?? 10;
    this.syncInterval = config?.syncInterval ?? 5000;
  }

  /**
   * Try to consume `cost` tokens from the local reservoir for `key`.
   *
   * - If the reservoir has enough tokens: consume and return `true` (no Redis call).
   * - If the reservoir is empty and no sync is in progress: call `fetchFn` to claim
   *   a new batch from Redis, keep the remainder, and return whether the request is allowed.
   * - If a sync is already in progress (concurrent request): call `fetchFn` directly
   *   (bypass the reservoir for this request) and return `true` if any tokens were granted.
   *
   * @param key     Fully qualified Redis key for this rate-limit dimension.
   * @param cost    Number of tokens this request consumes (default 1).
   * @param fetchFn Function that claims a batch of tokens from Redis.
   * @returns `true` if the request is allowed, `false` if it should be denied.
   */
  async consume(key: string, cost: number, fetchFn: ReservoirFetchFn): Promise<boolean> {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: 0, lastSync: 0, syncInProgress: false };
      this.buckets.set(key, bucket);
    }

    // Fast path: enough tokens already cached locally.
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return true;
    }

    // Slow path: need to fetch from Redis.
    if (!bucket.syncInProgress) {
      // Acquire the sync lock for this bucket so concurrent requests don't
      // all pile onto Redis simultaneously.
      bucket.syncInProgress = true;
      try {
        const granted = await fetchFn(key);
        // Keep remainder tokens for subsequent requests.
        bucket.tokens = Math.max(0, granted - cost);
        bucket.lastSync = Date.now();
        return granted >= cost;
      } finally {
        bucket.syncInProgress = false;
      }
    }

    // Another concurrent request is already fetching — bypass reservoir and
    // call fetchFn directly for this request.  Return surplus tokens to the
    // bucket so they are not wasted.
    const result = await fetchFn(key);
    if (result > cost) {
      bucket.tokens += (result - cost);
    }
    return result >= cost;
  }

  /**
   * Return unused pre-fetched tokens to Redis on shutdown.
   *
   * For each key with remaining tokens > 0, calls `returnFn(key, tokens)`.
   * Clears all buckets after the flush completes.
   *
   * @param returnFn Async function that returns `tokens` to Redis for `key`.
   */
  async flush(returnFn: (key: string, tokens: number) => Promise<void>): Promise<void> {
    const flushPromises: Promise<void>[] = [];

    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens > 0) {
        flushPromises.push(returnFn(key, bucket.tokens));
      }
    }

    await Promise.all(flushPromises);
    this.buckets.clear();
  }

  /**
   * Returns the current cached token count for a key.
   *
   * @param key The rate-limit Redis key.
   * @returns Token count, or 0 if the key is not cached.
   */
  getTokens(key: string): number {
    return this.buckets.get(key)?.tokens ?? 0;
  }

  /**
   * Returns the number of keys currently cached in the reservoir.
   *
   * @returns Number of cached keys.
   */
  size(): number {
    return this.buckets.size;
  }

  /**
   * Clears all cached token buckets.
   * Note: this discards pre-fetched tokens without returning them to Redis.
   * For a graceful return, call {@link flush} instead.
   */
  clear(): void {
    this.buckets.clear();
  }

  /**
   * Checks whether a bucket needs a forced background sync because its
   * last sync timestamp has exceeded the configured `syncInterval`.
   *
   * @param key   The rate-limit Redis key.
   * @param nowMs Current time in Unix epoch milliseconds. Defaults to `Date.now()`.
   * @returns `true` if the bucket should be re-synced with Redis.
   */
  needsSync(key: string, nowMs?: number): boolean {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return true;
    const now = nowMs ?? Date.now();
    return now - bucket.lastSync > this.syncInterval;
  }
}
