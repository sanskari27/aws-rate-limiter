/**
 * @fileoverview Redis key construction and route / IP normalization utilities.
 *
 * Key format: `rl:v1:{dimension:identifier}:bucket`
 *
 * Hash tags `{...}` are mandatory so that the current-bucket key and the
 * previous-bucket key always land on the same Redis cluster slot.  Without
 * them a CROSSSLOT error would be thrown when the Lua scripts try to access
 * both keys atomically.
 *
 * @example
 * // "rl:v1:{ip:c0a80101}:28433334"
 * // "rl:v1:{user:abc123def456789a}:28433334"
 * // "rl:v1:{route:GET_api_users_PARAM}:28433334"
 * // "rl:v1:{user-route:abc123def456789a:POST_api_orders}:28433334"
 */

import { createHash } from 'crypto';
import { computeBucket } from './algorithm';
import { KeyBuilderError } from './types';

/** Prefix applied to every Redis key produced by this module. */
const KEY_PREFIX = 'rl:v1';

// ---------------------------------------------------------------------------
// Route normalization helpers
// ---------------------------------------------------------------------------

/** Matches RFC-4122 UUIDs (case-insensitive). */
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Matches Unix timestamps (10+ consecutive digits) in any position.
 * Applied before NUMERIC_ID_RE to avoid partial matches.
 */
const TIMESTAMP_RE = /\d{10,}/g;

/**
 * Matches purely numeric path segments (e.g. `/123/` or trailing `/456`).
 * Uses a lookbehind for `/` and lookahead for `/` or end-of-string so that
 * embedded digits like the `2` in `/v2/` are preserved.
 */
const NUMERIC_ID_RE = /(?<=\/)\d+(?=\/|$)/g;

/** Characters that are not safe to embed in a Redis key are replaced with `_`. */
const UNSAFE_CHARS_RE = /[^a-z0-9_]/g;

// ---------------------------------------------------------------------------
// Route normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes an HTTP method + path pair into a compact, deterministic string
 * safe for use as a Redis key component.
 *
 * Normalization steps (applied in order):
 * 1. Strip query string (`?…`).
 * 2. Strip UUIDs → `PARAM`.
 * 3. Strip Unix timestamps (≥10 digits) → `PARAM`.
 * 4. Strip remaining numeric IDs → `PARAM`.
 * 5. Lowercase everything.
 * 6. Replace characters outside `[a-z0-9_]` with `_`.
 * 7. Prefix with `METHOD_`.
 *
 * @param method  HTTP method string, e.g. "GET".
 * @param path    Raw request path, e.g. "/api/users/123?page=1".
 * @returns       Normalized route string, e.g. "GET_api_users_PARAM".
 * @throws        {@link KeyBuilderError} if method or path is empty.
 */
export function normalizeRoute(method: string, path: string): string {
  if (!method || method.trim().length === 0) {
    throw new KeyBuilderError('HTTP method must not be empty');
  }
  if (!path || path.trim().length === 0) {
    throw new KeyBuilderError('Route path must not be empty');
  }

  // 1. Strip query string.
  const withoutQuery = path.split('?')[0];

  // Use a collision-resistant placeholder that survives lowercasing and
  // the unsafe-char filter (only [a-z0-9_] are kept).
  const PH = '_0xrlparam0x_';

  // 2–4. Strip UUIDs, timestamps, numeric IDs.
  const withoutUuids = withoutQuery.replace(UUID_RE, PH);
  const withoutTimestamps = withoutUuids.replace(TIMESTAMP_RE, PH);
  const withoutIds = withoutTimestamps.replace(NUMERIC_ID_RE, PH);

  // 5. Lowercase.
  const lower = withoutIds.toLowerCase();

  // 6. Replace unsafe characters.
  const safe = lower.replace(UNSAFE_CHARS_RE, '_');

  // Restore placeholders to PARAM.
  const normalized = safe.replace(/_0xrlparam0x_/g, 'PARAM');

  // 7. Prefix with METHOD_.
  const upperMethod = method.trim().toUpperCase();
  return `${upperMethod}_${normalized}`;
}

// ---------------------------------------------------------------------------
// IP normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes an IP address for use as a rate-limit key component.
 *
 * - **IPv4**: returned as-is.
 * - **IPv6**: collapsed to the /64 network prefix (first 4 groups), with
 *   `::0` appended, e.g. `2001:db8:85a3:0::0`.
 *
 * @param ip  Raw IP address string.
 * @returns   Normalized IP string.
 * @throws    {@link KeyBuilderError} if the input is empty.
 */
