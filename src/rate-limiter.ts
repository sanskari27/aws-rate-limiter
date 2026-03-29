/**
 * @fileoverview Main RateLimiter class — the primary entry point for all rate-limit checks.
 *
 * Implements multi-dimensional sliding-window rate limiting backed by Redis ElastiCache,
 * with an in-process token reservoir to reduce Redis round-trips by 100×, a circuit
 * breaker for fault isolation, and configurable failure policies (fail_open / fail_closed
 * / fail_local).
 *
 * Check order (fail-fast):
 *  1. Per-IP
 *  2. Per-route
 *  3. Per-user
 *  4. Per-user+route
 */

import { minimatch } from 'minimatch';

import {
  RateLimiterConfig,
  RateLimitContext,
  RateLimitResult,
  RuleConfig,
  LimitSpec,
  ConfigurationError,
  RedisConnectionError,
} from './core/types';
import { computeBucket, computeResetAt } from './core/algorithm';
import {
  buildIPKey,
  buildRouteKey,
  buildUserKey,
  buildUserRouteKey,
  normalizeRoute,
  normalizeIP,
  hashIdentifier,
} from './core/key-builder';
import { RedisClientManager } from './redis/client';
import { ScriptLoader } from './redis/script-loader';
import { CircuitBreaker } from './redis/circuit-breaker';
import { LocalReservoir } from './reservoir/local-reservoir';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A single active dimension to be checked. */
interface ActiveDimension {
  /** Logical dimension name, e.g. "ip" */
  name: string;
  /** Current-bucket Redis key */
  currKey: string;
  /** Previous-bucket Redis key */
  prevKey: string;
  /** The rate limit spec for this dimension */
  spec: LimitSpec;
}

/** Parsed result from check_multi.lua */
interface LuaCheckResult {
  allowed: boolean;
  failedDimension: string;
  effective: number;
  limit: number;
  ttlMs: number;
}

/** Parsed result from status.lua */
interface LuaStatusResult {
  effective: number;
  limit: number;
  remaining: number;
  ttlMs: number;
}

// ---------------------------------------------------------------------------
// LocalFallbackLimiter — in-process fixed-window counter for fail_local mode
// ---------------------------------------------------------------------------

/**
 * Simple in-process fixed-window rate limiter used as a fallback when Redis
 * is unavailable and the failure policy is `fail_local`.
 */
class LocalFallbackLimiter {
  private readonly counters = new Map<string, { count: number; resetAt: number }>();
  private static readonly MAX_ENTRIES = 50_000;
  private static readonly EVICTION_BATCH = 10_000;

  /**
   * Check whether `cost` additional requests are allowed for `key` within `windowMs`.
   *
   * @param key      Identifier key (e.g. normalized IP + route).
   * @param limit    Maximum allowed count per window.
   * @param windowMs Window duration in milliseconds.
   * @param cost     Request cost weight.
   * @returns `true` if allowed, `false` if denied.
   */
  check(key: string, limit: number, windowMs: number, cost: number): boolean {
    const now = Date.now();
    const entry = this.counters.get(key);
    if (entry === undefined || now > entry.resetAt) {
      if (this.counters.size >= LocalFallbackLimiter.MAX_ENTRIES) {
        this.evictExpired(now);
      }
      this.counters.set(key, { count: cost, resetAt: now + windowMs });
      return true;
    }
    if (entry.count + cost > limit) return false;
    entry.count += cost;
    return true;
  }

