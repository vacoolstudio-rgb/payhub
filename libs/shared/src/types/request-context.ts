import type { ClsStore } from 'nestjs-cls';

export interface AuthenticatedPrincipal {
  readonly id: string;
  readonly kind: 'user' | 'merchant' | 'service';
  readonly email?: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly merchantId?: string | undefined;
  /** JWT id — used to revoke a single session. */
  readonly sessionId?: string | undefined;
}

/**
 * Request-scoped state carried through AsyncLocalStorage.
 *
 * This is deliberately *not* a REQUEST-scoped provider: request scope forces
 * Nest to rebuild the whole provider sub-tree per request, which is both slow
 * and surprising (a singleton that injects a request-scoped provider silently
 * becomes request-scoped too). CLS gives the same ergonomics for free.
 */
export interface PayHubClsStore extends ClsStore {
  correlationId: string;
  requestId: string;
  startedAt: number;
  principal?: AuthenticatedPrincipal;
  idempotencyKey?: string;
  /** Set by the transactional decorator so repositories join the active unit of work. */
  transactionId?: string;
}

export const CLS_KEYS = {
  CorrelationId: 'correlationId',
  RequestId: 'requestId',
  Principal: 'principal',
  IdempotencyKey: 'idempotencyKey',
} as const;

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