export function normalizeIP(ip: string): string {
  if (!ip || ip.trim().length === 0) {
    throw new KeyBuilderError('IP address must not be empty');
  }

  const trimmed = ip.trim();

  // Detect IPv6: contains a colon.
  if (trimmed.includes(':')) {
    // Expand shorthand (e.g. "::1") into full form before splitting.
    const expanded = expandIPv6(trimmed);
    const groups = expanded.split(':');
    // Take the first 4 groups (the /64 network prefix).
    const prefix = groups.slice(0, 4).join(':');
    return `${prefix}::0`;
  }

  return trimmed;
}

/**
 * Expands a potentially compressed IPv6 address to its full 8-group form.
 * Handles `::` shorthand notation.
 *
 * @param ip  IPv6 address string (may be compressed).
 * @returns   Full 8-group IPv6 string with each group zero-padded to 4 hex digits.
 */
function expandIPv6(ip: string): string {
  // Handle the special case of "::" (all zeros).
  if (ip === '::') {
    return '0000:0000:0000:0000:0000:0000:0000:0000';
  }

  const halves = ip.split('::');
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missingGroups = 8 - left.length - right.length;
    const middle = Array<string>(missingGroups).fill('0000');
    const groups = [...left, ...middle, ...right];
    return groups.map((g) => g.padStart(4, '0')).join(':');
  }

  // No "::" — already fully specified (or malformed; pass through).
  return ip
    .split(':')
    .map((g) => g.padStart(4, '0'))
    .join(':');
}

// ---------------------------------------------------------------------------
// Identifier hashing
// ---------------------------------------------------------------------------

/**
 * Hashes an identifier (user ID, API key) with SHA-256 and returns the first
 * 16 hex characters.  Raw identifiers must never be stored in Redis keys.
 *
 * @param identifier  The raw identifier string (user ID, API key, etc.).
 * @returns           First 16 hex characters of the SHA-256 digest.
 * @throws            {@link KeyBuilderError} if the identifier is empty.
 */
export function hashIdentifier(identifier: string): string {
  if (!identifier || identifier.trim().length === 0) {
    throw new KeyBuilderError('Identifier must not be empty');
  }
  return createHash('sha256').update(identifier, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

/**
 * Builds a per-IP Redis key for a given bucket.
 *
 * @param ip      Normalized IP address (use {@link normalizeIP} first).
 * @param bucket  Bucket index from {@link computeBucket}.
 * @returns       Redis key string, e.g. `rl:v1:{ip:192.168.1.1}:28433334`.
 */
export function buildIPKey(ip: string, bucket: number): string {
  return `${KEY_PREFIX}:{ip:${ip}}:${bucket}`;
}

/**
 * Builds a per-route Redis key for a given bucket.
 *
 * @param route   Normalized route string (use {@link normalizeRoute} first).
 * @param bucket  Bucket index from {@link computeBucket}.
 * @returns       Redis key string, e.g. `rl:v1:{route:GET_api_users}:28433334`.
 */
export function buildRouteKey(route: string, bucket: number): string {
  return `${KEY_PREFIX}:{route:${route}}:${bucket}`;
}

/**
 * Builds a per-user Redis key for a given bucket.
 *
 * @param userHash  Hashed user identifier (use {@link hashIdentifier} first).
 * @param bucket    Bucket index from {@link computeBucket}.
 * @returns         Redis key string, e.g. `rl:v1:{user:abc123def456789a}:28433334`.
 */
export function buildUserKey(userHash: string, bucket: number): string {
  return `${KEY_PREFIX}:{user:${userHash}}:${bucket}`;
}

/**
 * Builds a per-user-per-route Redis key for a given bucket.
 *
 * @param userHash  Hashed user identifier (use {@link hashIdentifier} first).
 * @param route     Normalized route string (use {@link normalizeRoute} first).
 * @param bucket    Bucket index from {@link computeBucket}.
 * @returns         Redis key string,
 *                  e.g. `rl:v1:{user-route:abc123def456789a:POST_api_orders}:28433334`.
 */
export function buildUserRouteKey(
  userHash: string,
  route: string,
  bucket: number,
): string {
  return `${KEY_PREFIX}:{user-route:${userHash}:${route}}:${bucket}`;
}

/**
 * Returns both the current-bucket key and the previous-bucket key for a given
 * key-building function.  Both keys share the same hash tag so they always
 * reside on the same Redis cluster node, enabling atomic multi-key Lua scripts.
 *
 * @param keyFn    A key-building function that accepts a bucket number.
 * @param nowMs    Current time in Unix epoch milliseconds.
 * @param windowMs Window duration in milliseconds.
 * @returns        Tuple `[currKey, prevKey]` where `currKey` is the current
 *                 bucket and `prevKey` is the immediately preceding bucket.
 */
export function buildKeyPair(
  keyFn: (bucket: number) => string,
  nowMs: number,
  windowMs: number,
): [string, string] {
  const currBucket = computeBucket(nowMs, windowMs);
  const prevBucket = currBucket - 1;
  return [keyFn(currBucket), keyFn(prevBucket)];
}
