import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { MetricsService } from './metrics.service.js';

/**
 * Records request duration against the **route template**, never the raw URL.
 *
 * `/payments/:id` keeps the cardinality of the metric at the number of routes;
 * using `req.url` would create one time series per payment id and take the
 * Prometheus server down with it.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const stopTimer = this.metrics.httpDuration.startTimer();

    const observe = (statusOverride?: number): void => {
      stopTimer({
        method: request.method,
        route: request.route?.path ?? 'unknown',
        status: String(statusOverride ?? response.statusCode),
      });
    };

    return next.handle().pipe(
      tap({
        complete: () => observe(),
        error: (error: unknown) =>
          observe(
            typeof error === 'object' && error !== null && 'status' in error
              ? Number((error as { status: unknown }).status)
              : 500,
          ),
      }),
    );
  }
}
