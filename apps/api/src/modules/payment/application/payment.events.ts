import type { PaymentView } from './payment.view.js';

/**
 * In-process notification used to drive the WebSocket push.
 *
 * Deliberately *not* an integration event: it carries a rendered view model,
 * it is not durable, and replaying it would mean replaying a UI update. The
 * durable, cross-service story stays in the outbox.
 */
export const PAYMENT_UPDATED_EVENT = 'payment.updated';

export interface PaymentUpdatedEvent {
  readonly userId: string;
  readonly merchantId: string;
  readonly payment: PaymentView;
}

export const WALLET_UPDATED_EVENT = 'wallet.updated';

export interface WalletUpdatedEvent {
  readonly userId: string;
  readonly walletId: string;
  readonly available: { minor: string; currency: string };
  readonly pending: { minor: string; currency: string };
}
