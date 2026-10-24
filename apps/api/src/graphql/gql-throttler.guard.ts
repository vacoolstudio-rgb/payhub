import { type ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';

/**
 * Throttling that also works for GraphQL.
 *
 * `ThrottlerGuard` reads `context.switchToHttp().getRequest()`, which is
 * `undefined` inside a resolver — the guard then throws
 * `Cannot read properties of undefined (reading 'ip')` and every GraphQL
 * request fails with a 500. Pulling the underlying request out of the
 * GraphQL context is the documented fix, and it means one rate limit covers
 * both transports rather than leaving `/graphql` unprotected.
 *
 * Tracking stays on the address on purpose. This guard runs *before*
 * authentication — that is the point of it, so an unauthenticated flood
 * never reaches argon2 — which means `req.user` is not set yet and a
 * per-caller tracker here would silently read as a protection that does
 * not exist. Quotas that belong to a caller are enforced after
 * authentication by `PrincipalQuota`.
 */
@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
  protected override getRequestResponse(context: ExecutionContext): {
    req: Record<string, unknown>;
    res: Record<string, unknown>;
  } {
    if (context.getType<'http' | 'graphql'>() === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context).getContext<{
        req: Request;
        res: Response;
      }>();
      return {
        req: gqlContext.req as unknown as Record<string, unknown>,
        res: gqlContext.res as unknown as Record<string, unknown>,
      };
    }

    return super.getRequestResponse(context);
  }

}
