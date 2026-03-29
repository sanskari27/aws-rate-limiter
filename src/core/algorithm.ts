/**
 * @fileoverview Sliding window counter algorithm — pure functions, no Redis dependency.
 *
 * The core formula is:
 *   weight          = (window_ms - elapsed_ms) / window_ms
 *   effective_count = prev_count * weight + curr_count
 *   allowed         = (effective_count + cost) <= limit
 *
 * "elapsed_ms" is how far the current wall-clock time has advanced inside the
 * current fixed bucket (i.e. `nowMs % windowMs`).  Multiplying prev_count by
 * the remaining weight of the previous bucket gives a smooth, proportional
 * carry-over that avoids the thundering-herd burst at every window boundary.
 */

/**
 * Computes the fractional weight of the previous bucket that should be
 * contributed to the current sliding window.
 *
 * @param windowMs  Window duration in milliseconds (must be > 0).
 * @param nowMs     Current time in Unix epoch milliseconds.
 * @returns         A value in [0, 1]: 1 at the start of a new bucket, 0 at the end.
 */
export function computeWeight(windowMs: number, nowMs: number): number {
  const elapsedMs = nowMs % windowMs;
  return (windowMs - elapsedMs) / windowMs;
}

/**
 * Computes the effective (sliding-window) request count combining the previous
 * and current fixed-size buckets.
 *
 * @param prevCount  Request count in the previous bucket.
 * @param currCount  Request count in the current bucket.
 * @param windowMs   Window duration in milliseconds (must be > 0).
 * @param nowMs      Current time in Unix epoch milliseconds.
 * @returns          Sliding-window effective count (floating point).
 *
 * @example
 * // prev=80, curr=30, window=60 000 ms, elapsed=10 000 ms → ~96.67
 * computeEffectiveCount(80, 30, 60_000, 10_000);
 */
export function computeEffectiveCount(
  prevCount: number,
  currCount: number,
  windowMs: number,
  nowMs: number,
): number {
  const weight = computeWeight(windowMs, nowMs);
  return prevCount * weight + currCount;
}

/**
 * Determines whether a new request (with the given cost) would be allowed
 * under the sliding window limit.
 *
 * @param prevCount  Request count in the previous bucket.
 * @param currCount  Request count in the current bucket (before this request).
 * @param windowMs   Window duration in milliseconds.
 * @param nowMs      Current time in Unix epoch milliseconds.
 * @param limit      Maximum allowed effective count per window.
 * @param cost       Weight of the incoming request (default 1).
 * @returns          `true` if the request should be allowed, `false` otherwise.
 */
export function isAllowed(
  prevCount: number,
  currCount: number,
  windowMs: number,
  nowMs: number,
  limit: number,
  cost: number,
): boolean {
  const effective = computeEffectiveCount(prevCount, currCount, windowMs, nowMs);
  return effective + cost <= limit;
}

/**
 * Computes how many more requests can be made in the current sliding window
 * before the limit is reached.  The result is clamped to 0 — it will never
 * return a negative number.
 *
 * @param prevCount  Request count in the previous bucket.
 * @param currCount  Request count in the current bucket.
 * @param windowMs   Window duration in milliseconds.
 * @param nowMs      Current time in Unix epoch milliseconds.
 * @param limit      Maximum allowed effective count per window.
 * @returns          Non-negative integer representing remaining capacity.
 */
export function computeRemaining(
  prevCount: number,
  currCount: number,
  windowMs: number,
  nowMs: number,
  limit: number,
): number {
  const effective = computeEffectiveCount(prevCount, currCount, windowMs, nowMs);
  return Math.max(0, Math.floor(limit - effective));
}

/**
 * Computes the fixed-size bucket index for a given timestamp.
 *
 * Buckets are aligned to the epoch: bucket = floor(nowMs / windowMs).
 * Two timestamps that fall in the same bucket share the same counter key.
 *
 * @param nowMs     Current time in Unix epoch milliseconds.
 * @param windowMs  Window duration in milliseconds (must be > 0).
 * @returns         Non-negative integer bucket index.
 */
export function computeBucket(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs);
}

/**
 * Computes the number of milliseconds remaining until the current fixed bucket
 * expires (i.e. until the next bucket boundary).
 *
 * This is used to set the Redis TTL so that old keys are automatically evicted.
 * Per spec, the TTL is set to `window_ms * 2` in Lua to ensure both the current
 * and previous buckets remain alive for their full sliding window.
 *
 * @param windowMs  Window duration in milliseconds (must be > 0).
 * @param nowMs     Current time in Unix epoch milliseconds.
 * @returns         Milliseconds until the current window bucket ends (1–windowMs).
 */
export function computeTtlMs(windowMs: number, nowMs: number): number {
  const elapsedMs = nowMs % windowMs;
  return windowMs - elapsedMs;
}

/**
 * Computes the Unix epoch millisecond timestamp at which the *current* fixed
 * bucket ends (i.e. when the window resets for the purposes of the `resetAt`
 * response header).
 *
 * @param nowMs     Current time in Unix epoch milliseconds.
 * @param windowMs  Window duration in milliseconds (must be > 0).
 * @returns         Unix epoch milliseconds when the current bucket expires.
 */
export function computeResetAt(nowMs: number, windowMs: number): number {
  const bucket = computeBucket(nowMs, windowMs);
  return (bucket + 1) * windowMs;
}
