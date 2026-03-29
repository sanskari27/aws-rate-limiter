/**
 * @fileoverview Shared TypeScript interfaces and error classes for the AWS Rate Limiter.
 * All public types used across the rate limiter module are exported from this file.
 */

/**
 * Input context for a rate limit check. Represents a single incoming request.
 */
export interface RateLimitContext {
  /** Raw IP address of the requester (IPv4 or IPv6) */
  ip: string;
  /** Optional user identifier (will be hashed before use) */
  userId?: string;
  /** Optional API key (will be hashed before use) */
  apiKey?: string;
  /** Raw request path, e.g. "/api/users/123" */
  route: string;
  /** HTTP method, e.g. "GET", "POST" */
  method: string;
  /** User tier for rule matching, e.g. "free", "pro", "enterprise" */
  userTier?: string;
  /** Request cost weight; defaults to 1 */
  cost?: number;
}

/**
 * Result returned by the rate limiter after processing a request context.
 */
export interface RateLimitResult {
  /** Whether the request is allowed to proceed */
  allowed: boolean;
  /** Which dimension triggered the deny, or "none" if the request was allowed */
  dimension: string;
  /** The computed effective request count for the triggering dimension */
  effective: number;
  /** The configured limit for the triggering dimension */
  limit: number;
  /** Remaining requests available in the current window */
  remaining: number;
  /** Unix epoch milliseconds when the current window resets */
  resetAt: number;
  /** Window duration in seconds for the triggering dimension (used in policy headers) */
  windowSecs?: number;
  /** Milliseconds to wait before retrying (only present on deny) */
  retryAfter?: number;
  /** Where the decision was sourced from */
  source: 'reservoir' | 'redis' | 'local_fallback';
}

/**
 * Configuration for a single rate limiting dimension (e.g. per-IP or per-user).
 */
export interface LimitSpec {
  /** Maximum number of requests allowed in the window */
  limit: number;
  /** Window duration in seconds */
  window: number;
}

/**
 * Configuration for a single rate limit rule, including match criteria and limits.
 */
export interface RuleConfig {
  /** Unique rule name for identification in logs and metrics */
  name: string;
  /** Optional criteria for matching this rule to an incoming request */
  match?: {
    /** Glob patterns for routes, e.g. ["GET /api/*"] */
    routes?: string[];
    /** User tier strings this rule applies to */
    userTiers?: string[];
    /** Exact IP addresses this rule applies to (matched by string equality) */
    ips?: string[];
    /** HTTP header key/value pairs required to match */
    headers?: Record<string, string>;
  };
  /** Per-dimension rate limit specifications */
  limits: {
    ip?: LimitSpec;
    route?: LimitSpec;
    user?: LimitSpec;
    userRoute?: LimitSpec;
  };
  /** Override cost for requests matched by this rule */
  cost?: number;
  /** Circuit breaker failure policy for this rule */
  failure?: 'open' | 'closed' | 'local';
  /** Local reservoir configuration for this rule */
  reservoir?: {
    batchSize?: number;
  };
}

/**
 * Redis / ElastiCache connection configuration.
 */
export interface RedisConfig {
  /** Single-node Redis URL, e.g. "redis://localhost:6379" */
  url?: string;
  /** Authentication password */
  password?: string;
  /** Cluster mode configuration (mutually exclusive with url for single-node) */
  cluster?: {
    nodes: { host: string; port: number }[];
  };
  /** Connection timeout in milliseconds */
  connectTimeout?: number;
  /** Per-command timeout in milliseconds */
  commandTimeout?: number;
  /** Maximum retries per command before failing */
  maxRetriesPerRequest?: number;
}

/**
 * Configuration for the in-process local reservoir that pre-fetches tokens from Redis.
 */
export interface ReservoirConfig {
  /** Whether the reservoir is active */
  enabled: boolean;
  /** Number of tokens to claim from Redis per batch */
  batchSize: number;
  /** Milliseconds between background syncs */
  syncInterval: number;
}

/**
 * Global failure-mode policy and circuit breaker configuration.
 */
