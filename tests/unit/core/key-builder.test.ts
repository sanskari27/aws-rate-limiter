/**
 * @fileoverview Unit tests for Redis key construction and normalization utilities.
 */

import {
  normalizeRoute,
  normalizeIP,
  hashIdentifier,
  buildIPKey,
  buildRouteKey,
  buildUserKey,
  buildUserRouteKey,
  buildKeyPair,
} from '../../../src/core/key-builder';
import { KeyBuilderError } from '../../../src/core/types';

// ---------------------------------------------------------------------------
// normalizeRoute
// ---------------------------------------------------------------------------

describe('normalizeRoute', () => {
  it('strips UUIDs and replaces with PARAM', () => {
    const result = normalizeRoute('GET', '/api/users/550e8400-e29b-41d4-a716-446655440000');
    expect(result).toBe('GET__api_users_PARAM');
  });

  it('strips numeric IDs from path segments', () => {
    const result = normalizeRoute('GET', '/api/orders/12345');
    expect(result).toBe('GET__api_orders_PARAM');
  });

  it('strips Unix timestamps (10+ digit numbers)', () => {
    const result = normalizeRoute('GET', '/api/events/1704067200');
    expect(result).toBe('GET__api_events_PARAM');
  });

  it('strips query strings', () => {
    const result = normalizeRoute('GET', '/api/users?page=1&limit=20');
    // Query string is removed; the remaining path normalizes to "GET__api_users"
    expect(result).toBe('GET__api_users');
  });

  it('lowercases the path', () => {
    const result = normalizeRoute('GET', '/API/Users');
    expect(result).toBe('GET__api_users');
  });

  it('replaces slashes and unsafe chars with underscores', () => {
    const result = normalizeRoute('POST', '/api/v2/orders');
    expect(result).toContain('POST_');
    expect(result).not.toContain('/');
  });

  it('uppercases the HTTP method', () => {
    const result = normalizeRoute('get', '/api/users');
    expect(result.startsWith('GET_')).toBe(true);
  });

  it('handles path with multiple UUIDs', () => {
    const result = normalizeRoute(
      'DELETE',
      '/orgs/550e8400-e29b-41d4-a716-446655440000/users/6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    );
    expect(result).toBe('DELETE__orgs_PARAM_users_PARAM');
  });

  it('handles root path "/"', () => {
    const result = normalizeRoute('GET', '/');
    expect(result).toBe('GET__');
  });

  it('throws KeyBuilderError when method is empty', () => {
    expect(() => normalizeRoute('', '/api/users')).toThrow(KeyBuilderError);
  });

  it('throws with exact message when method is empty', () => {
    expect(() => normalizeRoute('', '/api/users')).toThrow('HTTP method must not be empty');
  });

  it('throws KeyBuilderError when method is whitespace-only', () => {
    expect(() => normalizeRoute('   ', '/api/users')).toThrow(KeyBuilderError);
  });

  it('throws with exact message when method is whitespace-only', () => {
    expect(() => normalizeRoute('   ', '/api/users')).toThrow('HTTP method must not be empty');
  });

  it('throws KeyBuilderError when path is empty', () => {
    expect(() => normalizeRoute('GET', '')).toThrow(KeyBuilderError);
  });

  it('throws with exact message when path is empty', () => {
    expect(() => normalizeRoute('GET', '')).toThrow('Route path must not be empty');
  });

  it('throws KeyBuilderError when path is whitespace-only', () => {
    expect(() => normalizeRoute('GET', '   ')).toThrow(KeyBuilderError);
  });

  it('throws with exact message when path is whitespace-only', () => {
    expect(() => normalizeRoute('GET', '   ')).toThrow('Route path must not be empty');
  });

  it('trims whitespace from method before using it', () => {
    // method.trim() must be called — "  get  " → trimmed → "get" → uppercased → "GET"
    const result = normalizeRoute('  get  ', '/api/users');
    expect(result.startsWith('GET_')).toBe(true);
  });

  it('different paths with same structure produce different normalized keys', () => {
    const a = normalizeRoute('GET', '/api/users');
    const b = normalizeRoute('GET', '/api/orders');
    expect(a).not.toBe(b);
  });

  it('same path with different methods produce different keys', () => {
    const a = normalizeRoute('GET', '/api/users');
    const b = normalizeRoute('POST', '/api/users');
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// normalizeIP
// ---------------------------------------------------------------------------

describe('normalizeIP', () => {
  it('returns IPv4 addresses unchanged', () => {
    expect(normalizeIP('192.168.1.100')).toBe('192.168.1.100');
  });

  it('returns IPv4 loopback unchanged', () => {
    expect(normalizeIP('127.0.0.1')).toBe('127.0.0.1');
  });

  it('collapses a full IPv6 address to the /64 prefix', () => {
    const result = normalizeIP('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
    expect(result).toBe('2001:0db8:85a3:0000::0');
  });

  it('handles compressed IPv6 (::1 loopback)', () => {
    const result = normalizeIP('::1');
    // After expansion first 4 groups are 0000 each.
    expect(result).toBe('0000:0000:0000:0000::0');
  });

  it('handles compressed IPv6 with leading groups (2001:db8::1)', () => {
    const result = normalizeIP('2001:db8::1');
    // After expansion: 2001:0db8:0000:0000:0000:0000:0000:0001
    expect(result).toBe('2001:0db8:0000:0000::0');
  });

  it('two IPv6 addresses in the same /64 subnet normalise to the same string', () => {
    const a = normalizeIP('2001:db8::1');
    const b = normalizeIP('2001:db8::2');
    expect(a).toBe(b);
  });

  it('two IPv6 addresses in different /64 subnets normalise differently', () => {
    const a = normalizeIP('2001:db8:1::1');
    const b = normalizeIP('2001:db8:2::1');
    expect(a).not.toBe(b);
  });

  it('throws KeyBuilderError for empty string', () => {
    expect(() => normalizeIP('')).toThrow(KeyBuilderError);
  });

  it('throws with exact message when IP is empty', () => {
    expect(() => normalizeIP('')).toThrow('IP address must not be empty');
  });

  it('throws KeyBuilderError for whitespace-only IP', () => {
    expect(() => normalizeIP('   ')).toThrow(KeyBuilderError);
  });

  it('throws with exact message when IP is whitespace-only', () => {
    expect(() => normalizeIP('   ')).toThrow('IP address must not be empty');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeIP('  192.168.0.1  ')).toBe('192.168.0.1');
  });

  it('handles "::" (all-zeros IPv6) → first 4 groups all zero', () => {
    // "::" expands to "0000:0000:0000:0000:0000:0000:0000:0000"
    // /64 prefix takes first 4 groups: 0000:0000:0000:0000
    const result = normalizeIP('::');
    expect(result).toBe('0000:0000:0000:0000::0');
  });

  it('"::" special case is handled — not treated as halves.length=2', () => {
    // If "::" falls through to the halves.length===2 path, it would compute
    // missingGroups = 8 - 0 - 0 = 8 and produce 8 zero groups, which is correct.
    // The explicit early-return ensures the exact string "0000:0000:0000:0000:0000:0000:0000:0000".
    // Verify through normalizeIP that "::" → exactly 4 zero groups in /64 prefix.
    expect(normalizeIP('::')).toBe('0000:0000:0000:0000::0');
  });

  it('handles IPv6 address ending with "::" (right half is empty string, line 156 FALSE branch)', () => {
    // '2001:db8::' → split('::') = ['2001:db8', ''] → halves[1] = '' (falsy) → right = []
    const result = normalizeIP('2001:db8::');
    // Should expand to 2001:0db8:0000:0000:0000:0000:0000:0000
    // /64 prefix → 2001:0db8:0000:0000::0
    expect(result).toBe('2001:0db8:0000:0000::0');
  });

  it('handles full (non-compressed) IPv6 — halves.length !== 2 path', () => {
    // A fully-qualified IPv6 with no "::" has halves.length === 1 (no split on "::").
    // The else branch pads each group to 4 chars.
    const result = normalizeIP('2001:db8:0:0:0:0:0:1');
    expect(result).toBe('2001:0db8:0000:0000::0');
  });

  it('zero-pads each group correctly — verifying padStart fill character', () => {
    // If padStart filled with '' instead of '0', groups would not be 4 chars.
    const result = normalizeIP('1:2:3:4:5:6:7:8');
    // /64 prefix = groups 0-3: '0001', '0002', '0003', '0004'
    expect(result).toBe('0001:0002:0003:0004::0');
  });

  it('verifies missingGroups arithmetic in expandIPv6 (::1)', () => {
    // ::1 → left=[], right=['1'], missingGroups = 8 - 0 - 1 = 7
    // full: 0000:0000:0000:0000:0000:0000:0000:0001
    // /64: 0000:0000:0000:0000
    const result = normalizeIP('::1');
    expect(result).toBe('0000:0000:0000:0000::0');
  });

  it('verifies right-side expansion uses ":" as separator (not every character)', () => {
    // If the split separator were '' instead of ':', '::ff00' would split 'ff00'
    // character-by-character ('f','f','0','0') giving wrong results.
    // The correct expansion of '::ff00' (last group = 0xff00) → /64 is all zeros.
    const result = normalizeIP('::ff00');
    // right = ['ff00'] → 1 group; missingGroups = 7
    // expanded = 0000:0000:0000:0000:0000:0000:0000:ff00
    expect(result).toBe('0000:0000:0000:0000::0');
  });

  it('fill value in missingGroups array is "0000" not empty', () => {
    // ::1 → missingGroups=7 groups filled with '0000'
    // If filled with '' the /64 prefix would be ':' characters instead of zero groups
    const result = normalizeIP('::1');
    const prefix = result.split('::0')[0];
    const groups = prefix.split(':');
    expect(groups).toHaveLength(4);
    groups.forEach(g => expect(g).toMatch(/^[0-9a-f]{4}$/));
  });

  it('split separator is ":" not each character — verifying with multi-group right half', () => {
    // "::2001:db8" → halves[1] = "2001:db8", right = split(':') = ["2001","db8"] (2 groups)
    // If split("") instead: right = ['2','0','0','1',':','d','b','8'] (8 chars) → wrong result
    // Normal: missingGroups = 8-0-2=6, prefix=0000:0000:0000:0000
    const result = normalizeIP('::2001:db8');
    expect(result).toBe('0000:0000:0000:0000::0');
  });

  it('missingGroups arithmetic: 8 - left - right (not + right)', () => {
    // "2001::1:2:3:4:5" → left=['2001'] (1), right=['1','2','3','4','5'] (5)
    // Correct: missingGroups = 8-1-5 = 2. prefix='2001:0000:0000:0001::0'
    // With 8-1+5=12: 12 zero groups added → groups[2]='0000' not '0001' → prefix differs
    // With 8+1-5=4: 4 zero groups → groups[2]='0000' not '0001' still
    const result = normalizeIP('2001::1:2:3:4:5');
    expect(result).toBe('2001:0000:0000:0001::0');
  });

  it('missingGroups arithmetic: 8 - left - right (not - left + right variant)', () => {
    // Extra verification: "fe80::200:5aee:feaa:2000" →
    // left=['fe80'] (1), right=['200','5aee','feaa','2000'] (4)
    // missingGroups = 8-1-4 = 3. groups = [fe80,0000,0000,0000,0200,5aee,feaa,2000]
    // prefix = 'fe80:0000:0000:0000::0'
    const result = normalizeIP('fe80::200:5aee:feaa:2000');
    expect(result).toBe('fe80:0000:0000:0000::0');
  });
});

// ---------------------------------------------------------------------------
// hashIdentifier
// ---------------------------------------------------------------------------

describe('hashIdentifier', () => {
  it('returns a string of exactly 16 hex characters', () => {
    const hash = hashIdentifier('user-123');
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
  });

  it('is deterministic — same input always produces same output', () => {
    const a = hashIdentifier('alice@example.com');
    const b = hashIdentifier('alice@example.com');
    expect(a).toBe(b);
  });

  it('different inputs produce different hashes (no trivial collision)', () => {
    const a = hashIdentifier('user-1');
    const b = hashIdentifier('user-2');
    expect(a).not.toBe(b);
  });

  it('throws KeyBuilderError for empty identifier', () => {
    expect(() => hashIdentifier('')).toThrow(KeyBuilderError);
  });

  it('throws with exact message for empty identifier', () => {
    expect(() => hashIdentifier('')).toThrow('Identifier must not be empty');
  });

  it('throws KeyBuilderError for whitespace-only identifier', () => {
    expect(() => hashIdentifier('   ')).toThrow(KeyBuilderError);
  });

  it('throws with exact message for whitespace-only identifier', () => {
    expect(() => hashIdentifier('   ')).toThrow('Identifier must not be empty');
  });

  it('handles long identifiers without throwing', () => {
    const long = 'a'.repeat(10_000);
    expect(() => hashIdentifier(long)).not.toThrow();
    expect(hashIdentifier(long)).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// buildIPKey
// ---------------------------------------------------------------------------

describe('buildIPKey', () => {
  it('contains the rl:v1: prefix', () => {
    expect(buildIPKey('192.168.1.1', 100)).toContain('rl:v1:');
  });

  it('contains a Redis hash tag {…}', () => {
    const key = buildIPKey('192.168.1.1', 100);
    expect(key).toMatch(/\{[^}]+\}/);
  });

  it('embeds the IP inside the hash tag', () => {
    const key = buildIPKey('192.168.1.1', 100);
    expect(key).toContain('{ip:192.168.1.1}');
  });

  it('appends the bucket at the end', () => {
    const key = buildIPKey('10.0.0.1', 28_433_334);
    expect(key.endsWith(':28433334')).toBe(true);
  });

  it('matches expected format exactly', () => {
    expect(buildIPKey('192.168.1.1', 100)).toBe('rl:v1:{ip:192.168.1.1}:100');
  });
});

// ---------------------------------------------------------------------------
// buildRouteKey
// ---------------------------------------------------------------------------

describe('buildRouteKey', () => {
  it('contains the rl:v1: prefix', () => {
    expect(buildRouteKey('GET_api_users', 100)).toContain('rl:v1:');
  });

  it('contains a Redis hash tag {…}', () => {
    const key = buildRouteKey('GET_api_users', 100);
    expect(key).toMatch(/\{[^}]+\}/);
  });

  it('embeds the route inside the hash tag', () => {
    const key = buildRouteKey('GET_api_users', 100);
    expect(key).toContain('{route:GET_api_users}');
  });

  it('matches expected format exactly', () => {
    expect(buildRouteKey('GET_api_users', 28_433_334)).toBe(
      'rl:v1:{route:GET_api_users}:28433334',
    );
  });
});

// ---------------------------------------------------------------------------
// buildUserKey
// ---------------------------------------------------------------------------

describe('buildUserKey', () => {
  it('contains the rl:v1: prefix', () => {
    const hash = hashIdentifier('user-abc');
    expect(buildUserKey(hash, 100)).toContain('rl:v1:');
  });

  it('contains a Redis hash tag {…}', () => {
    const hash = hashIdentifier('user-abc');
    const key = buildUserKey(hash, 100);
    expect(key).toMatch(/\{[^}]+\}/);
  });

  it('embeds the userHash inside the hash tag', () => {
    const hash = hashIdentifier('user-abc');
    const key = buildUserKey(hash, 100);
    expect(key).toContain(`{user:${hash}}`);
  });

  it('matches expected format exactly', () => {
    const hash = 'abc123def456789a';
    expect(buildUserKey(hash, 28_433_334)).toBe(
      'rl:v1:{user:abc123def456789a}:28433334',
    );
  });
});

// ---------------------------------------------------------------------------
// buildUserRouteKey
// ---------------------------------------------------------------------------

describe('buildUserRouteKey', () => {
  const hash = 'abc123def456789a';
  const route = 'POST_api_orders';

  it('contains the rl:v1: prefix', () => {
    expect(buildUserRouteKey(hash, route, 100)).toContain('rl:v1:');
  });

  it('contains a Redis hash tag {…}', () => {
    const key = buildUserRouteKey(hash, route, 100);
    expect(key).toMatch(/\{[^}]+\}/);
  });

  it('embeds both userHash and route inside the hash tag', () => {
    const key = buildUserRouteKey(hash, route, 100);
    expect(key).toContain(`{user-route:${hash}:${route}}`);
  });

  it('matches expected format exactly', () => {
    expect(buildUserRouteKey(hash, route, 28_433_334)).toBe(
      `rl:v1:{user-route:${hash}:${route}}:28433334`,
    );
  });
});

// ---------------------------------------------------------------------------
// buildKeyPair
// ---------------------------------------------------------------------------

describe('buildKeyPair', () => {
  const windowMs = 60_000;

  it('returns exactly two strings', () => {
    const nowMs = windowMs * 100 + 10_000;
    const pair = buildKeyPair((b) => buildIPKey('10.0.0.1', b), nowMs, windowMs);
    expect(pair).toHaveLength(2);
    expect(typeof pair[0]).toBe('string');
    expect(typeof pair[1]).toBe('string');
  });

  it('curr key bucket is one greater than prev key bucket', () => {
    const nowMs = windowMs * 100 + 10_000; // bucket = 100
    const [curr, prev] = buildKeyPair(
      (b) => buildIPKey('10.0.0.1', b),
      nowMs,
      windowMs,
    );
    // bucket 100 → curr, bucket 99 → prev
    expect(curr.endsWith(':100')).toBe(true);
    expect(prev.endsWith(':99')).toBe(true);
  });

  it('both keys in the pair share the same hash tag (cluster-slot safe)', () => {
    const nowMs = windowMs * 100 + 30_000;
    const [curr, prev] = buildKeyPair(
      (b) => buildIPKey('10.0.0.1', b),
      nowMs,
      windowMs,
    );
    // Extract hash tag from each key.
    const tagOf = (key: string): string => {
      const m = key.match(/\{[^}]+\}/);
      return m ? m[0] : '';
    };
    expect(tagOf(curr)).toBe(tagOf(prev));
  });

  it('works with buildRouteKey', () => {
    const nowMs = windowMs * 50 + 5_000;
    const [curr, prev] = buildKeyPair(
      (b) => buildRouteKey('GET_api_users', b),
      nowMs,
      windowMs,
    );
    expect(curr).toContain('{route:GET_api_users}');
    expect(prev).toContain('{route:GET_api_users}');
    expect(curr).not.toBe(prev);
  });

  it('works with buildUserRouteKey', () => {
    const nowMs = windowMs * 200 + 20_000;
    const hash = hashIdentifier('user-xyz');
    const [curr, prev] = buildKeyPair(
      (b) => buildUserRouteKey(hash, 'POST_api_orders', b),
      nowMs,
      windowMs,
    );
    expect(curr).toContain(`{user-route:${hash}:POST_api_orders}`);
    expect(prev).toContain(`{user-route:${hash}:POST_api_orders}`);
    expect(curr).not.toBe(prev);
  });
});

// ---------------------------------------------------------------------------
// Key format invariants (applies to ALL key builders)
// ---------------------------------------------------------------------------

describe('key format invariants', () => {
  const bucket = 28_433_334;
  const hash = hashIdentifier('some-user');
  const route = normalizeRoute('GET', '/api/v1/items');

  const keys = [
    buildIPKey('192.168.0.1', bucket),
    buildRouteKey(route, bucket),
    buildUserKey(hash, bucket),
    buildUserRouteKey(hash, route, bucket),
  ];

  it.each(keys)('key "%s" starts with rl:v1:', (key) => {
    expect(key.startsWith('rl:v1:')).toBe(true);
  });

  it.each(keys)('key "%s" contains a Redis hash tag', (key) => {
    expect(key).toMatch(/\{[^}]+\}/);
  });

  it.each(keys)('key "%s" ends with the bucket number', (key) => {
    expect(key.endsWith(`:${bucket}`)).toBe(true);
  });
});
