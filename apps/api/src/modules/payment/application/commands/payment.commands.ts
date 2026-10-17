import type { PaymentDirection } from '../../domain/payment.aggregate.js';

/**
 * Commands are plain, serialisable intent objects.
 *
 * Going through a `CommandBus` rather than calling a service directly buys
 * three things here: one place to wrap every write in logging/metrics/retry,
 * handlers that can move to another process without changing the caller, and
 * controllers that depend on a DTO instead of on a service class.
 */
export class CreatePayment {
  constructor(
    readonly input: {
      readonly merchantId: string;
      readonly userId: string;
      readonly counterpartyUserId?: string | null;
      readonly direction: PaymentDirection;
      readonly amountMajor: string;
      readonly currency: string;
      readonly method: string;
      readonly reference?: string;
      readonly metadata?: Record<string, string>;
      readonly idempotencyKey?: string | null;
    },
  ) {}
}

export class RefundPayment {
  constructor(
    readonly input: {
      readonly paymentId: string;
      readonly actorUserId: string;
      readonly amountMajor?: string;
      readonly reason: string;
    },
  ) {}
}

export class CancelPayment {
  constructor(
    readonly input: {
      readonly paymentId: string;
      readonly actorUserId: string;
    },
  ) {}
}

export class ExpireStalePayments {
  constructor(readonly input: { readonly limit: number }) {}
}
