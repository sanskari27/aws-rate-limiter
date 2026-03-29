/**
 * @fileoverview Barrel re-export for all framework adapter modules.
 *
 * Import adapters from this entry point:
 * ```typescript
 * import { createExpressMiddleware, createFastifyHook } from './adapters'
 * ```
 */

export {
  createExpressMiddleware,
  extractIPFromRequest,
  extractUserFromRequest,
  buildRateLimitHeaders,
} from './express';
export type { ExpressAdapterConfig, ExpressMiddleware } from './express';

export {
  createFastifyHook,
  extractIPFromFastifyRequest,
  extractUserFromFastifyRequest,
  parsePathFromUrl,
} from './fastify';
export type { FastifyAdapterConfig, FastifyHookHandler } from './fastify';
