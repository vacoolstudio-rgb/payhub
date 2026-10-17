import { type ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import { ValidationError } from '@payhub/kernel';
import { IDEMPOTENCY_KEY_HEADER } from '../types/request-context.js';

export const IDEMPOTENT_KEY = 'payhub:idempotent';

export interface IdempotentOptions {
  /** How long a completed response stays replayable. */
  ttlSeconds?: number;
  /** Reject the request when the client omits the header. */
  required?: boolean;
}

/**
 * Marks a mutating endpoint as idempotent. The interceptor stores the first
 * response under `(principal, route, key, body-fingerprint)` and replays it
 * for every retry with the same key.
 */
export const Idempotent = (options: IdempotentOptions = {}) =>
  SetMetadata(IDEMPOTENT_KEY, { required: true, ...options } satisfies IdempotentOptions);

export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
  const key = request.headers[IDEMPOTENCY_KEY_HEADER];

  if (!key) {
    throw new ValidationError(
      `Missing ${IDEMPOTENCY_KEY_HEADER} header`,
      { header: IDEMPOTENCY_KEY_HEADER },
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  }

  return key;
});
