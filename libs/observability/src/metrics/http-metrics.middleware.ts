import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service.js';

/**
 * Records every HTTP request, with the status that was actually sent.
 *
 * This was an interceptor, which gets both halves of that sentence
 * wrong.
 *
 * It could not see the status. On the error path it read a `status`
 * property off the thrown value — present on an `HttpException`,
 * absent on a `DomainError`, whose status is decided later by the
 * problem-details mapper — so every domain error was recorded as 500.
 * Measured: a request for a missing payment answered 404 and
 * incremented the 500 series, which points the error-rate panel at
 * ordinary not-founds and pages somebody for them.
 *
 * It could not see the request at all when a guard rejected it.
 * Guards run before interceptors, so an unauthenticated call produced
 * no series whatsoever — a credential-stuffing run would have been
 * invisible on the very dashboard meant to show it.
 *
 * Middleware runs before guards and `finish` fires after the exception
 * filter has written the response, so between them they see every
 * request and the real status. The route template is read at finish
 * time, once Express has matched it: reading it on the way in would
 * give `undefined`, since routing has not happened yet.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const stopTimer = this.metrics.httpDuration.startTimer();

    response.once('finish', () => {
      stopTimer({
        method: request.method,
        // The template, never the raw URL: `/payments/:paymentId` keeps
        // this at one series per route instead of one per payment.
        route: request.route?.path ?? routeOf(request),
        status: String(response.statusCode),
      });
    });

    next();
  }
}

/**
 * A label for a request that matched no route.
 *
 * Not the path — that is attacker-controlled, and one series per
 * probed URL is how a scanner turns a metrics endpoint into an outage.
 */
function routeOf(request: Request): string {
  return request.originalUrl?.startsWith('/metrics') ? '/metrics' : 'unmatched';
}
