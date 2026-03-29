/**
 * AWS Lambda example — uses the built-in Lambda Extension + `withRateLimit` decorator.
 *
 * Architecture:
 *   1. LambdaExtension runs as a Lambda Extension process, maintaining a persistent
 *      Redis connection across invocations (eliminates cold-start Redis overhead).
 *   2. `withRateLimit` wraps your handler function and communicates with the extension
 *      via localhost IPC. If the extension is unreachable, it fails open.
 *
 * Deployment:
 *   - The extension entry point (extension.ts) is packaged as a Lambda layer.
 *   - The handler (handler.ts) is your normal Lambda function code.
 */

// ============================================================================
// File 1: extension.ts — Lambda Extension entry point (runs as a layer)
// ============================================================================

import { LambdaExtension } from 'aws-rate-limiter/adapters/lambda';

const extension = new LambdaExtension({
  rateLimiterConfig: {
    redis: {
      url: process.env.REDIS_URL || 'redis://your-elasticache-endpoint:6379',
      password: process.env.REDIS_PASSWORD,
      connectTimeout: 500,
      commandTimeout: 200,
    },
    rules: [
      {
        name: 'api-default',
        limits: {
          ip: { limit: 100, window: 60 },
          user: { limit: 200, window: 60 },
          userRoute: { limit: 50, window: 60 },
        },
      },
    ],
    failure: {
      default: 'open',
      circuitBreaker: { enabled: true, threshold: 5, recoveryTimeout: 30000 },
    },
  },
  port: 2772,
});

// Blocks until Lambda sends a SHUTDOWN event
extension.run().catch((err) => {
  console.error('Extension failed:', err);
  process.exit(1);
});

// ============================================================================
// File 2: handler.ts — Your Lambda function handler
// ============================================================================

import { withRateLimit } from 'aws-rate-limiter/adapters/lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-rate-limiter/adapters/lambda';

// Wrap your handler with rate limiting — all checks go to the extension via IPC
export const handler = withRateLimit(
  async (event: APIGatewayProxyEventV2, _context: Context): Promise<APIGatewayProxyResultV2> => {
    const path = event.requestContext.http.path;
    const method = event.requestContext.http.method;

    if (method === 'GET' && path === '/api/users') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users: [{ id: 1, name: 'Alice' }] }),
      };
    }

    return {
      statusCode: 404,
      body: JSON.stringify({ error: 'Not Found' }),
    };
  },
  {
    extensionUrl: 'http://localhost:2772',
    userIdHeader: 'x-user-id',
    apiKeyHeader: 'x-api-key',
    trustedProxyCount: 1,
  },
);

// ============================================================================
// Extracting context manually (advanced usage)
// ============================================================================

import { extractContext } from 'aws-rate-limiter/adapters/lambda';

/**
 * If you need to inspect the rate limit context before or after the check,
 * you can extract it manually from the event:
 */
export const advancedHandler = async (
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyResultV2> => {
  const rateLimitCtx = extractContext(event, {
    ipHeaders: ['cf-connecting-ip', 'true-client-ip'],
    trustedProxyCount: 2,
    userIdHeader: 'x-user-id',
    apiKeyHeader: 'x-api-key',
  });

  console.log('Rate limit context:', rateLimitCtx);

  return {
    statusCode: 200,
    body: JSON.stringify({ ip: rateLimitCtx.ip, route: rateLimitCtx.route }),
  };
};
