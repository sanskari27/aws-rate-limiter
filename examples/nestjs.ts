/**
 * NestJS example — wraps the built-in Express adapter as NestJS middleware + guard.
 *
 * Shows two patterns:
 *   1. Global middleware using `createExpressMiddleware` (simplest)
 *   2. Custom NestJS Guard for fine-grained control (per-route decorators)
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register examples/nestjs.ts
 *
 * Test:
 *   curl -i http://localhost:3000/api/users
 */

import {
  Module,
  Controller,
  Get,
  Post,
  Body,
  Param,
  NestMiddleware,
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import { RateLimiter, RateLimitContext, RateLimitResult } from 'aws-rate-limiter';
import { createExpressMiddleware } from 'aws-rate-limiter/adapters/express';

// ============================================================================
// Rate Limiter Provider
// ============================================================================

@Injectable()
class RateLimiterService implements OnModuleInit, OnModuleDestroy {
  public limiter: RateLimiter;

  constructor() {
    this.limiter = new RateLimiter({
      redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
      rules: [
        {
          name: 'auth',
          match: { routes: ['POST /auth/*', 'POST /login'] },
          limits: { ip: { limit: 10, window: 60 } },
          failure: 'closed',
        },
        {
          name: 'default',
          limits: {
            ip: { limit: 100, window: 60 },
            route: { limit: 1000, window: 60 },
            user: { limit: 200, window: 60 },
          },
        },
      ],
      failure: { default: 'open' },
    });
  }

  async onModuleInit() {
    await this.limiter.connect();
  }

  async onModuleDestroy() {
    await this.limiter.shutdown();
  }
}

// ============================================================================
// Pattern 1: Global NestJS Middleware (wraps Express adapter)
// ============================================================================

@Injectable()
class RateLimitMiddleware implements NestMiddleware {
  private middleware: ReturnType<typeof createExpressMiddleware>;

  constructor(private readonly rateLimiterService: RateLimiterService) {
    this.middleware = createExpressMiddleware({
      rateLimiter: this.rateLimiterService.limiter,
      skipRoutes: ['/health'],
      setHeaders: true,
    });
  }

  async use(req: Request, res: Response, next: NextFunction) {
    await this.middleware(req as any, res as any, next);
  }
}

// ============================================================================
// Pattern 2: NestJS Guard (for per-route control)
// ============================================================================

@Injectable()
class RateLimitGuard implements CanActivate {
  constructor(private readonly rateLimiterService: RateLimiterService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const ip = req.ip || req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || '0.0.0.0';
    const apiKey = req.headers['x-api-key'] as string | undefined;

    const ctx: RateLimitContext = {
      ip,
      apiKey,
      route: req.path,
      method: req.method,
    };

    let result: RateLimitResult;
    try {
      result = await this.rateLimiterService.limiter.check(ctx);
    } catch {
      return true;
    }

    const windowSecs = result.windowSecs ?? 60;
    res.set('X-RateLimit-Limit', String(result.limit));
    res.set('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
    res.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    res.set('X-RateLimit-Policy', `${result.limit};w=${windowSecs}`);

    if (!result.allowed) {
      if (result.retryAfter !== undefined) {
        res.set('Retry-After', String(Math.ceil(result.retryAfter / 1000)));
      }
      throw new HttpException(
        { error: 'Too Many Requests', retryAfter: result.retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}

// ============================================================================
// Controllers
// ============================================================================

@Controller()
class HealthController {
  constructor(private readonly rateLimiterService: RateLimiterService) {}

  @Get('/health')
  getHealth() {
    return { status: 'ok', rateLimiterConnected: this.rateLimiterService.limiter.isConnected() };
  }
}

@Controller('/api')
class UsersController {
  @Get('/users')
  getUsers() {
    return { users: [{ id: 1, name: 'Alice' }] };
  }

  @Get('/users/:id')
  getUser(@Param('id') id: string) {
    return { id, name: 'Alice' };
  }

  @Post('/users')
  createUser(@Body() body: unknown) {
    return { created: body };
  }
}

// ============================================================================
// Module
// ============================================================================

@Module({
  controllers: [HealthController, UsersController],
  providers: [RateLimiterService, RateLimitMiddleware, RateLimitGuard],
})
class AppModule {
  configure(consumer: any) {
    // Apply rate limiting middleware to all routes
    consumer.apply(RateLimitMiddleware).forRoutes('*');
  }
}

// ============================================================================
// Bootstrap
// ============================================================================

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  console.log(`NestJS server listening on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
