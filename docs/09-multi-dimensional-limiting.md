# 09 — Multi-Dimensional Rate Limiting

## Overview

A single request is checked against up to 4 dimensions simultaneously. Each dimension limits a different aspect of traffic:

| Dimension | Protects Against | Key |
|---|---|---|
| Per-IP | Scanners, botnets, credential stuffing | `rl:v1:ip:{ip}:{bucket}` |
| Per-route | Endpoint overload, DDoS on specific paths | `rl:v1:route:{route}:{bucket}` |
| Per-user | Heavy users consuming disproportionate resources | `rl:v1:user:{user}:{bucket}` |
| Per-user + route | Precise per-endpoint per-user quota enforcement | `rl:v1:user-route:{user}:{route}:{bucket}` |

---

## Check Order — Fail Fast Strategy

Dimensions are checked cheapest-first (broadest scope first). The moment any dimension denies, the request is rejected and remaining checks are skipped.

```
1. IP check      ← cheapest: 2 Redis GET ops, catches entire botnets
2. Route check   ← catches global endpoint overload
3. User check    ← catches individual heavy hitters
4. User+Route    ← most specific: per-endpoint per-user quota
```

At 1M req/s, a botnet hitting from the same IP subnet is caught at step 1 with ~0 overhead to steps 2–4. A legitimate user exceeding their API quota is caught at step 3, saving the step-4 composite check.

---

## Per-IP Limiting

### Purpose

Blunt-instrument protection against:
- Port scanners
- Credential stuffing bots
- DDoS from small botnets
- Accidental hammering from a misconfigured client

### IP Extraction

Never trust `X-Forwarded-For` directly — it can be spoofed. Configure trusted proxy depth:

```typescript
function extractIP(headers: Record<string, string>, config: IPConfig): string {
  if (!config.trustXForwardedFor) {
    return headers['x-real-ip'] || '0.0.0.0'
  }
  
  // X-Forwarded-For: client, proxy1, proxy2
  // With trustedProxyCount=1, take the second-to-last entry (proxy1 added it)
  const forwardedFor = headers['x-forwarded-for']?.split(',').map(s => s.trim()) ?? []
  const trusted      = config.trustedProxyCount ?? 1
  const clientIndex  = forwardedFor.length - trusted - 1
  
  return forwardedFor[Math.max(0, clientIndex)] || '0.0.0.0'
}
```

### IPv6 Handling

IPv6 addresses are long and can be rotated cheaply. Consider limiting at /64 prefix level (common residential IPv6 assignment):

```typescript
function normalizeIP(ip: string): string {
  if (ip.includes(':')) {
    // IPv6: limit to /64 prefix (first 4 groups)
    const groups = ip.split(':')
    return groups.slice(0, 4).join(':') + '::0'
  }
  // IPv4: use full address
  return ip
}
```

### Recommended Limits

| Context | Limit | Window |
|---|---|---|
| Unauthenticated endpoints | 30 req | 60s |
| Auth endpoints (login, register) | 10 req | 60s |
| Authenticated endpoints | 100 req | 60s |
| Health check / status | 300 req | 60s |

---

## Per-Route Limiting

### Purpose

Protect individual endpoints from overload regardless of who is calling:
- Prevents one viral post from taking down your `/api/posts/:id` endpoint
- Limits aggregate load on expensive operations (search, export)
- Allows you to set different global throughputs per endpoint

### Route Normalization

Strip dynamic segments so `/api/users/123` and `/api/users/456` count against the same route limit:

```typescript
function normalizeRoute(method: string, path: string): string {
  const stripped = path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/PARAM')  // UUID
    .replace(/\/\d{10,}/g, '/PARAM')   // Unix timestamps
    .replace(/\/\d+/g, '/PARAM')       // Numeric IDs
    .replace(/\?.*/, '')               // Strip query string
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, '_')    // Safe chars only
  
  return `${method.toUpperCase()}_${stripped}`
}

// Examples:
normalizeRoute('GET',  '/api/users/123')                        // → GET_/api/users/PARAM
normalizeRoute('GET',  '/api/users/abc-def-123-456-789abc')     // → GET_/api/users/PARAM
normalizeRoute('POST', '/api/orders?ref=email&campaign=spring') // → POST_/api/orders
```

### Recommended Limits

