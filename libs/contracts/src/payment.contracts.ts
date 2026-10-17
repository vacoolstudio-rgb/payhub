import { z } from 'zod';
import { defineEvent, moneySchema } from './envelope.js';
import { Topics } from './topics.js';

export const PaymentDirection = z.enum(['deposit', 'withdrawal', 'transfer']);
export type PaymentDirection = z.infer<typeof PaymentDirection>;

export const PaymentFailureReason = z.enum([
  'insufficient_funds',
  'wallet_frozen',
  'wallet_not_found',
  'currency_mismatch',
  'provider_declined',
  'provider_unavailable',
  'limit_exceeded',
  'expired',
  'cancelled_by_user',
  'internal_error',
]);
export type PaymentFailureReason = z.infer<typeof PaymentFailureReason>;

const basePayment = {
  paymentId: z.string().uuid(),
  merchantId: z.string().uuid(),
  userId: z.string().uuid(),
  direction: PaymentDirection,
  amount: moneySchema,
  fee: moneySchema,
  reference: z.string().min(1),
};

export const PaymentInitiated = defineEvent(
  'payment.initiated.v1',
  Topics.PaymentEvents,
  z.object({
    ...basePayment,
    sourceWalletId: z.string().uuid().nullable(),
    destinationWalletId: z.string().uuid().nullable(),
    method: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
  }),
);

export const PaymentAuthorized = defineEvent(
  'payment.authorized.v1',
  Topics.PaymentEvents,
  z.object({
    ...basePayment,
    providerReference: z.string().min(1),
    authorizedAt: z.string().datetime({ offset: true }),
  }),
);

export const PaymentCaptured = defineEvent(
  'payment.captured.v1',
  Topics.PaymentEvents,
  z.object({
    ...basePayment,
    transferId: z.string().uuid(),
    capturedAt: z.string().datetime({ offset: true }),
  }),
);

export const PaymentFailed = defineEvent(
  'payment.failed.v1',
  Topics.PaymentEvents,
  z.object({
    ...basePayment,
    reason: PaymentFailureReason,
    detail: z.string().nullable().default(null),
    failedAt: z.string().datetime({ offset: true }),
  }),
);

export const PaymentRefunded = defineEvent(
  'payment.refunded.v1',
  Topics.PaymentEvents,
  z.object({
    ...basePayment,
    refundId: z.string().uuid(),
    refundedAmount: moneySchema,
    refundedAt: z.string().datetime({ offset: true }),
  }),
);

export const PaymentEvents = {
  [PaymentInitiated.name]: PaymentInitiated,
  [PaymentAuthorized.name]: PaymentAuthorized,
  [PaymentCaptured.name]: PaymentCaptured,
  [PaymentFailed.name]: PaymentFailed,
  [PaymentRefunded.name]: PaymentRefunded,
} as const;

export type PaymentEventName = keyof typeof PaymentEvents;