  private evictExpired(now: number): void {
    let evicted = 0;
    for (const [k, v] of this.counters) {
      if (now > v.resetAt) {
        this.counters.delete(k);
        evicted++;
        if (evicted >= LocalFallbackLimiter.EVICTION_BATCH) break;
      }
    }

    // Hard cap: if expired-only eviction didn't free enough space, forcefully
    // remove the oldest entries (Map iteration order = insertion order).
    if (this.counters.size >= LocalFallbackLimiter.MAX_ENTRIES) {
      const target = LocalFallbackLimiter.MAX_ENTRIES - LocalFallbackLimiter.EVICTION_BATCH;
      const iter = this.counters.keys();
      while (this.counters.size > target) {
        const next = iter.next();
        /* istanbul ignore next */
        if (next.done) break;
        this.counters.delete(next.value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

/**
 * Production-grade multi-dimensional rate limiter backed by Redis ElastiCache.
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter({
 *   redis: { url: 'redis://localhost:6379' },
 *   rules: [{
 *     name: 'default',
 *     limits: { ip: { limit: 100, window: 60 } },
 *   }],
 * })
 * await limiter.connect()
 * const result = await limiter.check({ ip: '1.2.3.4', route: '/api/users', method: 'GET' })
 * ```
 */
export class RateLimiter {
  private readonly config: RateLimiterConfig;
  private readonly redisManager: RedisClientManager;
  private readonly scriptLoader: ScriptLoader;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly reservoir: LocalReservoir | null;
  private readonly localFallback: LocalFallbackLimiter;
  private connected = false;

  /**
   * @param config Top-level rate limiter configuration.
   * @throws {ConfigurationError} If no rules are provided.
   */
  constructor(config: RateLimiterConfig) {
    if (!config.rules || config.rules.length === 0) {
      throw new ConfigurationError('At least one rule must be configured');
    }

    this.config = config;

    this.redisManager = new RedisClientManager({ config: config.redis });

    this.scriptLoader = new ScriptLoader();

    const cbConfig = config.failure?.circuitBreaker;
    this.circuitBreaker = new CircuitBreaker(
      cbConfig
        ? { threshold: cbConfig.threshold, recoveryTimeout: cbConfig.recoveryTimeout }
        : undefined,
    );

    const reservoirCfg = config.reservoir;
    if (reservoirCfg?.enabled) {
      this.reservoir = new LocalReservoir({
        batchSize: reservoirCfg.batchSize,
        syncInterval: reservoirCfg.syncInterval,
      });
    } else {
      this.reservoir = null;
    }

    this.localFallback = new LocalFallbackLimiter();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect to Redis and load all Lua scripts via EVALSHA.
   * Must be called before {@link check}, {@link status}, or {@link reset}.
   *
   * @throws {RedisConnectionError} If the Redis connection cannot be established.
   */
  async connect(): Promise<void> {
    await this.redisManager.connect();
    // RedisClientManager itself satisfies RedisClientForScripts (has scriptLoad + evalsha).
    await this.scriptLoader.loadAll(this.redisManager);
    this.connected = true;
  }

  /**
   * Gracefully shut down: flush any locally pre-fetched reservoir tokens back
   * to Redis, then disconnect.
   */
  async shutdown(): Promise<void> {
    if (this.reservoir !== null) {
      await this.reservoir.flush(async (key: string, tokens: number) => {
        // Best-effort: return pre-fetched tokens by decrementing the counter.
        // If this fails, tokens expire naturally (TTL = window_ms * 2).
        try {
          const client = this.redisManager.getClient();
          await (client as { decrby(key: string, decrement: number): Promise<number> })
            .decrby(key, tokens);
        } catch {
          // Swallow — tokens will expire via TTL
        }
      });
    }
    await this.redisManager.disconnect();
    this.connected = false;
  }

  /**
   * Returns `true` if the rate limiter is connected to Redis.
   *
   * @returns Boolean connection status.
   */
  isConnected(): boolean {
    return this.connected && this.redisManager.isConnected();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Check rate limits for an incoming request context.
   *
   * Evaluates all active dimensions (ip, route, user, user-route) in fail-fast
   * order using a single `check_multi.lua` Redis round-trip.  Falls back to the
   * configured failure policy if the circuit breaker is open or Redis throws.
   *
   * @param ctx Incoming request context.
   * @returns Rate limit decision including remaining quota, reset time, and source.
   * @throws {ConfigurationError} If the limiter has not been connected yet.
   */
  async check(ctx: RateLimitContext): Promise<RateLimitResult> {
    this.assertConnected();

    if (!ctx.ip || !ctx.route || !ctx.method) {
      throw new ConfigurationError(
        'RateLimitContext requires non-empty ip, route, and method fields',
      );
    }

    const nowMs = Date.now();
    const cost = ctx.cost ?? 1;
    const rule = findMatchingRule(ctx, this.config.rules);
    const dimensions = buildActiveDimensions(ctx, rule, nowMs);

    // No applicable limits — allow immediately.
    if (dimensions.length === 0) {
      return buildAllowedResult('none', 0, 0, 0, nowMs, 'redis');
    }

    // ---- Reservoir fast path -----------------------------------------------
    if (this.reservoir !== null) {
      // For the reservoir we use the first dimension's current key as the
      // composite reservoir key (IP is always first and most restrictive).
      const reservoirKey = dimensions[0].currKey;
      const spec = dimensions[0].spec;
      const windowMs = spec.window * 1000;
      const ttlMs = windowMs * 2;

      const fetchFn = async (_key: string): Promise<number> => {
        const batchSize =
          rule.reservoir?.batchSize ?? this.config.reservoir?.batchSize ?? 10;
        const currKey = dimensions[0].currKey;
        const prevKey = dimensions[0].prevKey;
        const result = await this.scriptLoader.eval(
          this.redisManager,
          'reservoirFetch',
          [currKey, prevKey],
          [spec.limit, windowMs, nowMs, batchSize, ttlMs],
        );
        return typeof result === 'number' ? result : 0;
      };

      try {
        const allowed = await this.reservoir.consume(reservoirKey, cost, fetchFn);
        const resetAt = computeResetAt(nowMs, windowMs);
        if (allowed) {
          return buildAllowedResult('none', 0, spec.limit, spec.limit - cost, resetAt, 'reservoir', spec.window);
        }
        // Reservoir denied — fall through to Redis for precise multi-dim check
      } catch {
        // Reservoir error — fall through to Redis
      }
    }

    // ---- Circuit breaker check ---------------------------------------------
    if (!this.circuitBreaker.allowRequest()) {
      return this.applyFailurePolicy(ctx, rule, new Error('Circuit breaker is open'));
    }

    // ---- Redis check_multi round-trip --------------------------------------
    try {
      const result = await this.runCheckMulti(dimensions, nowMs, cost);
      this.circuitBreaker.recordSuccess();
      return this.buildResultFromLua(result, dimensions, nowMs, cost);
    } catch (err: unknown) {
      this.circuitBreaker.recordFailure();
      const error = err instanceof Error ? err : new Error(String(err));
      return this.applyFailurePolicy(ctx, rule, error);
    }
  }

  /**
   * Get the current rate limit status for a request context without consuming quota.
   *
   * Queries each active dimension using `status.lua` and returns the most
   * constrained dimension (lowest remaining capacity).
   *
   * @param ctx Incoming request context.
   * @returns Current rate limit status without modifying any counters.
   * @throws {ConfigurationError} If the limiter has not been connected yet.
   */
  async status(ctx: RateLimitContext): Promise<RateLimitResult> {
    this.assertConnected();

    const nowMs = Date.now();
    const cost = ctx.cost ?? 1;
    const rule = findMatchingRule(ctx, this.config.rules);
    const dimensions = buildActiveDimensions(ctx, rule, nowMs);

    if (dimensions.length === 0) {
      return buildAllowedResult('none', 0, 0, 0, nowMs, 'redis');
    }

    let mostConstrained: RateLimitResult | null = null;

    for (const dim of dimensions) {
      const windowMs = dim.spec.window * 1000;
      const raw = await this.scriptLoader.eval(
        this.redisManager,
        'status',
        [dim.currKey, dim.prevKey],
        [dim.spec.limit, windowMs, nowMs],
      );

      const parsed = parseLuaStatusResult(raw);
      const resetAt = computeResetAt(nowMs, windowMs);
      const remaining = Math.max(0, Math.floor(parsed.remaining));

      const dimResult: RateLimitResult = {
        allowed: parsed.effective + cost <= dim.spec.limit,
        dimension: dim.name,
        effective: parsed.effective,
        limit: dim.spec.limit,
        remaining,
        resetAt,
        windowSecs: dim.spec.window,
        retryAfter: parsed.effective + cost > dim.spec.limit ? parsed.ttlMs : undefined,
        source: 'redis',
      };

      if (
        mostConstrained === null ||
        remaining < mostConstrained.remaining
      ) {
        mostConstrained = dimResult;
      }
    }

    return mostConstrained!;
  }

  /**
   * Reset rate limit counters for a specific dimension and identifier.
   *
   * Deletes both the current and previous bucket keys using `reset.lua`.
   *
   * @param dimension  Which dimension to reset: 'ip' | 'user' | 'route' | 'user-route'.
   * @param identifier The raw identifier (IP address, user ID, route string, etc.).
   * @returns The number of Redis keys deleted.
   * @throws {ConfigurationError} If the limiter has not been connected yet.
   */
  async reset(
    dimension: 'ip' | 'user' | 'route' | 'user-route',
    identifier: string,
  ): Promise<number> {
    this.assertConnected();

    const nowMs = Date.now();
    // Find a rule that defines this dimension (search all rules, not just the first).
    let spec: LimitSpec | undefined;
    for (const rule of this.config.rules) {
      spec = getSpecForDimension(rule, dimension);
      if (spec !== undefined) break;
    }
    if (spec === undefined) {
      return 0;
    }
    const windowMs = spec.window * 1000;
    const currBucket = computeBucket(nowMs, windowMs);
    const prevBucket = currBucket - 1;

    let currKey: string;
    let prevKey: string;

    switch (dimension) {
      case 'ip': {
        const normIp = normalizeIP(identifier);
        currKey = buildIPKey(normIp, currBucket);
        prevKey = buildIPKey(normIp, prevBucket);
        break;
      }
      case 'route': {
        // identifier is expected to be a pre-normalized route string
        currKey = buildRouteKey(identifier, currBucket);
        prevKey = buildRouteKey(identifier, prevBucket);
        break;
      }
      case 'user': {
        const hash = hashIdentifier(identifier);
        currKey = buildUserKey(hash, currBucket);
        prevKey = buildUserKey(hash, prevBucket);
        break;
      }
      case 'user-route': {
        // identifier format: "userId:normalizedRoute"
        const separatorIdx = identifier.indexOf(':');
        const userId = identifier.slice(0, separatorIdx);
        const route = identifier.slice(separatorIdx + 1);
        const hash = hashIdentifier(userId);
        currKey = buildUserRouteKey(hash, route, currBucket);
        prevKey = buildUserRouteKey(hash, route, prevBucket);
        break;
      }
    }

    const result = await this.scriptLoader.eval(this.redisManager, 'reset', [currKey, prevKey], []);
    return typeof result === 'number' ? result : 0;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Asserts that connect() has been called before operations that need Redis. */
  private assertConnected(): void {
    if (!this.connected) {
      throw new RedisConnectionError(
        'RateLimiter is not connected. Call connect() before using check/status/reset.',
      );
    }
  }

  /**
   * Executes `check_multi.lua` for the active dimensions.
   *
   * @param dimensions Active dimensions to check.
   * @param nowMs      Current Unix epoch milliseconds.
   * @param cost       Request cost weight.
   * @returns Parsed Lua check result.
   */
  private async runCheckMulti(
    dimensions: ActiveDimension[],
    nowMs: number,
    cost: number,
  ): Promise<LuaCheckResult> {
    const keys: string[] = [];
    const argv: (string | number)[] = [];

    // Use the maximum window as the single TTL (window_ms * 2 covers all dims).
    const maxWindowMs = Math.max(...dimensions.map((d) => d.spec.window * 1000));
    const ttlMs = maxWindowMs * 2;

    argv.push(nowMs, cost, ttlMs);

    for (const dim of dimensions) {
      keys.push(dim.currKey, dim.prevKey);
      const windowMs = dim.spec.window * 1000;
      argv.push(`${dim.name}:${dim.spec.limit}:${windowMs}`);
    }

    const raw = await this.scriptLoader.eval(this.redisManager, 'checkMulti', keys, argv);
    return parseLuaCheckResult(raw);
  }

  /**
   * Translates a parsed Lua check result into a {@link RateLimitResult}.
   *
   * @param luaResult  Parsed result from `check_multi.lua`.
   * @param dimensions Active dimensions (used to look up specs on deny).
   * @param nowMs      Current Unix epoch milliseconds.
   * @param cost       Request cost weight.
   */
  private buildResultFromLua(
    luaResult: LuaCheckResult,
    dimensions: ActiveDimension[],
    nowMs: number,
    cost: number,
  ): RateLimitResult {
    if (luaResult.allowed) {
      const limit = luaResult.limit > 0 ? luaResult.limit : dimensions[0].spec.limit;
      const effective = luaResult.effective;
      const remaining = Math.max(0, Math.floor(limit - effective - cost));
      const windowMs = luaResult.ttlMs > 0
        ? luaResult.ttlMs
        : dimensions[0].spec.window * 1000;
      const resetAt = computeResetAt(nowMs, windowMs > 0 ? windowMs : /* istanbul ignore next */ dimensions[0].spec.window * 1000);
      return {
        allowed: true,
        dimension: 'none',
        effective,
        limit,
        remaining,
        resetAt,
        windowSecs: Math.ceil(windowMs / 1000),
        source: 'redis',
      };
    }

    // Denied — find the dimension spec for accurate remaining/resetAt.
    const failedDim = dimensions.find((d) => d.name === luaResult.failedDimension);
    const windowMs = failedDim ? failedDim.spec.window * 1000 : luaResult.ttlMs;
    const resetAt = computeResetAt(nowMs, windowMs > 0 ? windowMs : luaResult.ttlMs);

    return {
      allowed: false,
      dimension: luaResult.failedDimension,
      effective: luaResult.effective,
      limit: luaResult.limit,
      remaining: 0,
      resetAt,
      windowSecs: failedDim ? failedDim.spec.window : Math.ceil(luaResult.ttlMs / 1000),
      retryAfter: luaResult.ttlMs > 0 ? luaResult.ttlMs : undefined,
      source: 'redis',
    };
  }

  /**
   * Apply the failure policy when Redis is unavailable.
   *
   * - `open` / `fail_open`: allow all traffic.
   * - `closed` / `fail_closed`: deny all traffic (503-like).
   * - `local` / `fail_local`: use the in-process {@link LocalFallbackLimiter}.
   *
   * @param ctx  Incoming request context.
   * @param rule Matched rule (used for limits and failure policy).
   * @param _err The underlying Redis error (currently unused beyond logging).
   * @returns A rate limit result derived from the failure policy.
   */
  private applyFailurePolicy(
    ctx: RateLimitContext,
    rule: RuleConfig,
    _err: Error,
  ): RateLimitResult {
    const policy = rule.failure ?? this.config.failure?.default ?? 'open';
    const nowMs = Date.now();

    switch (policy) {
      case 'open':
        return {
          allowed: true,
          dimension: 'none',
          effective: 0,
          limit: Number.MAX_SAFE_INTEGER,
          remaining: Number.MAX_SAFE_INTEGER,
          resetAt: 0,
          windowSecs: 0,
          source: 'local_fallback',
        };

      case 'closed':
        return {
          allowed: false,
          dimension: 'redis_error',
          effective: 0,
          limit: 0,
          remaining: 0,
          resetAt: 0,
          windowSecs: 0,
          retryAfter: 5000,
          source: 'local_fallback',
        };

      case 'local': {
        const cost = ctx.cost ?? 1;
        const normIp = normalizeIP(ctx.ip);
        const normRoute = normalizeRoute(ctx.method, ctx.route);
        const fallbackKey = `local:${normIp}:${normRoute}`;
        const spec = rule.limits.ip ?? rule.limits.route ?? { limit: 100, window: 60 };
        const windowMs = spec.window * 1000;
        const allowed = this.localFallback.check(fallbackKey, spec.limit, windowMs, cost);
        const resetAt = computeResetAt(nowMs, windowMs);
        return {
          allowed,
          dimension: allowed ? 'none' : 'local_fallback',
          effective: 0,
          limit: spec.limit,
          remaining: allowed ? spec.limit - cost : 0,
          resetAt,
          windowSecs: spec.window,
          retryAfter: allowed ? undefined : windowMs,
          source: 'local_fallback',
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level pure helpers (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Finds the first rule in `rules` whose `match` conditions are satisfied by `ctx`.
 * If no rule matches, returns the last rule (acts as default catch-all).
 *
 * Matching logic:
 * - A rule with no `match` field matches everything.
 * - `match.routes`: glob-match `"METHOD /path"` against each pattern.
 * - `match.userTiers`: exact string match against `ctx.userTier`.
 * - `match.ips`: exact string match against `ctx.ip`.
 * - All specified sub-conditions must pass (AND semantics).
 *
 * @param ctx   Incoming request context.
 * @param rules Ordered list of rule configurations.
 * @returns The first matching rule, or the last rule if none match.
 */
export function findMatchingRule(ctx: RateLimitContext, rules: RuleConfig[]): RuleConfig {
  for (const rule of rules) {
    if (rule.match === undefined) return rule;

    const { routes, userTiers, ips } = rule.match;

    if (routes !== undefined && routes.length > 0) {
      const target = `${ctx.method.toUpperCase()} ${ctx.route}`;
      const routeMatch = routes.some((pattern) => minimatch(target, pattern));
      if (!routeMatch) continue;
    }

    if (userTiers !== undefined && userTiers.length > 0) {
      if (ctx.userTier === undefined || !userTiers.includes(ctx.userTier)) continue;
    }

    if (ips !== undefined && ips.length > 0) {
      const normalizedCtxIp = normalizeIP(ctx.ip);
      const ipMatch = ips.some((ip) => normalizeIP(ip) === normalizedCtxIp);
      if (!ipMatch) continue;
    }

    return rule;
  }

  // Fallback: prefer a rule with no match criteria (true catch-all),
  // otherwise fall back to the last rule.
  const catchAll = rules.find((r) => r.match === undefined);
  return catchAll ?? rules[rules.length - 1];
}

/**
 * Builds the list of active dimensions for a request given a matched rule.
 *
 * Dimensions are only included when the rule has a limit spec for them AND
 * (for user-based dims) a user identifier is present on the context.
 *
 * @param ctx   Incoming request context.
 * @param rule  Matched rate limit rule.
 * @param nowMs Current Unix epoch milliseconds.
 * @returns Ordered array of active dimensions (ip → route → user → user-route).
 */
export function buildActiveDimensions(
  ctx: RateLimitContext,
  rule: RuleConfig,
  nowMs: number,
): ActiveDimension[] {
  const dimensions: ActiveDimension[] = [];
  const normIp = normalizeIP(ctx.ip);
  const normRoute = normalizeRoute(ctx.method, ctx.route);
  const userIdentifier = ctx.userId ?? ctx.apiKey;

  // Defer SHA-256 until actually needed by a user/userRoute dimension.
  let userHash: string | null | undefined;
  const getUserHash = (): string | null => {
    if (userHash === undefined) {
      userHash = userIdentifier ? hashIdentifier(userIdentifier) : null;
    }
    return userHash;
  };

  // 1. Per-IP
  if (rule.limits.ip) {
    const windowMs = rule.limits.ip.window * 1000;
    const currBucket = computeBucket(nowMs, windowMs);
    dimensions.push({
      name: 'ip',
      currKey: buildIPKey(normIp, currBucket),
      prevKey: buildIPKey(normIp, currBucket - 1),
      spec: rule.limits.ip,
    });
  }

  // 2. Per-route
  if (rule.limits.route) {
    const windowMs = rule.limits.route.window * 1000;
    const currBucket = computeBucket(nowMs, windowMs);
    dimensions.push({
      name: 'route',
      currKey: buildRouteKey(normRoute, currBucket),
      prevKey: buildRouteKey(normRoute, currBucket - 1),
      spec: rule.limits.route,
    });
  }

  // 3. Per-user
  if (rule.limits.user && getUserHash() !== null) {
    const windowMs = rule.limits.user.window * 1000;
    const currBucket = computeBucket(nowMs, windowMs);
    dimensions.push({
      name: 'user',
      currKey: buildUserKey(getUserHash()!, currBucket),
      prevKey: buildUserKey(getUserHash()!, currBucket - 1),
      spec: rule.limits.user,
    });
  }

  // 4. Per-user+route
  if (rule.limits.userRoute && getUserHash() !== null) {
    const windowMs = rule.limits.userRoute.window * 1000;
    const currBucket = computeBucket(nowMs, windowMs);
    dimensions.push({
      name: 'user-route',
      currKey: buildUserRouteKey(getUserHash()!, normRoute, currBucket),
      prevKey: buildUserRouteKey(getUserHash()!, normRoute, currBucket - 1),
      spec: rule.limits.userRoute,
    });
  }

  return dimensions;
}

// ---------------------------------------------------------------------------
// Lua result parsers
// ---------------------------------------------------------------------------

/**
 * Parses the raw array returned by `check_multi.lua` into a typed object.
 *
 * Expected Lua return: `{allowed, failed_dimension, effective, limit, ttl_ms}`
 *
 * @param raw Raw value returned by `ScriptLoader.eval`.
 * @returns Typed {@link LuaCheckResult}.
 * @throws {Error} If the raw result is not an array of the expected shape.
 */
function parseLuaCheckResult(raw: unknown): LuaCheckResult {
  if (!Array.isArray(raw) || raw.length < 5) {
    throw new Error(`Unexpected check_multi result: ${JSON.stringify(raw)}`);
  }
  return {
    allowed: Number(raw[0]) === 1,
    failedDimension: String(raw[1] ?? ''),
    effective: Number(raw[2] ?? 0),
    limit: Number(raw[3] ?? 0),
    ttlMs: Number(raw[4] ?? 0),
  };
}

/**
 * Parses the raw array returned by `status.lua` into a typed object.
 *
 * Expected Lua return: `{effective, limit, remaining, ttl_ms}`
 *
 * @param raw Raw value returned by `ScriptLoader.eval`.
 * @returns Typed {@link LuaStatusResult}.
 */
function parseLuaStatusResult(raw: unknown): LuaStatusResult {
  if (!Array.isArray(raw) || raw.length < 4) {
    return { effective: 0, limit: 0, remaining: 0, ttlMs: 0 };
  }
  return {
    effective: Number(raw[0] ?? 0),
    limit: Number(raw[1] ?? 0),
    remaining: Number(raw[2] ?? 0),
    ttlMs: Number(raw[3] ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/**
 * Builds a fully-allowed {@link RateLimitResult}.
 *
 * @param dimension  Dimension name to report (usually "none").
 * @param effective  Effective count to report.
 * @param limit      Limit to report.
 * @param remaining  Remaining tokens to report.
 * @param resetAt    Unix epoch ms for window reset.
 * @param source     Decision source.
 */
function buildAllowedResult(
  dimension: string,
  effective: number,
  limit: number,
  remaining: number,
  resetAt: number,
  source: RateLimitResult['source'],
  windowSecs?: number,
): RateLimitResult {
  return {
    allowed: true,
    dimension,
    effective,
    limit,
    remaining,
    resetAt,
    windowSecs,
    source,
  };
}

/**
 * Returns the {@link LimitSpec} for the named dimension from a rule, or undefined
 * if the rule does not define that dimension.
 *
 * @param rule      The rate limit rule.
 * @param dimension Dimension name.
 * @returns The limit spec or `undefined`.
 */
function getSpecForDimension(
  rule: RuleConfig,
  dimension: 'ip' | 'user' | 'route' | 'user-route',
): LimitSpec | undefined {
  switch (dimension) {
    case 'ip': return rule.limits.ip;
    case 'route': return rule.limits.route;
    case 'user': return rule.limits.user;
    case 'user-route': return rule.limits.userRoute;
  }
}
