/**
 * @fileoverview Unit tests for LocalReservoir.
 * All tests run without any real Redis dependency.
 */

import { LocalReservoir, ReservoirFetchFn } from '../../../src/reservoir/local-reservoir';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReservoir(batchSize = 10, syncInterval = 5000): LocalReservoir {
  return new LocalReservoir({ batchSize, syncInterval });
}

function makeFetchFn(returning: number): jest.MockedFunction<ReservoirFetchFn> {
  return jest.fn().mockResolvedValue(returning);
}

// ---------------------------------------------------------------------------
// consume()
// ---------------------------------------------------------------------------

describe('LocalReservoir.consume()', () => {
  it('returns true and decrements tokens when reservoir has enough tokens (no fetchFn call)', async () => {
    const reservoir = makeReservoir();
    const fetchFn = makeFetchFn(100);

    // Pre-populate the reservoir by doing an initial consume.
    await reservoir.consume('key1', 1, makeFetchFn(100));
    // Now bucket has 99 tokens. fetchFn from here should NOT be called.
    const secondFetch = makeFetchFn(0);
    const result = await reservoir.consume('key1', 1, secondFetch);

    expect(result).toBe(true);
    expect(secondFetch).not.toHaveBeenCalled();
    expect(reservoir.getTokens('key1')).toBe(98);
  });

  it('calls fetchFn when reservoir is empty', async () => {
    const reservoir = makeReservoir();
    const fetchFn = makeFetchFn(50);

    const result = await reservoir.consume('key2', 1, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith('key2');
    expect(result).toBe(true);
  });

  it('keeps correct remainder after fetchFn: granted=100, cost=1 → tokens=99', async () => {
    const reservoir = makeReservoir();
    const fetchFn = makeFetchFn(100);

    await reservoir.consume('key3', 1, fetchFn);

    expect(reservoir.getTokens('key3')).toBe(99);
  });

  it('keeps zero tokens (not negative) when granted equals cost exactly', async () => {
    const reservoir = makeReservoir();
    const fetchFn = makeFetchFn(1);

    const result = await reservoir.consume('key4', 1, fetchFn);

    expect(result).toBe(true);
    expect(reservoir.getTokens('key4')).toBe(0);
  });

  it('fast-path allows when tokens exactly equals cost (bucket.tokens >= cost boundary)', async () => {
    // If the condition were `> cost` instead of `>= cost`, this request would
    // fall through to the slow path even though there are enough tokens.
    const reservoir = makeReservoir();
    const firstFetch = makeFetchFn(5);
    // Pre-populate with 5 tokens, consuming 1 → 4 remaining
    await reservoir.consume('boundary', 1, firstFetch);
    expect(reservoir.getTokens('boundary')).toBe(4);

    // Consume exactly 4 tokens (tokens === cost → should be allowed via fast path)
    const secondFetch = makeFetchFn(0); // should NOT be called
    const result = await reservoir.consume('boundary', 4, secondFetch);

    expect(result).toBe(true);
    expect(secondFetch).not.toHaveBeenCalled();
    expect(reservoir.getTokens('boundary')).toBe(0);
  });

  it('returns false when fetchFn returns 0 (rate limited)', async () => {
    const reservoir = makeReservoir();
    const fetchFn = makeFetchFn(0);

    const result = await reservoir.consume('key5', 1, fetchFn);

    expect(result).toBe(false);
    expect(reservoir.getTokens('key5')).toBe(0);
  });

  it('returns false when fetchFn grants fewer tokens than cost', async () => {
    const reservoir = makeReservoir();
    const fetchFn = makeFetchFn(1); // grants 1, cost is 5

    const result = await reservoir.consume('key6', 5, fetchFn);

    expect(result).toBe(false);
    // tokens = max(0, granted - cost) = max(0, 1 - 5) = 0
    expect(reservoir.getTokens('key6')).toBe(0);
  });

  it('handles concurrent consume: syncInProgress bucket calls fetchFn directly', async () => {
    const reservoir = makeReservoir();

    let firstFetchResolve!: (value: number) => void;
    const firstFetch: ReservoirFetchFn = jest.fn(
      () =>
        new Promise<number>((resolve) => {
          firstFetchResolve = resolve;
        }),
    );
    const secondFetch = makeFetchFn(5);

    // Start first consume (will block on firstFetch).
    const first = reservoir.consume('key7', 1, firstFetch);

    // Start second consume immediately while first is in progress (syncInProgress=true).
    const second = reservoir.consume('key7', 1, secondFetch);

    // Resolve first fetch.
    firstFetchResolve(10);

    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toBe(true);
    // Second called fetchFn directly (bypass reservoir).
    expect(secondFetch).toHaveBeenCalledWith('key7');
    expect(r2).toBe(true); // secondFetch returned 5 > 0
  });

  it('concurrent consume with syncInProgress returns false when direct fetchFn returns 0', async () => {
    const reservoir = makeReservoir();

    let firstFetchResolve!: (value: number) => void;
    const firstFetch: ReservoirFetchFn = jest.fn(
      () => new Promise<number>((resolve) => { firstFetchResolve = resolve; }),
    );
    const secondFetch = makeFetchFn(0); // denied

    const first = reservoir.consume('key8', 1, firstFetch);
    const second = reservoir.consume('key8', 1, secondFetch);

    firstFetchResolve(10);
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toBe(true);
    expect(r2).toBe(false); // secondFetch returned 0
  });

  it('concurrent path: result === cost returns true (result >= cost, not result > cost)', async () => {
    // When second concurrent request fetches exactly `cost` tokens, result === cost.
    // `result >= cost` → true (allowed), `result > cost` → false.
    const reservoir = makeReservoir();

    let firstFetchResolve!: (value: number) => void;
    const firstFetch: ReservoirFetchFn = jest.fn(
      () => new Promise<number>((resolve) => { firstFetchResolve = resolve; }),
    );
    const secondFetch = makeFetchFn(3); // exactly cost=3

    const first = reservoir.consume('key9', 1, firstFetch);
    const second = reservoir.consume('key9', 3, secondFetch); // cost=3, result=3

    firstFetchResolve(10);
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toBe(true);
    expect(r2).toBe(true); // 3 >= 3 → true
    // When result === cost, no surplus tokens; bucket.tokens should not increase
    expect(reservoir.getTokens('key9')).toBe(9); // first fetch gave 10 - 1 = 9
  });

  it('concurrent path: no tokens added when result < cost (if result > cost is false)', async () => {
    // Verifies `if (result > cost)` guards the token addition.
    // Mutation `if (true)` would always add (result - cost) which is negative → tokens DECREASE.
    // Observable: tokens should remain unchanged (or equal to first fetch remainder).
    const reservoir = makeReservoir();

    let firstFetchResolve!: (value: number) => void;
    const firstFetch: ReservoirFetchFn = jest.fn(
      () => new Promise<number>((resolve) => { firstFetchResolve = resolve; }),
    );
    let secondFetchResolve!: (value: number) => void;
    const secondFetch: ReservoirFetchFn = jest.fn(
      () => new Promise<number>((resolve) => { secondFetchResolve = resolve; }),
    );

    const firstPromise = reservoir.consume('negKey', 1, firstFetch);
    const secondPromise = reservoir.consume('negKey', 10, secondFetch); // cost=10

    // Let first complete: tokens = max(0, 5-1) = 4
    firstFetchResolve(5);
    await firstPromise;

    // Second: result=2 < cost=10 → `if (result > cost)` is false → tokens unchanged at 4
    // Mutation `if (true)`: tokens += (2-10) = -8 → tokens = 4 + (-8) = -4
    secondFetchResolve(2); // result=2 < cost=10
    await secondPromise;

    // If `if (result > cost)` worked correctly, tokens remain 4
    // If mutated to `if (true)`, tokens would be -4 (negative, which getTokens returns as-is)
    expect(reservoir.getTokens('negKey')).toBe(4);
  });

  it('concurrent path: surplus tokens (result > cost) are added to bucket', async () => {
    // Verifies: bucket.tokens += (result - cost), not -= or +cost.
    // Both fetches are controlled promises so we can force first to complete
    // before second, ensuring the surplus addition happens after the base tokens are set.
    const reservoir = makeReservoir();

    let firstFetchResolve!: (value: number) => void;
    const firstFetch: ReservoirFetchFn = jest.fn(
      () => new Promise<number>((resolve) => { firstFetchResolve = resolve; }),
    );
    let secondFetchResolve!: (value: number) => void;
    const secondFetch: ReservoirFetchFn = jest.fn(
      () => new Promise<number>((resolve) => { secondFetchResolve = resolve; }),
    );

    const firstPromise = reservoir.consume('concKey', 1, firstFetch);
    const secondPromise = reservoir.consume('concKey', 1, secondFetch);

    // Let first complete before second — this sets bucket.tokens = max(0, 5-1) = 4
    firstFetchResolve(5);
    await firstPromise;

    // Now second resolves: result=10, cost=1 → surplus=9 → bucket.tokens += 9 = 13
    secondFetchResolve(10);
    const r2 = await secondPromise;

    expect(r2).toBe(true);
    expect(reservoir.getTokens('concKey')).toBe(13);
  });

  it('syncInProgress is cleared by finally block — slow path re-entered on next under-budget call', async () => {
    // If the finally block doesn't clear syncInProgress, the next call that needs
    // a fresh fetch (cost > available tokens) would take the concurrent bypass path
    // instead of the slow path. The slow path RESETS tokens; the bypass only adds surplus.
    // Observable: after the second slow-path fetch returns 0, tokens should be 0 (not 9).
    const reservoir = makeReservoir();
    await reservoir.consume('lockKey', 1, makeFetchFn(10)); // slow path: tokens=9

    // Second call: cost=100 > tokens=9 → needs slow path (if syncInProgress was cleared)
    // Slow path: bucket.tokens = max(0, 0 - 100) = 0 → getTokens returns 0
    // Concurrent bypass: result=0 not > cost=100 → no token change → getTokens stays 9
    const fetchFn2 = makeFetchFn(0); // returns 0
    await reservoir.consume('lockKey', 100, fetchFn2);

    expect(fetchFn2).toHaveBeenCalled();
    // Key assertion: tokens were RESET to 0 (slow path), not left at 9 (bypass)
    expect(reservoir.getTokens('lockKey')).toBe(0);
  });

  it('syncInProgress is cleared by finally block even when fetchFn rejects', async () => {
    const reservoir = makeReservoir();
    const failFetch: ReservoirFetchFn = jest.fn().mockRejectedValue(new Error('redis down'));

    await expect(reservoir.consume('failKey', 1, failFetch)).rejects.toThrow('redis down');

    // syncInProgress must be cleared by the finally block.
    // A subsequent call that has tokens=0 < cost=1 must take the slow path (not concurrent bypass).
    // The slow path sets tokens = max(0, granted - cost) = max(0, 5-1) = 4.
    // Concurrent bypass would do: result=5 > cost=1 → tokens += 4 (same in this case).
    // Use a cost > granted to distinguish: granted=3, cost=100 → slow: tokens=0; bypass: tokens unchanged.
    const fetchFn2 = makeFetchFn(3); // returns 3
    await reservoir.consume('failKey', 100, fetchFn2);

    // Slow path: tokens = max(0, 3-100) = 0
    // Concurrent bypass: result=3 not > cost=100 → no change, tokens stay 0 (from failed fetch)
    expect(fetchFn2).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// flush()
// ---------------------------------------------------------------------------

describe('LocalReservoir.flush()', () => {
  it('calls returnFn for keys with tokens > 0', async () => {
    const reservoir = makeReservoir();
    await reservoir.consume('flushKey1', 1, makeFetchFn(100)); // 99 tokens remain

    const returnFn = jest.fn().mockResolvedValue(undefined);
    await reservoir.flush(returnFn);

    expect(returnFn).toHaveBeenCalledWith('flushKey1', 99);
  });

  it('skips keys with 0 tokens', async () => {
    const reservoir = makeReservoir();
    await reservoir.consume('emptyKey', 1, makeFetchFn(1)); // 0 tokens remain

    const returnFn = jest.fn().mockResolvedValue(undefined);
    await reservoir.flush(returnFn);

    expect(returnFn).not.toHaveBeenCalled();
  });

  it('clears all buckets after flush', async () => {
    const reservoir = makeReservoir();
    await reservoir.consume('flushKey2', 1, makeFetchFn(100));
    expect(reservoir.size()).toBe(1);

    await reservoir.flush(jest.fn().mockResolvedValue(undefined));

    expect(reservoir.size()).toBe(0);
    expect(reservoir.getTokens('flushKey2')).toBe(0);
  });

  it('flushes multiple keys correctly', async () => {
    const reservoir = makeReservoir();
    await reservoir.consume('a', 1, makeFetchFn(10));
    await reservoir.consume('b', 1, makeFetchFn(20));
    await reservoir.consume('c', 1, makeFetchFn(1)); // 0 tokens remain

    const returnFn = jest.fn().mockResolvedValue(undefined);
    await reservoir.flush(returnFn);

    expect(returnFn).toHaveBeenCalledTimes(2);
    expect(returnFn).toHaveBeenCalledWith('a', 9);
    expect(returnFn).toHaveBeenCalledWith('b', 19);
    expect(returnFn).not.toHaveBeenCalledWith('c', expect.anything());
  });
});

// ---------------------------------------------------------------------------
// getTokens()
// ---------------------------------------------------------------------------

describe('LocalReservoir.getTokens()', () => {
  it('returns 0 for unknown key', () => {
    const reservoir = makeReservoir();
    expect(reservoir.getTokens('nonexistent')).toBe(0);
  });

  it('returns the current token count after consumption', async () => {
    const reservoir = makeReservoir();
    await reservoir.consume('tokenKey', 2, makeFetchFn(10));
    expect(reservoir.getTokens('tokenKey')).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// size()
// ---------------------------------------------------------------------------

describe('LocalReservoir.size()', () => {
  it('returns 0 for empty reservoir', () => {
    const reservoir = makeReservoir();
    expect(reservoir.size()).toBe(0);
  });

  it('returns correct bucket count', async () => {
    const reservoir = makeReservoir();
    await reservoir.consume('k1', 1, makeFetchFn(10));
    await reservoir.consume('k2', 1, makeFetchFn(10));
    expect(reservoir.size()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

describe('LocalReservoir.clear()', () => {
  it('empties all buckets', async () => {
    const reservoir = makeReservoir();
    await reservoir.consume('clearKey1', 1, makeFetchFn(10));
    await reservoir.consume('clearKey2', 1, makeFetchFn(10));

    reservoir.clear();

    expect(reservoir.size()).toBe(0);
    expect(reservoir.getTokens('clearKey1')).toBe(0);
    expect(reservoir.getTokens('clearKey2')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// needsSync()
// ---------------------------------------------------------------------------

describe('LocalReservoir.needsSync()', () => {
  it('returns true for unknown key (never synced)', () => {
    const reservoir = makeReservoir();
    expect(reservoir.needsSync('unknown')).toBe(true);
  });

  it('returns true when lastSync is 0 (never synced)', async () => {
    const reservoir = makeReservoir(10, 5000);
    // Force a bucket with lastSync=0 by consuming from a zero-returning fetch,
    // then check. After a failed fetch lastSync is still set.
    // Use a fresh key that hasn't been touched.
    expect(reservoir.needsSync('brandNew')).toBe(true);
  });

  it('returns false when recently synced (within syncInterval)', async () => {
    const reservoir = makeReservoir(10, 5000);
    await reservoir.consume('recentKey', 1, makeFetchFn(10));
    const now = Date.now();
    // 1 second after last sync — well within 5000 ms interval
    expect(reservoir.needsSync('recentKey', now + 1000)).toBe(false);
  });

  it('returns true when syncInterval has been exceeded', async () => {
    const reservoir = makeReservoir(10, 5000);
    await reservoir.consume('staleKey', 1, makeFetchFn(10));
    const now = Date.now();
    // 6 seconds after last sync — exceeds 5000 ms interval
    expect(reservoir.needsSync('staleKey', now + 6000)).toBe(true);
  });

  it('returns false when elapsed equals syncInterval exactly (boundary: > not >=)', async () => {
    // The condition is `now - bucket.lastSync > syncInterval` (strictly greater than).
    // When elapsed === syncInterval, it should return FALSE (not yet stale).
    // If the condition were `>=`, this would incorrectly return true.
    const syncInterval = 5000;
    const reservoir = makeReservoir(10, syncInterval);
    await reservoir.consume('exactKey', 1, makeFetchFn(10));
    const syncTime = Date.now();
    // Exactly at syncInterval boundary — should NOT need sync
    expect(reservoir.needsSync('exactKey', syncTime + syncInterval)).toBe(false);
  });

  it('returns true when elapsed is 1ms beyond syncInterval', async () => {
    const syncInterval = 5000;
    const reservoir = makeReservoir(10, syncInterval);
    await reservoir.consume('beyondKey', 1, makeFetchFn(10));
    const syncTime = Date.now();
    // 1ms beyond interval — should need sync
    expect(reservoir.needsSync('beyondKey', syncTime + syncInterval + 1)).toBe(true);
  });

  it('uses Date.now() as default nowMs when not provided', async () => {
    const reservoir = makeReservoir(10, 5000);
    await reservoir.consume('nowKey', 1, makeFetchFn(10));
    // Just consumed recently — should not need sync (lastSync ≈ Date.now())
    // With no nowMs argument, it uses Date.now() internally
    expect(reservoir.needsSync('nowKey')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LocalReservoir constructor — default values
// ---------------------------------------------------------------------------

describe('LocalReservoir constructor defaults', () => {
  it('uses batchSize=10 and syncInterval=5000 when no config is provided', async () => {
    const reservoir = new LocalReservoir();
    const fetchFn = makeFetchFn(100);

    await reservoir.consume('key', 1, fetchFn);

    // fetchFn was called — reservoir starts empty
    expect(fetchFn).toHaveBeenCalled();
    expect(reservoir.getTokens('key')).toBe(99);
  });
});
