import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, TimeoutError, throwError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import { type AppConfig, appConfig } from '@payhub/config';
import { DependencyFailureError } from '@payhub/kernel';
import { REQUEST_TIMEOUT_KEY } from '../decorators/timeout.decorator.js';

/**
 * Caps how long a handler may run. Without it a slow downstream call pins a
 * connection, the pool drains and the whole service stops responding — the
 * classic cascading failure.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(
    @Inject(appConfig.KEY) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const override = this.reflector.getAllAndOverride<number | undefined>(REQUEST_TIMEOUT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const budgetMs = override ?? this.config.requestTimeoutMs;

    // 0 disables the timeout: streaming endpoints (SSE) opt out explicitly.
    if (budgetMs <= 0) {
      return next.handle();
    }

    return next.handle().pipe(
      timeout({ each: budgetMs }),
      catchError((error: unknown) =>
        error instanceof TimeoutError
          ? throwError(
              () =>
                new DependencyFailureError(
                  'handler',
                  `Request exceeded its ${budgetMs}ms budget`,
                  { retryable: true },
                ),
            )
          : throwError(() => error),
      ),
    );
  }
}