| Route Type | Limit | Window |
|---|---|---|
| Read (GET) | 1000 req | 60s |
| Write (POST/PUT/PATCH) | 200 req | 60s |
| Delete | 100 req | 60s |
| Search / aggregation | 50 req | 60s |
| Export / batch | 10 req | 60s |
| Auth (POST /auth/*) | 100 req | 60s |

---

## Per-User Limiting

### Purpose

Enforce fair use across your user base:
- Free tier users are capped at a lower limit than paid tiers
- Prevents a single customer from consuming your entire API capacity
- Enables SLA differentiation by tier

### User Identifier Extraction

Support multiple auth methods:

```typescript
interface UserExtractionConfig {
  jwtHeader?: string      // 'authorization' → extract sub claim
  apiKeyHeader?: string   // 'x-api-key'
  apiKeyQueryParam?: string  // '?api_key='
  customExtractor?: (req: Request) => string | null
}

async function extractUserId(req: Request, config: UserExtractionConfig): Promise<string | null> {
  // 1. Try JWT
  if (config.jwtHeader) {
    const token = req.headers[config.jwtHeader]?.replace('Bearer ', '')
    if (token) {
      const payload = await verifyJWT(token)  // Cached — don't re-verify per request
      return payload?.sub ?? null
    }
  }
  
  // 2. Try API key
  const apiKey = req.headers[config.apiKeyHeader ?? 'x-api-key']
    ?? req.query[config.apiKeyQueryParam ?? '']
  if (apiKey) {
    return sha256(apiKey).slice(0, 16)  // Hash it — never store raw key in Redis key name
  }
  
  // 3. Custom extractor
  if (config.customExtractor) {
    return config.customExtractor(req)
  }
  
  return null  // Unauthenticated — only IP and route limits apply
}
```

### Tiered Limits

```typescript
interface TierConfig {
  name: string
  limits: {
    user: { limit: number; window: number }
    userRoute?: { limit: number; window: number }
  }
}

const TIERS: TierConfig[] = [
  {
    name: 'free',
    limits: {
      user:      { limit: 100,   window: 60 },
      userRoute: { limit: 20,    window: 60 },
    },
  },
  {
    name: 'pro',
    limits: {
      user:      { limit: 1000,  window: 60 },
      userRoute: { limit: 200,   window: 60 },
    },
  },
  {
    name: 'enterprise',
    limits: {
      user:      { limit: 50000, window: 60 },
      // No userRoute limit for enterprise — they get uncapped per-endpoint access
    },
  },
]

// Fetch user's tier from JWT claim, database, or cache
async function getUserTier(userId: string): Promise<string> {
  // Cache this — don't hit the database on every request
  return tierCache.getOrFetch(userId, () => db.getUserTier(userId))
}
```

---

## Per-User + Route Limiting (Composite)

### Purpose

The most precise limiting dimension. Allows you to say "user `abc` can call `POST /api/search` 20 times per minute" without affecting their budget for other endpoints.

Use cases:
- Different endpoints have very different resource costs
- You want to allow high-volume reads but restrict expensive writes per user
- Enterprise customers with overall high limits still have per-endpoint caps

### Composite Key Construction

```typescript
function buildCompositeKey(userId: string, route: string, bucket: number): [string, string] {
  const identifier = `${hash(userId)}:${route}`
  return [
    `rl:v1:{user-route:${identifier}}:${bucket}`,      // curr
    `rl:v1:{user-route:${identifier}}:${bucket - 1}`,  // prev
  ]
}
```

### When to Skip the Composite Check

The composite check adds 2 Redis GETs per request. Skip it if:
- The user has no per-route overrides configured (check against rule config)
- The user is on enterprise tier (enterprise routes often have no composite limit)
- The route is a cheap read with permissive limits

```typescript
function shouldCheckComposite(ctx: RateLimitContext, rules: RuleConfig[]): boolean {
  const matchedRule = findMatchingRule(ctx, rules)
  return matchedRule?.limits?.userRoute !== undefined
}
```

---

## Dynamic Limit Adjustments

For use cases where limits need to change without a redeploy (e.g., during an incident, or for dynamic tier upgrades):

```typescript
interface DynamicConfig {
  source: 'env' | 'ssm' | 'dynamodb' | 'static'
  refreshInterval?: number  // ms, default 60000
}

class ConfigCache {
  private config: RuleConfig[] = []
  private lastRefresh = 0
  
  async get(): Promise<RuleConfig[]> {
    if (Date.now() - this.lastRefresh > this.refreshInterval) {
      this.config = await this.fetchFromSource()
      this.lastRefresh = Date.now()
    }
    return this.config
  }
}
```

Store limits in AWS SSM Parameter Store or DynamoDB for runtime adjustment:

```bash
# Change enterprise limit on the fly
aws ssm put-parameter \
  --name "/rate-limiter/prod/enterprise/user-limit" \
  --value "100000" \
  --overwrite
```