export interface FailureConfig {
  /** Default failure policy when Redis is unavailable */
  default: 'open' | 'closed' | 'local';
  /** Circuit breaker settings */
  circuitBreaker?: {
    /** Whether the circuit breaker is enabled */
    enabled: boolean;
    /** Number of consecutive failures before the circuit opens */
    threshold: number;
    /** Milliseconds to wait before transitioning to half-open */
    recoveryTimeout: number;
  };
}

/**
 * Observability configuration for metrics and logging.
 */
export interface ObservabilityConfig {
  /** Metrics backend to use */
  metrics?: 'cloudwatch' | 'prometheus' | 'statsd' | 'none';
  /** Minimum log level to emit */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Fraction of allowed-request log entries to emit (0–1).
   * Denied requests are always logged (rate = 1).
   */
  logSampleRate?: number;
  /** CloudWatch / Prometheus metric namespace */
  namespace?: string;
}

/**
 * Configuration for how the real client IP is extracted from a request.
 */
export interface IPExtractionConfig {
  /** Whether to read the X-Forwarded-For header */
  trustXForwardedFor: boolean;
  /** Number of trusted reverse proxies; used to select the real IP from XFF */
  trustedProxyCount: number;
  /** IPv6 prefix length to normalize to (e.g. 64 collapses to /64 subnet) */
  ipv6PrefixLength?: number;
}

/**
 * Configuration for how the authenticated user identity is extracted.
 */
export interface UserExtractionConfig {
  /** Header that contains the JWT token */
  jwtHeader?: string;
  /** JWT claim to use as the user identifier */
  jwtClaim?: string;
  /** Header that carries the API key */
  apiKeyHeader?: string;
  /** If true, all identifiers are SHA-256-hashed before storage */
  hashIdentifiers?: boolean;
}

/**
 * Top-level configuration object for the RateLimiter.
 */
export interface RateLimiterConfig {
  /** Redis / ElastiCache connection details */
  redis: RedisConfig;
  /** Ordered list of rate limit rules (first match wins) */
  rules: RuleConfig[];
  /** Global reservoir settings (can be overridden per rule) */
  reservoir?: ReservoirConfig;
  /** Global failure-mode / circuit breaker settings */
  failure?: FailureConfig;
  /** IP extraction settings */
  ipExtraction?: IPExtractionConfig;
  /** User identity extraction settings */
  userExtraction?: UserExtractionConfig;
  /** Metrics and logging settings */
  observability?: ObservabilityConfig;
}

/**
 * Result of checking a single rate-limit dimension against Redis.
 */
export interface DimensionCheck {
  /** Dimension name, e.g. "ip", "route", "user", "userRoute" */
  dimension: string;
  /** Whether this dimension check passed */
  allowed: boolean;
  /** Sliding-window effective count at the time of the check */
  effective: number;
  /** Configured limit for this dimension */
  limit: number;
  /** Tokens remaining after this request */
  remaining: number;
  /** Milliseconds until the current window expires */
  ttlMs: number;
}

// ---------------------------------------------------------------------------
// Typed error classes
// ---------------------------------------------------------------------------

/**
 * Base error class for all rate limiter errors.
 * Always carries a machine-readable {@link code} for programmatic handling.
 */
export class RateLimiterError extends Error {
  /**
   * @param message Human-readable description of the error.
   * @param code    Machine-readable error code (e.g. "REDIS_CONNECTION_ERROR").
   */
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'RateLimiterError';
    // Maintain proper prototype chain in transpiled ES5 targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the Redis / ElastiCache connection cannot be established or is lost.
 */
export class RedisConnectionError extends RateLimiterError {
  /**
   * @param message Human-readable description of the connection failure.
   */
  constructor(message: string) {
    super(message, 'REDIS_CONNECTION_ERROR');
    this.name = 'RedisConnectionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the provided configuration is invalid or missing required fields.
 */
export class ConfigurationError extends RateLimiterError {
  /**
   * @param message Human-readable description of the configuration problem.
   */
  constructor(message: string) {
    super(message, 'CONFIGURATION_ERROR');
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a Redis key cannot be constructed due to invalid input.
 */
export class KeyBuilderError extends RateLimiterError {
  /**
   * @param message Human-readable description of the key construction failure.
   */
  constructor(message: string) {
    super(message, 'KEY_BUILDER_ERROR');
    this.name = 'KeyBuilderError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
