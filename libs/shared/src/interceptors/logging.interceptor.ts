import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Handler-level timing. The HTTP access log lives in pino-http; this adds the
 * controller/method pair so a slow *handler* is distinguishable from a slow
 * client or a slow middleware chain.
 */
@Injectable()
export class HandlerLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Handler');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const label = `${context.getClass().name}.${context.getHandler().name}`;
    const startedAt = process.hrtime.bigint();
    const elapsedMs = (): string => (Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1);

    return next.handle().pipe(
      tap({
        complete: () => this.logger.debug(`${label} ok in ${elapsedMs()}ms`),
        error: (error: unknown) =>
          this.logger.debug(
            `${label} failed in ${elapsedMs()}ms: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
      }),
    );
  }
}
