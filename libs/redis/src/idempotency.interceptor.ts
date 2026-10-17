import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, from, of, throwError } from 'rxjs';
import { catchError, concatMap, switchMap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { ConflictError, ValidationError } from '@payhub/kernel';
import {
  type AuthenticatedPrincipal,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_KEY,
  type IdempotentOptions,
  fingerprint,
} from '@payhub/shared';
import { IdempotencyService } from './idempotency.service.js';

/**
 * Wraps any handler marked with `@Idempotent()`.
 *
 * Placing this in an interceptor rather than in each service keeps the
 * business code free of retry plumbing, and guarantees the whole response —
 * status code included — is what gets replayed.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(
      IDEMPOTENT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!options || context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const rawKey = request.header(IDEMPOTENCY_KEY_HEADER);

    if (!rawKey) {
      if (options.required === false) {
        return next.handle();
      }
      return throwError(
        () =>
          new ValidationError(
            `Missing ${IDEMPOTENCY_KEY_HEADER} header`,
            { header: IDEMPOTENCY_KEY_HEADER },
            'IDEMPOTENCY_KEY_REQUIRED',
          ),
      );
    }

    const principal = (request as Request & { user?: AuthenticatedPrincipal }).user;
    const storageKey = this.idempotency.buildKey({
      principalId: principal?.id ?? `anon:${request.ip ?? 'unknown'}`,
      route: `${request.method} ${request.route?.path ?? request.path}`,
      key: rawKey,
    });
    const bodyFingerprint = fingerprint(request.body ?? {});

    return from(this.idempotency.begin(storageKey, bodyFingerprint)).pipe(
      switchMap((state) => {
        if (state.status === 'completed') {
          response.status(state.statusCode);
          response.setHeader('idempotent-replay', 'true');
          return of(state.body);
        }

        if (state.status === 'in_progress') {
          return throwError(
            () =>
              new ConflictError(
                'A request with this idempotency key is still being processed',
                'IDEMPOTENCY_KEY_IN_PROGRESS',
                { key: rawKey },
              ),
          );
        }

        return next.handle().pipe(
          // `concatMap`, not `tap`: the stored record must be durable
          // *before* the client sees the response. With a fire-and-forget
          // write, a client that retries immediately races the write and
          // gets a spurious 409 "still in progress" — and a crash in that
          // window leaves the key locked until its TTL expires.
          concatMap(async (body) => {
            await this.idempotency.complete(storageKey, {
              fingerprint: bodyFingerprint,
              statusCode: response.statusCode,
              body,
            });
            return body;
          }),
          catchError((error: unknown) =>
            // Do not memoise failures: the client must be able to retry.
            from(this.idempotency.abandon(storageKey)).pipe(
              switchMap(() => throwError(() => error)),
            ),
          ),
        );
      }),
    );
  }
}
