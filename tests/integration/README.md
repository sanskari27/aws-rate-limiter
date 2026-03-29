# Integration Tests

These tests run against a real Redis instance. They are **skipped automatically** in CI unless Redis is available.

## Prerequisites

- Redis >= 6.x running and reachable
- Node.js >= 18.x
- All dependencies installed (`npm install`)

## Running the Integration Tests

### Option 1 — explicit Redis URL

```bash
REDIS_URL=redis://localhost:6379 npx jest tests/integration
```

### Option 2 — flag only (uses `redis://localhost:6379` by default)

```bash
INTEGRATION_TESTS=true npx jest tests/integration
```

### Option 3 — local Docker Redis

```bash
docker run -d --rm -p 6379:6379 redis:7-alpine
REDIS_URL=redis://localhost:6379 npx jest tests/integration
```

## Skip behaviour

If neither `REDIS_URL` nor `INTEGRATION_TESTS=true` is set, every test in this folder is skipped. The unit test suite (`tests/unit`) never requires Redis.

## Test coverage

| Test | What it validates |
|------|-------------------|
| allows first request | Basic `check()` returns `allowed=true` and `source='redis'` |
| increments counter | Successive checks accumulate the sliding-window counter |
| denies when limit exceeded | After exhausting the IP limit the 11th request is denied |
| status does not increment | `status()` is read-only — two calls return the same effective count |
| reset clears the counter | `reset('ip', ip)` deletes bucket keys, lowering the effective count |
| user dimension | Per-user limit (5) is enforced independently of the IP limit (10) |
| retryAfter on deny | Denied results include a positive `retryAfter` value |
| isConnected | `isConnected()` returns `true` after `connect()` |
| resetAt is in the future | `resetAt` is a valid future Unix epoch ms timestamp |

## Testcontainers (optional)

For fully automated CI, wire up [testcontainers-node](https://node.testcontainers.org/) in a Jest `globalSetup` that starts a Redis container and sets `process.env.REDIS_URL` before the tests run.

```typescript
// tests/integration/setup.ts (example)
import { GenericContainer } from 'testcontainers'

export default async function setup() {
  const container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start()
  process.env.REDIS_URL = `redis://localhost:${container.getMappedPort(6379)}`
  ;(global as Record<string, unknown>).__REDIS_CONTAINER__ = container
}
```
