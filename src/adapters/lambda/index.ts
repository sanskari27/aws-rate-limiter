/**
 * @fileoverview Barrel re-export for the Lambda adapter module.
 *
 * Exports the Lambda Extension (persistent Redis connection + IPC server) and
 * the `withRateLimit` decorator (wraps a Lambda handler with rate limiting).
 */

export {
  LambdaExtension,
  type ExtensionConfig,
  type ExtensionRegistration,
  type LambdaEvent,
} from './extension';

export {
  withRateLimit,
  extractContext,
  buildRateLimitHeaders,
  type DecoratorConfig,
  type APIGatewayProxyEventV2,
  type APIGatewayProxyResultV2,
  type Context,
} from './decorator';
