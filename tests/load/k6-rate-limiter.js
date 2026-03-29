/**
 * k6 load test for the AWS Rate Limiter HTTP server.
 *
 * Run with:
 *   k6 run --env TARGET_URL=http://localhost:3000 tests/load/k6-rate-limiter.js
 *
 * Scenarios
 * ---------
 * 1. sustained  — 1 000 VUs for 60 s  (validates steady-state throughput)
 * 2. spike      — ramp to 5 000 VUs   (validates burst handling)
 *
 * Thresholds
 * ----------
 * - p99 latency of rate-limit check < 5 ms
 * - Error rate (5xx / connection errors) < 1 %
 * - Overall check success rate > 99 %
 */

import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter, Trend, Rate } from 'k6/metrics'

// ---------------------------------------------------------------------------
// Scenario & threshold configuration
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    /** Sustained throughput: 1 000 VUs constant for 60 s */
    sustained: {
      executor: 'constant-vus',
      vus: 1000,
      duration: '60s',
      tags: { scenario: 'sustained' },
    },
    /** Spike: ramp to 5 000 VUs, hold 30 s, ramp down */
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 5000 },
        { duration: '30s', target: 5000 },
        { duration: '10s', target: 0 },
      ],
      startTime: '70s',
      tags: { scenario: 'spike' },
    },
  },
  thresholds: {
    /** p99 of rate-limit check latency must stay below 5 ms */
    rate_limit_check_latency: ['p(99)<5'],
    /** Less than 1 % of requests may be errors (5xx or connection failures) */
    errors: ['rate<0.01'],
    /** More than 99 % of checks must succeed (200 or 429 — not 5xx/error) */
    checks: ['rate>0.99'],
  },
}

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

/** End-to-end latency of each rate-limit check (ms). */
const rateLimitCheckLatency = new Trend('rate_limit_check_latency', true)

/** Rate of server errors / connection failures. */
const errors = new Rate('errors')

/** Total requests denied (HTTP 429). */
const deniedCount = new Counter('rate_limit_denied')

/** Total requests allowed (HTTP 200). */
const allowedCount = new Counter('rate_limit_allowed')

// ---------------------------------------------------------------------------
// Target URL (override via --env TARGET_URL=...)
// ---------------------------------------------------------------------------

// __ENV is injected by k6 at runtime.
/* global __ENV */
const TARGET_URL = typeof __ENV !== 'undefined' && __ENV.TARGET_URL
  ? __ENV.TARGET_URL
  : 'http://localhost:3000'

// ---------------------------------------------------------------------------
// Default function — called once per VU iteration
// ---------------------------------------------------------------------------

export default function () {
  // Unique per-iteration identifiers spread traffic across many keys.
  const userId = `user-${Math.floor(Math.random() * 10000)}`
  const ip = [
    '10',
    Math.floor(Math.random() * 255),
    Math.floor(Math.random() * 255),
    Math.floor(Math.random() * 255),
  ].join('.')

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-Real-IP': ip,
      'X-User-ID': userId,
    },
    // k6 timeout in ms — give the server a 10 s window before failing.
    timeout: 10000,
  }

  const start = Date.now()
  const res = http.get(`${TARGET_URL}/api/test-endpoint`, params)
  const latency = Date.now() - start

  rateLimitCheckLatency.add(latency)

  // A result is an *error* only when the server is broken (5xx) or
  // unreachable (status 0).  HTTP 429 is an expected application response.
  const isError = res.status === 0 || res.status >= 500
  errors.add(isError ? 1 : 0)

  if (res.status === 429) {
    deniedCount.add(1)
  } else if (res.status === 200) {
    allowedCount.add(1)
  }

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'response has X-RateLimit-Limit header': (r) =>
      r.headers['X-RateLimit-Limit'] !== undefined,
    'response time < 10ms': (r) => r.timings.duration < 10,
  })

  // 1 ms think time — keeps the VU tight while still being realistic.
  sleep(0.001)
}

// ---------------------------------------------------------------------------
// Custom summary handler
// ---------------------------------------------------------------------------

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  }
}

/**
 * Render a human-readable summary of the most relevant metrics.
 *
 * @param {object} data        k6 summary data object.
 * @param {object} [options]   Formatting options.
 * @param {string} [options.indent]       Line-prefix string (default: '').
 * @param {boolean} [options.enableColors] Whether to emit ANSI colour codes.
 * @returns {string} Formatted summary text.
 */
function textSummary(data, options = {}) {
  const indent = options.indent || ''
  const lines = [
    '',
    `${indent}Rate Limiter Load Test Summary`,
    `${indent}${'='.repeat(40)}`,
  ]

  const metrics = data.metrics || {}

  // Latency
  const latencyMetric = metrics['rate_limit_check_latency']
  if (latencyMetric) {
    const v = latencyMetric.values
    lines.push(`${indent}Latency (rate-limit check):`)
    lines.push(`${indent}  p50 : ${(v.med ?? 0).toFixed(2)} ms`)
    lines.push(`${indent}  p90 : ${(v['p(90)'] ?? 0).toFixed(2)} ms`)
    lines.push(`${indent}  p95 : ${(v['p(95)'] ?? 0).toFixed(2)} ms`)
    lines.push(`${indent}  p99 : ${(v['p(99)'] ?? 0).toFixed(2)} ms`)
    lines.push(`${indent}  max : ${(v.max ?? 0).toFixed(2)} ms`)
  }

  // Traffic breakdown
  const allowedMetric = metrics['rate_limit_allowed']
  const deniedMetric = metrics['rate_limit_denied']
  if (allowedMetric && deniedMetric) {
    const allowed = allowedMetric.values.count ?? 0
    const denied = deniedMetric.values.count ?? 0
    const total = allowed + denied
    const denialPct = total > 0 ? ((denied / total) * 100).toFixed(1) : '0.0'
    lines.push(`${indent}Traffic:`)
    lines.push(`${indent}  allowed : ${allowed}`)
    lines.push(`${indent}  denied  : ${denied} (${denialPct}% denial rate)`)
  }

  // Error rate
  const errorsMetric = metrics['errors']
  if (errorsMetric) {
    const rate = ((errorsMetric.values.rate ?? 0) * 100).toFixed(3)
    lines.push(`${indent}Error rate: ${rate}%`)
  }

  // HTTP request duration (overall, reported by k6)
  const httpDuration = metrics['http_req_duration']
  if (httpDuration) {
    const v = httpDuration.values
    lines.push(`${indent}HTTP req duration (overall):`)
    lines.push(`${indent}  p99 : ${(v['p(99)'] ?? 0).toFixed(2)} ms`)
  }

  lines.push('')
  return lines.join('\n')
}
