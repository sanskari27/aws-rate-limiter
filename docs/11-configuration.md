# 11 — Configuration Reference

## Full Configuration Schema

```typescript
interface RateLimiterConfig {
  // Redis connection
  redis: {
    url: string                    // redis://... or rediss://... (TLS)
    password?: string              // AUTH token for ElastiCache
    cluster?: {
      nodes: { host: string; port: number }[]
    }
    connectTimeout?: number        // ms, default 200
    commandTimeout?: number        // ms, default 100
    maxRetriesPerRequest?: number  // default 1 (fail fast)
  }
  
  // Rate limit rules (evaluated in order, first match wins)
  rules: RuleConfig[]
  
  // Local reservoir (token pre-fetch)
  reservoir?: {
    enabled: boolean               // default: true
    batchSize: number              // tokens to pre-fetch per refill, default: 10
    syncInterval: number           // max ms between forced syncs, default: 5000
  }
  
  // Failure handling
  failure?: {
    default: 'open' | 'closed' | 'local'  // default: 'open'
    circuitBreaker?: {
      enabled: boolean             // default: true
      threshold: number            // failures before opening, default: 5
      recoveryTimeout: number      // ms before half-open probe, default: 10000
    }
  }
  
  // IP extraction
  ipExtraction?: {
    trustXForwardedFor: boolean    // default: true
    trustedProxyCount: number      // default: 1
    ipv6PrefixLength?: number      // /64 by default (4 groups)
  }
  
  // User ID extraction
  userExtraction?: {
    jwtHeader?: string             // default: 'authorization'
    jwtClaim?: string              // default: 'sub'
    apiKeyHeader?: string          // default: 'x-api-key'
    hashIdentifiers?: boolean      // default: true (SHA-256 prefix)
    customExtractor?: (req: Request) => Promise<string | null>
  }
  
  // Observability
  observability?: {
    metrics?: 'cloudwatch' | 'prometheus' | 'statsd' | 'none'
    logLevel?: 'debug' | 'info' | 'warn' | 'error'
    logSampleRate?: number         // 0-1, fraction of allowed requests to log
    namespace?: string             // CloudWatch namespace, default: 'RateLimiter'
  }
}
```

---

## Rule Config Schema

```typescript
interface RuleConfig {
  name: string                     // Unique rule name for logging/metrics
  
  match?: {
    routes?: string[]              // Glob patterns: "POST /api/*", "GET /api/users/:id"
    userTiers?: string[]           // ["free", "pro", "enterprise"]
    ips?: string[]                 // CIDR: ["10.0.0.0/8", "192.168.1.0/24"]
    headers?: Record<string, string>  // Match specific header values
  }
  
  limits: {
    ip?: LimitSpec
    route?: LimitSpec
    user?: LimitSpec
    userRoute?: LimitSpec
  }
  
  cost?: number                    // Request weight, default: 1
  
  failure?: 'open' | 'closed' | 'local'  // Override global failure policy
  
  reservoir?: {
    batchSize?: number             // Override global batch size for this route
  }
}

interface LimitSpec {
  limit: number                    // Max requests
  window: number                   // Window size in seconds
}
```

---

## Environment Variables

All config can be driven from environment variables (useful for Lambda where injecting a config file is awkward):

```bash
# Required
RATE_LIMITER_REDIS_URL=rediss://your-cluster.cache.amazonaws.com:6380
RATE_LIMITER_REDIS_AUTH=your-auth-token

# Optional — override defaults
RATE_LIMITER_DEFAULT_LIMIT=100
RATE_LIMITER_DEFAULT_WINDOW=60
RATE_LIMITER_FAILURE_POLICY=open
RATE_LIMITER_RESERVOIR_BATCH_SIZE=10
RATE_LIMITER_RESERVOIR_SYNC_INTERVAL=5000
RATE_LIMITER_TRUSTED_PROXY_COUNT=1
RATE_LIMITER_LOG_LEVEL=info
RATE_LIMITER_LOG_SAMPLE_RATE=0.01
RATE_LIMITER_METRICS_BACKEND=cloudwatch
RATE_LIMITER_METRICS_NAMESPACE=RateLimiter

# Feature flags
RATE_LIMITER_CIRCUIT_BREAKER_ENABLED=true
RATE_LIMITER_RESERVOIR_ENABLED=true
RATE_LIMITER_HASH_IDENTIFIERS=true
```

---

## Complete Example Config (YAML)

