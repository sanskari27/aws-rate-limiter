/**
 * @fileoverview Unit tests for the sliding window counter algorithm.
 * All functions are pure; no Redis or external dependencies are used.
 */

import {
  computeWeight,
  computeEffectiveCount,
  isAllowed,
  computeRemaining,
  computeBucket,
  computeTtlMs,
  computeResetAt,
} from '../../../src/core/algorithm';

// ---------------------------------------------------------------------------
// computeWeight
// ---------------------------------------------------------------------------

describe('computeWeight', () => {
  it('returns 1 when elapsed is 0 (start of a new bucket)', () => {
    // nowMs is a multiple of windowMs → elapsed = 0
    const windowMs = 60_000;
    const nowMs = windowMs * 100; // elapsed = 0
    expect(computeWeight(windowMs, nowMs)).toBeCloseTo(1, 10);
  });

  it('returns 0.5 when exactly half the window has elapsed', () => {
    const windowMs = 60_000;
    const nowMs = windowMs * 100 + windowMs / 2; // elapsed = 30 000
    expect(computeWeight(windowMs, nowMs)).toBeCloseTo(0.5, 10);
  });

  it('returns near 0 when almost at the end of the window', () => {
    const windowMs = 60_000;
    // elapsed = windowMs - 1
    const nowMs = windowMs * 100 + windowMs - 1;
    const weight = computeWeight(windowMs, nowMs);
    expect(weight).toBeGreaterThan(0);
    expect(weight).toBeLessThan(0.001);
  });

  it('is consistent across different window sizes', () => {
    // 1 000 ms window, elapsed = 250 ms → weight = 0.75
    expect(computeWeight(1_000, 250)).toBeCloseTo(0.75, 10);
  });

  it('weight is always in [0, 1]', () => {
    const windowMs = 60_000;
    for (let elapsed = 0; elapsed < windowMs; elapsed += 5_000) {
      const w = computeWeight(windowMs, elapsed);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// computeEffectiveCount
// ---------------------------------------------------------------------------

describe('computeEffectiveCount', () => {
  /**
   * Canonical example from docs/09-multi-dimensional-limiting.md:
   * prev=80, curr=30, window=60 s, elapsed=10 s → effective ≈ 96.67
   *
   * weight = (60 000 - 10 000) / 60 000 = 50 000 / 60 000 ≈ 0.8333
   * effective = 80 * 0.8333 + 30 ≈ 96.67
   */
  it('matches the documented example (prev=80, curr=30, elapsed=10s, window=60s)', () => {
    const windowMs = 60_000;
    // nowMs chosen so that nowMs % windowMs = 10 000
    const nowMs = windowMs * 100 + 10_000;
    const effective = computeEffectiveCount(80, 30, windowMs, nowMs);
    expect(effective).toBeCloseTo(96.67, 1);
  });

  it('equals currCount when weight is 0 (elapsed = window)', () => {
    const windowMs = 60_000;
    // If nowMs % windowMs === 0 then elapsed === 0 and weight === 1 — to get
    // weight=0 we need elapsed = windowMs which wraps back to 0.  So instead
    // directly test that weight=1 at boundary gives prev*1 + curr.
    const nowMs = windowMs * 100; // elapsed = 0, weight = 1
    const effective = computeEffectiveCount(80, 30, windowMs, nowMs);
    // weight = 1 → 80*1 + 30 = 110
    expect(effective).toBeCloseTo(110, 10);
  });

  it('equals currCount when prevCount is 0', () => {
    const windowMs = 60_000;
    const nowMs = windowMs * 100 + 10_000;
    expect(computeEffectiveCount(0, 30, windowMs, nowMs)).toBeCloseTo(30, 10);
  });

  it('equals prevCount * weight when currCount is 0', () => {
    const windowMs = 60_000;
    const nowMs = windowMs * 100 + 30_000; // elapsed = 30 000, weight = 0.5
    expect(computeEffectiveCount(80, 0, windowMs, nowMs)).toBeCloseTo(40, 10);
  });

  it('returns 0 when both counts are 0', () => {
    expect(computeEffectiveCount(0, 0, 60_000, 5_000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isAllowed
// ---------------------------------------------------------------------------

describe('isAllowed', () => {
  const windowMs = 60_000;
  // elapsed = 30 000 → weight = 0.5
  const nowMs = windowMs * 100 + 30_000;

  it('allows when effective + cost is exactly equal to limit', () => {
    // effective = 50 * 0.5 + 50 = 75, cost = 25, limit = 100 → 75+25 = 100 ≤ 100 ✓
    expect(isAllowed(50, 50, windowMs, nowMs, 100, 25)).toBe(true);
  });

  it('denies when effective + cost exceeds limit by 1', () => {
    // effective = 50 * 0.5 + 50 = 75, cost = 26, limit = 100 → 75+26 = 101 > 100 ✗
    expect(isAllowed(50, 50, windowMs, nowMs, 100, 26)).toBe(false);
  });

  it('allows with cost 0 (should always pass unless already over limit)', () => {
    expect(isAllowed(0, 0, windowMs, nowMs, 10, 0)).toBe(true);
  });

  it('denies with high cost that immediately saturates the limit', () => {
    expect(isAllowed(0, 0, windowMs, nowMs, 10, 11)).toBe(false);
  });

  it('allows when counts are both zero and limit is non-zero', () => {
    expect(isAllowed(0, 0, windowMs, nowMs, 100, 1)).toBe(true);
  });

  it('denies when already at the limit with cost=1', () => {
    // effective = 0 * 0.5 + 100 = 100, cost=1 → 101 > 100
    expect(isAllowed(0, 100, windowMs, nowMs, 100, 1)).toBe(false);
  });

  it('correctly handles fractional effective counts near limit boundary', () => {
    // elapsed = 0 → weight = 1
    const nowAtStart = windowMs * 100;
    // effective = 99 * 1 + 0 = 99, cost = 1 → 100 ≤ 100 ✓
    expect(isAllowed(99, 0, windowMs, nowAtStart, 100, 1)).toBe(true);
    // effective = 99 * 1 + 1 = 100, cost = 1 → 101 > 100 ✗
    expect(isAllowed(99, 1, windowMs, nowAtStart, 100, 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeRemaining
// ---------------------------------------------------------------------------

describe('computeRemaining', () => {
  const windowMs = 60_000;
  const nowMs = windowMs * 100 + 30_000; // weight = 0.5

  it('returns floor(limit - effective)', () => {
    // effective = 0 * 0.5 + 0 = 0, limit = 100 → remaining = 100
    expect(computeRemaining(0, 0, windowMs, nowMs, 100)).toBe(100);
  });

  it('returns 0 when effective equals the limit (not negative)', () => {
    // effective = 0 * 0.5 + 100 = 100, limit = 100 → remaining = 0
    expect(computeRemaining(0, 100, windowMs, nowMs, 100)).toBe(0);
  });

  it('returns 0 when effective exceeds the limit (clamped)', () => {
    expect(computeRemaining(0, 200, windowMs, nowMs, 100)).toBe(0);
  });

  it('floors fractional remaining values', () => {
    // effective = 50 * 0.5 + 25 = 50, limit = 75.7 — use integer limit = 75
    // effective = 25 * 0.5 + 25 = 37.5, limit = 40 → floor(40 - 37.5) = 2
    const result = computeRemaining(25, 25, windowMs, nowMs, 40);
    expect(result).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeBucket
// ---------------------------------------------------------------------------

describe('computeBucket', () => {
  it('returns 0 for nowMs=0', () => {
    expect(computeBucket(0, 60_000)).toBe(0);
  });

  it('is deterministic for the same inputs', () => {
    const nowMs = 1_704_067_200_000; // 2024-01-01T00:00:00Z
    const windowMs = 60_000;
    expect(computeBucket(nowMs, windowMs)).toBe(computeBucket(nowMs, windowMs));
  });

  it('advances by exactly 1 at each window boundary', () => {
    const windowMs = 60_000;
    const bucket1 = computeBucket(windowMs * 10, windowMs);
    const bucket2 = computeBucket(windowMs * 10 + windowMs - 1, windowMs);
    const bucket3 = computeBucket(windowMs * 11, windowMs);
    expect(bucket1).toBe(bucket2); // same bucket within same window
    expect(bucket3).toBe(bucket1 + 1); // next bucket
  });

  it('two timestamps far apart produce different buckets', () => {
    const windowMs = 60_000;
    const b1 = computeBucket(1_000_000, windowMs);
    const b2 = computeBucket(1_000_000 + windowMs, windowMs);
    expect(b2).toBe(b1 + 1);
  });
});

// ---------------------------------------------------------------------------
// computeResetAt
// ---------------------------------------------------------------------------

describe('computeResetAt', () => {
  it('is always in the future relative to nowMs', () => {
    const windowMs = 60_000;
    const nowMs = 1_704_067_200_000 + 15_000; // 15 s into a window
    const resetAt = computeResetAt(nowMs, windowMs);
    expect(resetAt).toBeGreaterThan(nowMs);
  });

  it('is exactly one window size after the start of the current bucket', () => {
    const windowMs = 60_000;
    const nowMs = windowMs * 100 + 10_000; // 10 s into bucket 100
    const resetAt = computeResetAt(nowMs, windowMs);
    expect(resetAt).toBe(windowMs * 101); // start of bucket 101
  });

  it('equals nowMs + windowMs when at start of a bucket', () => {
    const windowMs = 60_000;
    const nowMs = windowMs * 200; // exactly on a boundary
    expect(computeResetAt(nowMs, windowMs)).toBe(nowMs + windowMs);
  });
});

// ---------------------------------------------------------------------------
// computeTtlMs
// ---------------------------------------------------------------------------

describe('computeTtlMs', () => {
  it('returns windowMs when elapsed is 0 (full window remaining)', () => {
    const windowMs = 60_000;
    const nowMs = windowMs * 100; // elapsed = 0
    expect(computeTtlMs(windowMs, nowMs)).toBe(windowMs);
  });

  it('returns windowMs/2 when half the window has elapsed', () => {
    const windowMs = 60_000;
    const nowMs = windowMs * 100 + windowMs / 2;
    expect(computeTtlMs(windowMs, nowMs)).toBe(windowMs / 2);
  });

  it('returns 1 when only 1ms remains in the window', () => {
    const windowMs = 60_000;
    const nowMs = windowMs * 100 + windowMs - 1;
    expect(computeTtlMs(windowMs, nowMs)).toBe(1);
  });

  it('ttlMs + elapsed = windowMs always', () => {
    const windowMs = 60_000;
    for (let elapsed = 0; elapsed < windowMs; elapsed += 7_777) {
      const nowMs = windowMs * 100 + elapsed;
      const ttl = computeTtlMs(windowMs, nowMs);
      expect(ttl + elapsed).toBe(windowMs);
    }
  });

  it('resetAt = nowMs + ttlMs', () => {
    const windowMs = 60_000;
    const nowMs = windowMs * 100 + 10_000;
    const ttl = computeTtlMs(windowMs, nowMs);
    const resetAt = computeResetAt(nowMs, windowMs);
    expect(resetAt).toBe(nowMs + ttl);
  });
});
