# Load Tests (k6)

End-to-end load tests using [k6](https://k6.io/) to validate throughput and latency targets for the AWS Rate Limiter.

## Performance Targets

| Metric | Target |
|--------|--------|
| p50 latency (overall check) | < 1 ms |
| p99 latency (overall check) | **< 5 ms** |
| Error rate | < 1 % |
| Check success rate | > 99 % |

## Prerequisites

1. Install k6: https://k6.io/docs/getting-started/installation/
   ```bash
   brew install k6           # macOS
   # or
   apt install k6            # Debian/Ubuntu
   ```
2. Have a running instance of the rate limiter server:
   ```bash
   npm run build && node dist/adapters/express.js
   # or the Express / Fastify adapter of your choice
   ```

## Running the Load Tests

### Quick smoke run (50 VUs, 10 s)

```bash
k6 run \
  --env TARGET_URL=http://localhost:3000 \
  --vus 50 --duration 10s \
  tests/load/k6-rate-limiter.js
```

### Full scenario run (uses options defined in the script)

```bash
k6 run \
  --env TARGET_URL=http://localhost:3000 \
  tests/load/k6-rate-limiter.js
```

### Against a remote target

```bash
k6 run \
  --env TARGET_URL=https://api.example.com \
  tests/load/k6-rate-limiter.js
```

## Scenarios

| Scenario | VUs | Duration | Purpose |
|----------|-----|----------|---------|
| `sustained` | 1 000 constant | 60 s | Validate steady-state throughput |
| `spike` | 0 → 5 000 → 0 | 50 s (starts at t=70s) | Validate burst resilience |

## Custom Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `rate_limit_check_latency` | Trend | End-to-end latency of each HTTP check (ms) |
| `rate_limit_allowed` | Counter | Number of HTTP 200 responses |
| `rate_limit_denied` | Counter | Number of HTTP 429 responses |
| `errors` | Rate | Fraction of requests returning 5xx or connection error |

## Thresholds

The script fails (`k6 run` exits non-zero) if any of the following are violated:

```
rate_limit_check_latency p(99) < 5 ms
errors                   rate  < 0.01
checks                   rate  > 0.99
```

## Expected Response Format

The rate limiter server must respond with:
- `200 OK` — request allowed
- `429 Too Many Requests` — request denied
- `X-RateLimit-Limit` response header (used in checks)

Anything `5xx` or a connection failure counts as an error.

## CI Integration

Add to your CI pipeline after deployment to a staging environment:

```yaml
# .github/workflows/load-test.yml (example)
- name: Run k6 load test
  run: |
    k6 run \
      --env TARGET_URL=${{ secrets.STAGING_URL }} \
      --out json=results.json \
      tests/load/k6-rate-limiter.js
```
