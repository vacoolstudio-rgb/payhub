import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import type { NextFunction, Request, Response } from 'express';
import {
  CORRELATION_ID_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  type PayHubClsStore,
  REQUEST_ID_HEADER,
} from '../types/request-context.js';

/**
 * Seeds the async-local request context.
 *
 * `correlationId` is accepted from the caller when present (so a trace spans
 * the whole call graph) while `requestId` is always minted locally — a client
 * must not be able to make two different requests share an id.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  constructor(private readonly cls: ClsService<PayHubClsStore>) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[CORRELATION_ID_HEADER];
    const correlationId =
      (Array.isArray(incoming) ? incoming[0] : incoming)?.slice(0, 128) || randomUUID();
    const requestId = randomUUID();

    // Guarded: GraphQL and other non-router entry points can reach this
    // middleware before `ClsMiddleware` has opened a context, and writing
    // to an inactive CLS store throws. The response headers below are set
    // either way, because they are what a caller correlates on.
    if (this.cls.isActive()) {
      this.cls.set('correlationId', correlationId);
      this.cls.set('requestId', requestId);
      this.cls.set('startedAt', Date.now());

      const idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER];
      if (typeof idempotencyKey === 'string') {
        this.cls.set('idempotencyKey', idempotencyKey);
      }
    }

    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    next();
  }
}