```yaml
# config/rate-limit.production.yaml

redis:
  url: "${RATE_LIMITER_REDIS_URL}"
  password: "${RATE_LIMITER_REDIS_AUTH}"
  connectTimeout: 200
  commandTimeout: 100
  maxRetriesPerRequest: 1

reservoir:
  enabled: true
  batchSize: 10
  syncInterval: 5000

failure:
  default: open
  circuitBreaker:
    enabled: true
    threshold: 5
    recoveryTimeout: 10000

ipExtraction:
  trustXForwardedFor: true
  trustedProxyCount: 1

userExtraction:
  jwtHeader: authorization
  jwtClaim: sub
  apiKeyHeader: x-api-key
  hashIdentifiers: true

observability:
  metrics: cloudwatch
  logLevel: info
  logSampleRate: 0.01
  namespace: RateLimiter

rules:
  # Auth endpoints — most restrictive, fail closed
  - name: auth-strict
    match:
      routes:
        - "POST /auth/login"
        - "POST /auth/register"
        - "POST /auth/reset-password"
    failure: closed
    limits:
      ip:
        limit: 10
        window: 60
      route:
        limit: 100
        window: 60

  # Payment endpoints — fail closed, no user-level limit (handled by business logic)
  - name: payments
    match:
      routes: ["POST /api/payments/*", "POST /api/subscriptions/*"]
    failure: closed
    limits:
      ip:
        limit: 30
        window: 60
      user:
        limit: 20
        window: 60

  # Expensive operations — higher cost
  - name: expensive-ops
    match:
      routes:
        - "POST /api/search"
        - "POST /api/export"
        - "POST /api/batch"
    cost: 10
    limits:
      user:
        limit: 200     # effective 20 real requests (200 / cost=10)
        window: 60
      userRoute:
        limit: 100
        window: 60

  # Free tier
  - name: free-tier
    match:
      userTiers: ["free"]
    limits:
      user:
        limit: 100
        window: 60
      userRoute:
        limit: 20
        window: 60

  # Pro tier
  - name: pro-tier
    match:
      userTiers: ["pro"]
    limits:
      user:
        limit: 1000
        window: 60
      userRoute:
        limit: 200
        window: 60

  # Enterprise tier
  - name: enterprise-tier
    match:
      userTiers: ["enterprise"]
    limits:
      user:
        limit: 50000
        window: 60
      ip:
        limit: 5000
        window: 60

  # Internal service-to-service calls — very permissive
  - name: internal-services
    match:
      ips: ["10.0.0.0/8", "172.16.0.0/12"]
    limits:
      ip:
        limit: 100000
        window: 60

  # Health check endpoints — exempt from user/route limits
  - name: health-checks
    match:
      routes: ["GET /health", "GET /health/*", "GET /ping"]
    limits:
      ip:
        limit: 1000
        window: 60

  # Public unauthenticated endpoints
  - name: public-read
    match:
      routes: ["GET /api/public/*"]
    limits:
      ip:
        limit: 30
        window: 60
      route:
        limit: 1000
        window: 60

  # Default — catch-all
  - name: default
    limits:
      ip:
        limit: 60
        window: 60
      route:
        limit: 500
        window: 60
      user:
        limit: 500
        window: 60
```

---

## Dynamic Config via AWS SSM

For limits that need to change without a redeploy:

```typescript
// config/ssm-loader.ts
import { SSM } from '@aws-sdk/client-ssm'

const ssm = new SSM({ region: process.env.AWS_REGION })

export async function loadDynamicLimits(): Promise<Partial<Record<string, LimitSpec>>> {
  const { Parameters } = await ssm.getParametersByPath({
    Path: `/rate-limiter/${process.env.ENV}/limits/`,
    Recursive: true,
    WithDecryption: false,
  })
  
  return Object.fromEntries(
    (Parameters ?? []).map(p => [
      p.Name?.replace(`/rate-limiter/${process.env.ENV}/limits/`, ''),
      JSON.parse(p.Value ?? '{}'),
    ])
  )
}

// SSM parameter structure:
// /rate-limiter/prod/limits/free-user     = {"limit": 100, "window": 60}
// /rate-limiter/prod/limits/pro-user      = {"limit": 1000, "window": 60}
// /rate-limiter/prod/limits/enterprise-user = {"limit": 50000, "window": 60}
```

Update a limit live:

```bash
aws ssm put-parameter \
  --name "/rate-limiter/prod/limits/free-user" \
  --value '{"limit": 200, "window": 60}' \
  --type String \
  --overwrite
```

The SDK polls SSM every `refreshInterval` (default 60s) and hot-swaps the limit without restart.
