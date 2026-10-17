import type { Payment } from '../domain/payment.aggregate.js';

/**
 * Read model returned by the API.
 *
 * Money crosses the wire as `{ amount, currency }` with the amount in minor
 * units *and* a pre-formatted major-unit string: clients that do arithmetic
 * use the integer, clients that render use the string, and nobody is tempted
 * to parse a float.
 */
export interface MoneyView {
  readonly minor: string;
  readonly major: string;
  readonly currency: string;
}

export interface PaymentView {
  readonly id: string;
  readonly merchantId: string;
  readonly userId: string;
  readonly counterpartyUserId: string | null;
  readonly direction: string;
  readonly status: string;
  readonly amount: MoneyView;
  readonly fee: MoneyView;
  readonly netAmount: MoneyView;
  readonly refundedAmount: MoneyView;
  readonly method: string;
  readonly reference: string;
  readonly providerReference: string | null;
  readonly transferId: string | null;
  readonly failureReason: string | null;
  readonly failureDetail: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly capturedAt: string | null;
  readonly expiresAt: string;
}

export function toMoneyView(money: {
  amount: bigint;
  currencyCode: string;
  toMajorString(): string;
}): MoneyView {
  return {
    minor: money.amount.toString(),
    major: money.toMajorString(),
    currency: money.currencyCode,
  };
}

export function toPaymentView(payment: Payment): PaymentView {
  return {
    id: payment.id,
    merchantId: payment.merchantId,
    userId: payment.userId,
    counterpartyUserId: payment.counterpartyUserId,
    direction: payment.direction,
    status: payment.status,
    amount: toMoneyView(payment.amount),
    fee: toMoneyView(payment.fee),
    netAmount: toMoneyView(payment.netAmount),
    refundedAmount: toMoneyView(payment.refundedAmount),
    method: payment.method,
    reference: payment.reference,
    providerReference: payment.providerReference,
    transferId: payment.transferId,
    failureReason: payment.failureReason,
    failureDetail: payment.failureDetail,
    metadata: payment.metadata,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
    capturedAt: payment.capturedAt?.toISOString() ?? null,
    expiresAt: payment.expiresAt.toISOString(),
  };
}
