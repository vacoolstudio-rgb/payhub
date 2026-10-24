import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { RateLimitedError } from '@payhub/kernel';
import {
  PRINCIPAL_QUOTA_METADATA,
  type PrincipalQuotaOptions,
} from './principal-quota.decorator.js';
import { TokenBucketService } from './token-bucket.service.js';

interface RequestWithPrincipal {
  user?: { id: string };
  ip?: string;
}

/**
 * Spends a caller's quota before the handler runs.
 *
 * An interceptor rather than a guard, and that is the substance of it
 * rather than a style choice: guards run in registration order across
 * modules, and the global throttler is deliberately registered to run
 * *before* authentication so an unauthenticated flood never reaches
 * argon2. A second guard wanting `req.user` would depend on landing
 * after the auth guard — an ordering nothing in the type system
 * enforces, which breaks silently when a module import moves.
 *
 * Interceptors run after every guard, so the principal is simply there.
 *
 * A token bucket, not a fixed window: a merchant settling a batch should
 * be able to burst and then go quiet, rather than be refused for the
 * shape of their traffic.
 */
@Injectable()
export class PrincipalQuotaInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly buckets: TokenBucketService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const options = this.reflector.get<PrincipalQuotaOptions | undefined>(
      PRINCIPAL_QUOTA_METADATA,
      context.getHandler(),
    );

    if (!options) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal | undefined>();
    const principalId = request?.user?.id;

    // No principal means the global per-address throttle is the only
    // control that applies, which is the right one for anonymous calls.
    if (!principalId) {
      return next.handle();
    }

    const bucket = `quota:${options.name ?? context.getHandler().name}:${principalId}`;
    const result = await this.buckets.consume(bucket, {
      capacity: options.capacity,
      refillPerSecond: options.refillPerSecond,
    });

    if (!result.allowed) {
      throw new RateLimitedError(
        'You are sending requests faster than this endpoint allows',
        result.retryAfterMs,
      );
    }

    return next.handle();
  }
}
