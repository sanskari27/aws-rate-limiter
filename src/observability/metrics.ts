/**
 * @fileoverview Metrics abstraction layer for the AWS Rate Limiter.
 *
 * Supports multiple backends (CloudWatch, Prometheus, no-op) through a common
 * {@link MetricsBackend} interface.  Use {@link createMetrics} to instantiate
 * the appropriate backend based on configuration.
 *
 * {@link InMemoryMetrics} is provided for unit/integration testing.
 */

// ---------------------------------------------------------------------------
// MetricsBackend interface
// ---------------------------------------------------------------------------

/**
 * Common interface for all metrics backends.
 */
export interface MetricsBackend {
  /**
   * Increment a counter metric.
   *
   * @param name  Metric name (use a constant from {@link MetricNames}).
   * @param tags  Optional key/value dimension tags.
   * @param value Amount to increment by (default 1).
   */
  increment(name: string, tags?: Record<string, string>, value?: number): void;

  /**
   * Record a value in a histogram metric (e.g. latency in ms).
   *
   * @param name  Metric name.
   * @param value Observed value.
   * @param tags  Optional key/value dimension tags.
   */
  histogram(name: string, value: number, tags?: Record<string, string>): void;

  /**
   * Set a gauge metric to an absolute value.
   *
   * @param name  Metric name.
   * @param value Current gauge value.
   * @param tags  Optional key/value dimension tags.
   */
  gauge(name: string, value: number, tags?: Record<string, string>): void;

  /**
   * Flush any buffered metrics to the backend.
   * Some backends (e.g. CloudWatch) batch metrics for efficiency.
   *
   * @returns Promise that resolves when the flush is complete.
   */
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// NoopMetrics
// ---------------------------------------------------------------------------

/**
 * No-operation metrics backend.  All calls are safe and do nothing.
 * Use as a default when no metrics backend is configured.
 */
export class NoopMetrics implements MetricsBackend {
  /** @inheritdoc */
  increment(_name: string, _tags?: Record<string, string>, _value?: number): void {}

  /** @inheritdoc */
  histogram(_name: string, _value: number, _tags?: Record<string, string>): void {}

  /** @inheritdoc */
  gauge(_name: string, _value: number, _tags?: Record<string, string>): void {}

  /** @inheritdoc */
  async flush(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// InMemoryMetrics
// ---------------------------------------------------------------------------

/**
 * In-memory metrics backend intended for unit and integration testing.
 *
 * All emitted metrics are stored in public maps so tests can assert on them
 * without requiring a real metrics backend.
 *
 * @example
 * ```typescript
 * const metrics = new InMemoryMetrics()
 * // inject into component under test …
 * expect(metrics.counters.get('rate_limiter.check.total')).toBe(1)
 * ```
 */
export class InMemoryMetrics implements MetricsBackend {
  /** Accumulated counter values, keyed by metric name. */
  readonly counters = new Map<string, number>();

  /** All observed histogram values, keyed by metric name. */
  readonly histogramValues = new Map<string, number[]>();

  /** Latest gauge value, keyed by metric name. */
  readonly gaugeValues = new Map<string, number>();

  /** @inheritdoc */
  increment(name: string, _tags?: Record<string, string>, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  /** @inheritdoc */
  histogram(name: string, value: number, _tags?: Record<string, string>): void {
    const arr = this.histogramValues.get(name) ?? [];
    arr.push(value);
    this.histogramValues.set(name, arr);
  }

  /** @inheritdoc */
  gauge(name: string, value: number, _tags?: Record<string, string>): void {
    this.gaugeValues.set(name, value);
  }

  /** @inheritdoc */
  async flush(): Promise<void> {}

  /**
   * Clear all stored metrics.  Useful for resetting state between tests.
   */
  reset(): void {
    this.counters.clear();
    this.histogramValues.clear();
    this.gaugeValues.clear();
  }
}

// ---------------------------------------------------------------------------
// Metric name constants
// ---------------------------------------------------------------------------

/**
 * Canonical metric names emitted by the rate limiter.
 * Always use these constants rather than raw strings to avoid typos.
 */
export const MetricNames = {
  CHECK_TOTAL: 'rate_limiter.check.total',
  CHECK_ALLOWED: 'rate_limiter.check.allowed',
  CHECK_DENIED: 'rate_limiter.check.denied',
  CHECK_LATENCY: 'rate_limiter.check.latency',
  RESERVOIR_HIT: 'rate_limiter.reservoir.hit',
  RESERVOIR_MISS: 'rate_limiter.reservoir.miss',
  RESERVOIR_REFILL: 'rate_limiter.reservoir.refill',
  REDIS_LATENCY: 'rate_limiter.redis.latency',
  REDIS_ERRORS: 'rate_limiter.redis.errors',
  FAIL_OPEN: 'rate_limiter.fail_open',
  FAIL_CLOSED: 'rate_limiter.fail_closed',
  FAIL_LOCAL: 'rate_limiter.fail_local',
  CIRCUIT_BREAKER_STATE: 'rate_limiter.circuit_breaker.state',
  NOSCRIPT_RELOAD: 'rate_limiter.noscript_reload',
} as const;

/** Union type of all valid metric name strings. */
export type MetricName = (typeof MetricNames)[keyof typeof MetricNames];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link MetricsBackend} appropriate for the given backend identifier.
 *
 * | `backend` value | Returned instance      |
 * |-----------------|------------------------|
 * | `'none'`        | {@link NoopMetrics}    |
 * | `undefined`     | {@link NoopMetrics}    |
 * | `'memory'`      | {@link InMemoryMetrics}|
 * | anything else   | {@link NoopMetrics}    |
 *
 * @param backend Optional backend identifier string.
 * @returns An appropriate {@link MetricsBackend} instance.
 */
export function createMetrics(backend?: string): MetricsBackend {
  switch (backend) {
    case 'memory':
      return new InMemoryMetrics();
    case 'cloudwatch':
    case 'prometheus':
    case 'statsd':
      process.stderr.write(
        `[rate-limiter/metrics] Backend "${backend}" is not yet implemented; using noop\n`,
      );
      return new NoopMetrics();
    case 'none':
    case undefined:
      return new NoopMetrics();
    default:
      process.stderr.write(
        `[rate-limiter/metrics] Unknown backend "${backend}"; using noop\n`,
      );
      return new NoopMetrics();
  }
}
