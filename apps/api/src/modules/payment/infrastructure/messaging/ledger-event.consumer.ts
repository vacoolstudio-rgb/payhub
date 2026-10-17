import { Injectable } from '@nestjs/common';
import {
  type PayloadOf,
  TransferPosted,
  TransferRejected,
  WalletBalanceChanged,
} from '@payhub/contracts';
import { KafkaHandler } from '@payhub/messaging';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentSaga } from '../../application/sagas/payment.saga.js';
import { WALLET_UPDATED_EVENT, type WalletUpdatedEvent } from '../../application/payment.events.js';

/**
 * Inbound adapter for the ledger's facts.
 *
 * The consumer framework has already validated the payload against the
 * contract schema and claimed the inbox row, so these methods are pure
 * translation into the saga's vocabulary.
 */
@Injectable()
export class LedgerEventConsumer {
  constructor(
    private readonly saga: PaymentSaga,
    private readonly events: EventEmitter2,
  ) {}

  @KafkaHandler(TransferPosted)
  async onTransferPosted(payload: PayloadOf<typeof TransferPosted>): Promise<void> {
    await this.saga.onTransferPosted({
      transferId: payload.transferId,
      paymentId: payload.paymentId,
      userId: payload.userId,
      purpose: payload.purpose,
      postedAt: payload.postedAt,
      lines: payload.lines,
    });
  }

  @KafkaHandler(TransferRejected)
  async onTransferRejected(payload: PayloadOf<typeof TransferRejected>): Promise<void> {
    await this.saga.onTransferRejected({
      transferId: payload.transferId,
      paymentId: payload.paymentId,
      reason: payload.reason,
      detail: payload.detail,
    });
  }

  /**
   * Balance pushes are fire-and-forget UI updates, so deduplication is
   * skipped: replaying the same balance is harmless, and taking a database
   * transaction for a WebSocket emit would be absurd.
   */
  @KafkaHandler(WalletBalanceChanged, { skipDeduplication: true })
  onWalletBalanceChanged(payload: PayloadOf<typeof WalletBalanceChanged>): void {
    this.events.emit(WALLET_UPDATED_EVENT, {
      userId: payload.userId,
      walletId: payload.walletId,
      available: { minor: payload.available.amount, currency: payload.available.currency },
      pending: { minor: payload.pending.amount, currency: payload.pending.currency },
    } satisfies WalletUpdatedEvent);
  }
}
