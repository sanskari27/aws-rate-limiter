/**
 * @fileoverview Unit tests for the metrics module.
 */

import {
  NoopMetrics,
  InMemoryMetrics,
  MetricNames,
  createMetrics,
  MetricsBackend,
} from '../../../src/observability/metrics';

// ---------------------------------------------------------------------------
// NoopMetrics
// ---------------------------------------------------------------------------

describe('NoopMetrics', () => {
  let noop: NoopMetrics;

  beforeEach(() => {
    noop = new NoopMetrics();
  });

  test('increment does not throw', () => {
    expect(() => noop.increment('some.metric')).not.toThrow();
  });

  test('increment with tags does not throw', () => {
    expect(() => noop.increment('some.metric', { dim: 'val' }, 5)).not.toThrow();
  });

  test('histogram does not throw', () => {
    expect(() => noop.histogram('some.latency', 1.5)).not.toThrow();
  });

  test('histogram with tags does not throw', () => {
    expect(() => noop.histogram('some.latency', 1.5, { route: '/api' })).not.toThrow();
  });

  test('gauge does not throw', () => {
    expect(() => noop.gauge('some.gauge', 42)).not.toThrow();
  });

  test('gauge with tags does not throw', () => {
    expect(() => noop.gauge('some.gauge', 42, { env: 'prod' })).not.toThrow();
  });

  test('flush resolves without error', async () => {
    await expect(noop.flush()).resolves.toBeUndefined();
  });

  test('implements MetricsBackend interface', () => {
    const backend: MetricsBackend = noop;
    expect(typeof backend.increment).toBe('function');
    expect(typeof backend.histogram).toBe('function');
    expect(typeof backend.gauge).toBe('function');
    expect(typeof backend.flush).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// InMemoryMetrics
// ---------------------------------------------------------------------------

describe('InMemoryMetrics', () => {
  let metrics: InMemoryMetrics;

  beforeEach(() => {
    metrics = new InMemoryMetrics();
  });

  // -- increment --------------------------------------------------------------

  test('increment accumulates counter values', () => {
    metrics.increment('counter.a');
    metrics.increment('counter.a');
    metrics.increment('counter.a');
    expect(metrics.counters.get('counter.a')).toBe(3);
  });

  test('increment with explicit value', () => {
    metrics.increment('counter.b', undefined, 5);
    metrics.increment('counter.b', undefined, 3);
    expect(metrics.counters.get('counter.b')).toBe(8);
  });

  test('increment defaults to value 1', () => {
    metrics.increment('counter.c');
    expect(metrics.counters.get('counter.c')).toBe(1);
  });

  test('different counter names are independent', () => {
    metrics.increment('counter.x');
    metrics.increment('counter.y');
    metrics.increment('counter.y');
    expect(metrics.counters.get('counter.x')).toBe(1);
    expect(metrics.counters.get('counter.y')).toBe(2);
  });

  test('increment accepts tags without error', () => {
    expect(() =>
      metrics.increment('counter.tagged', { dimension: 'ip' }, 2),
    ).not.toThrow();
    expect(metrics.counters.get('counter.tagged')).toBe(2);
  });

  // -- histogram --------------------------------------------------------------

  test('histogram stores observed values in order', () => {
    metrics.histogram('hist.latency', 1.0);
    metrics.histogram('hist.latency', 2.5);
    metrics.histogram('hist.latency', 0.8);
    expect(metrics.histogramValues.get('hist.latency')).toEqual([1.0, 2.5, 0.8]);
  });

  test('histogram with tags does not throw', () => {
    expect(() =>
      metrics.histogram('hist.redis', 3.2, { op: 'evalsha' }),
    ).not.toThrow();
    expect(metrics.histogramValues.get('hist.redis')).toEqual([3.2]);
  });

  test('different histogram metrics are independent', () => {
    metrics.histogram('h1', 1);
    metrics.histogram('h2', 2);
    expect(metrics.histogramValues.get('h1')).toEqual([1]);
    expect(metrics.histogramValues.get('h2')).toEqual([2]);
  });

  // -- gauge ------------------------------------------------------------------

  test('gauge stores the latest value', () => {
    metrics.gauge('gauge.connections', 10);
    metrics.gauge('gauge.connections', 15);
    expect(metrics.gaugeValues.get('gauge.connections')).toBe(15);
  });

  test('gauge with tags does not throw', () => {
    expect(() =>
      metrics.gauge('gauge.circuit', 1, { state: 'open' }),
    ).not.toThrow();
    expect(metrics.gaugeValues.get('gauge.circuit')).toBe(1);
  });

  // -- flush ------------------------------------------------------------------

  test('flush resolves without error', async () => {
    await expect(metrics.flush()).resolves.toBeUndefined();
  });

  // -- reset ------------------------------------------------------------------

  test('reset clears all counters, histograms, and gauges', () => {
    metrics.increment('counter.a');
    metrics.histogram('hist.b', 1.0);
    metrics.gauge('gauge.c', 42);

    metrics.reset();

    expect(metrics.counters.size).toBe(0);
    expect(metrics.histogramValues.size).toBe(0);
    expect(metrics.gaugeValues.size).toBe(0);
  });

  test('after reset, metrics accumulate from zero again', () => {
    metrics.increment('counter.a');
    metrics.reset();
    metrics.increment('counter.a');
    expect(metrics.counters.get('counter.a')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// MetricNames constants
// ---------------------------------------------------------------------------

describe('MetricNames', () => {
  test('CHECK_TOTAL has expected string value', () => {
    expect(MetricNames.CHECK_TOTAL).toBe('rate_limiter.check.total');
  });

  test('CHECK_ALLOWED has expected string value', () => {
    expect(MetricNames.CHECK_ALLOWED).toBe('rate_limiter.check.allowed');
  });

  test('CHECK_DENIED has expected string value', () => {
    expect(MetricNames.CHECK_DENIED).toBe('rate_limiter.check.denied');
  });

  test('CHECK_LATENCY has expected string value', () => {
    expect(MetricNames.CHECK_LATENCY).toBe('rate_limiter.check.latency');
  });

  test('RESERVOIR_HIT has expected string value', () => {
    expect(MetricNames.RESERVOIR_HIT).toBe('rate_limiter.reservoir.hit');
  });

  test('RESERVOIR_MISS has expected string value', () => {
    expect(MetricNames.RESERVOIR_MISS).toBe('rate_limiter.reservoir.miss');
  });

  test('RESERVOIR_REFILL has expected string value', () => {
    expect(MetricNames.RESERVOIR_REFILL).toBe('rate_limiter.reservoir.refill');
  });

  test('REDIS_LATENCY has expected string value', () => {
    expect(MetricNames.REDIS_LATENCY).toBe('rate_limiter.redis.latency');
  });

  test('REDIS_ERRORS has expected string value', () => {
    expect(MetricNames.REDIS_ERRORS).toBe('rate_limiter.redis.errors');
  });

  test('FAIL_OPEN has expected string value', () => {
    expect(MetricNames.FAIL_OPEN).toBe('rate_limiter.fail_open');
  });

  test('FAIL_CLOSED has expected string value', () => {
    expect(MetricNames.FAIL_CLOSED).toBe('rate_limiter.fail_closed');
  });

  test('FAIL_LOCAL has expected string value', () => {
    expect(MetricNames.FAIL_LOCAL).toBe('rate_limiter.fail_local');
  });

  test('CIRCUIT_BREAKER_STATE has expected string value', () => {
    expect(MetricNames.CIRCUIT_BREAKER_STATE).toBe('rate_limiter.circuit_breaker.state');
  });

  test('NOSCRIPT_RELOAD has expected string value', () => {
    expect(MetricNames.NOSCRIPT_RELOAD).toBe('rate_limiter.noscript_reload');
  });
});

// ---------------------------------------------------------------------------
// createMetrics
// ---------------------------------------------------------------------------

describe('createMetrics', () => {
  test('createMetrics("none") returns NoopMetrics', () => {
    expect(createMetrics('none')).toBeInstanceOf(NoopMetrics);
  });

  test('createMetrics("memory") returns InMemoryMetrics', () => {
    expect(createMetrics('memory')).toBeInstanceOf(InMemoryMetrics);
  });

  test('createMetrics() with undefined returns NoopMetrics', () => {
    expect(createMetrics(undefined)).toBeInstanceOf(NoopMetrics);
  });

  test('createMetrics() with no args returns NoopMetrics', () => {
    expect(createMetrics()).toBeInstanceOf(NoopMetrics);
  });

  test('createMetrics("cloudwatch") returns NoopMetrics and writes "not yet implemented" to stderr', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = createMetrics('cloudwatch');
    expect(result).toBeInstanceOf(NoopMetrics);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('not yet implemented'),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('cloudwatch'),
    );
    stderrSpy.mockRestore();
  });

  test('createMetrics("prometheus") returns NoopMetrics and writes "not yet implemented" to stderr', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = createMetrics('prometheus');
    expect(result).toBeInstanceOf(NoopMetrics);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('not yet implemented'),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('prometheus'),
    );
    stderrSpy.mockRestore();
  });

  test('createMetrics("statsd") returns NoopMetrics and writes "not yet implemented" to stderr', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = createMetrics('statsd');
    expect(result).toBeInstanceOf(NoopMetrics);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('not yet implemented'),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('statsd'),
    );
    stderrSpy.mockRestore();
  });

  test('createMetrics("none") does NOT write to stderr', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    createMetrics('none');
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  test('createMetrics(undefined) does NOT write to stderr', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    createMetrics(undefined);
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  test('createMetrics with unknown backend returns NoopMetrics', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(createMetrics('cloudwatch')).toBeInstanceOf(NoopMetrics);
    expect(createMetrics('prometheus')).toBeInstanceOf(NoopMetrics);
    expect(createMetrics('statsd')).toBeInstanceOf(NoopMetrics);
    stderrSpy.mockRestore();
  });

  test('createMetrics with completely unknown backend logs to stderr and returns NoopMetrics', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // 'totally-unknown' does not match any named case → hits the default branch
    const result = createMetrics('totally-unknown' as Parameters<typeof createMetrics>[0]);
    expect(result).toBeInstanceOf(NoopMetrics);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown backend "totally-unknown"'),
    );
    stderrSpy.mockRestore();
  });
});
