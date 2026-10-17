import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Money, NotFoundError } from '@payhub/kernel';
import { Transactional } from '@payhub/persistence';
import { OutboxPublisher } from '@payhub/messaging';
import { MetricsService } from '@payhub/observability';
import type { ZodType } from 'zod';
import {
  type EventDefinition,
  type LedgerPostingLine,
  type LedgerRejectionReason,
  PaymentCaptured as PaymentCapturedContract,
  PaymentFailed as PaymentFailedContract,
  PaymentRefunded as PaymentRefundedContract,
} from '@payhub/contracts';
import {
  type Payment,
  PaymentId,
  PaymentStatus,
  type PaymentFailureReason,
} from '../../domain/payment.aggregate.js';
import { PAYMENT_REPOSITORY, type PaymentRepository } from '../../domain/payment.repository.js';
import { PAYMENT_UPDATED_EVENT, type PaymentUpdatedEvent } from '../payment.events.js';
import { toPaymentView } from '../payment.view.js';

export interface TransferPostedInput {
  readonly transferId: string;
  readonly paymentId: string;
  readonly userId: string;
  readonly purpose: string;
  readonly postedAt: string;
  /** The journal lines, so the saga can read the amount that actually moved. */
  readonly lines: readonly LedgerPostingLine[];
}

export interface TransferRejectedInput {
  readonly transferId: string;
  readonly paymentId: string;
  readonly reason: LedgerRejectionReason;
  readonly detail: string | null;
}

/**
 * Process manager for the payment saga.
 *
 * The saga has exactly two inbound facts from the ledger — posted or
 * rejected — and drives the payment to a terminal state for each. It is an
 * *orchestrated* saga rather than a choreographed one: one place holds the
 * state machine, so "why is this payment stuck?" is answerable by reading a
 * single class instead of tracing events across four services.
 *
 * Compensation: there is nothing to undo on rejection, because the ledger
 * never applied anything — the transaction that rejected is the same one
 * that emitted the rejection. For a failure *after* a successful posting
 * (an expired payment, say) the compensating action is a reversal command,
 * issued by `ExpirePaymentsHandler`.
 */
@Injectable()
export class PaymentSaga {
  private readonly logger = new Logger(PaymentSaga.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    private readonly outbox: OutboxPublisher,
    private readonly metrics: MetricsService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Joins the transaction opened by the Kafka consumer, so the payment
   * update and the inbox row commit together. A crash anywhere in here
   * simply redelivers the message.
   */
  @Transactional({ propagation: 'REQUIRED' })
  async onTransferPosted(input: TransferPostedInput): Promise<void> {
    const payment = await this.payments.findByIdForUpdate(PaymentId.of(input.paymentId));

    if (!payment) {
      // The ledger knows about a payment we do not. Loud, but not retryable:
      // redelivering will not make the row appear.
      this.logger.error(`Ledger posted transfer ${input.transferId} for unknown payment ${input.paymentId}`);
      throw new NotFoundError('Payment', input.paymentId);
    }

    if (input.purpose === 'refund' || input.purpose === 'reversal') {
      await this.completeRefund(payment, input);
      return;
    }

    const captured = payment.completeCapture(input.transferId);

    if (captured.isErr()) {
      // An unexpected transition means the saga and the ledger disagree —
      // the reconciliation job is the backstop, so log and move on rather
      // than blocking the partition.
      this.logger.error(
        `Cannot capture payment ${payment.id} in state ${payment.status}: ${captured.error.message}`,
      );
      return;
    }

    if (captured.value === 'already-captured') {
      // A redelivery. Re-publishing would hand the merchant a second
      // webhook for one payment, which is worse than doing nothing.
      this.logger.debug(`Payment ${payment.id} was already captured — ignoring replay`);
      return;
    }

    await this.payments.save(payment);

    await this.outbox.publish(
      PaymentCapturedContract,
      {
        paymentId: payment.id,
        merchantId: payment.merchantId,
        userId: payment.userId,
        direction: payment.direction,
        amount: payment.amount.toJSON(),
        fee: payment.fee.toJSON(),
        reference: payment.reference,
        transferId: input.transferId,
        capturedAt: (payment.capturedAt ?? new Date()).toISOString(),
      },
      { aggregateType: 'Payment', aggregateId: payment.id },
    );

    this.metrics.paymentsTotal.inc({
      direction: payment.direction,
      status: PaymentStatus.Captured,
      currency: payment.amount.currencyCode,
    });
    this.metrics.paymentAmount.inc(
      { direction: payment.direction, currency: payment.amount.currencyCode },
      Number(payment.amount.amount),
    );

    this.notify(payment.userId, payment.merchantId, payment);
    this.logger.log(`Payment ${payment.id} captured via transfer ${input.transferId}`);
  }

  @Transactional({ propagation: 'REQUIRED' })
  async onTransferRejected(input: TransferRejectedInput): Promise<void> {
    const payment = await this.payments.findByIdForUpdate(PaymentId.of(input.paymentId));

    if (!payment) {
      throw new NotFoundError('Payment', input.paymentId);
    }

    /**
     * A refused refund is not a failed payment.
     *
     * The ledger can refuse to move money back — the house account may
     * not have it — and when it does, nothing moved: the payment is
     * still captured, exactly as before the refund was attempted. This
     * used to call `fail()` for every rejection, and `refunding → failed`
     * is not a legal transition, so the saga logged "already refunding"
     * and returned. The payment stayed in `refunding` for good: the
     * customer never got the money back, `beginRefund` refuses to start
     * from `refunding` so nobody could retry, and no sweep looks at that
     * state. `cancelRefund` is the same compensation the command handler
     * already applies when the *provider* refuses.
     */
    if (payment.status === PaymentStatus.Refunding) {
      const cancelled = payment.cancelRefund();
      if (cancelled.isErr()) {
        throw cancelled.error;
      }

      await this.payments.save(payment);
      this.logger.warn(
        `Ledger refused the refund for ${payment.id} (${input.reason}) — payment returned to captured`,
      );
      this.notify(payment.userId, payment.merchantId, payment);
      return;
    }

    const failed = payment.fail(mapRejection(input.reason), input.detail);
    if (failed.isErr()) {
      this.logger.warn(
        `Ledger rejected ${input.paymentId} but the payment is already ${payment.status}`,
      );
      return;
    }

    await this.payments.save(payment);

    await this.outbox.publish(
      PaymentFailedContract,
      {
        paymentId: payment.id,
        merchantId: payment.merchantId,
        userId: payment.userId,
        direction: payment.direction,
        amount: payment.amount.toJSON(),
        fee: payment.fee.toJSON(),
        reference: payment.reference,
        reason: mapRejection(input.reason),
        detail: input.detail,
        failedAt: new Date().toISOString(),
      },
      { aggregateType: 'Payment', aggregateId: payment.id },
    );

    this.metrics.paymentsTotal.inc({
      direction: payment.direction,
      status: PaymentStatus.Failed,
      currency: payment.amount.currencyCode,
    });

    this.notify(payment.userId, payment.merchantId, payment);
    this.logger.warn(`Payment ${payment.id} failed in the ledger: ${input.reason}`);
  }

  private async completeRefund(payment: Payment, input: TransferPostedInput): Promise<void> {
    /**
     * The amount comes from the posting, not from `refundableAmount`.
     *
     * Reading the remaining balance here would record a 40.00 partial
     * refund as a full 100.00 one and flip the payment to `refunded` while
     * 60.00 is still refundable — the ledger and the payment would then
     * disagree, and only reconciliation would notice.
     */
    const amount = refundedAmountFrom(input, payment);

    if (!amount) {
      this.logger.error(
        `Refund posting ${input.transferId} has no debit against ${payment.userId}`,
      );
      return;
    }

    const refunded = payment.completeRefund(amount);
    if (refunded.isErr()) {
      this.logger.error(`Cannot complete refund for ${payment.id}: ${refunded.error.message}`);
      return;
    }

    await this.payments.save(payment);

    await this.publish(PaymentRefundedContract, {
      paymentId: payment.id,
      merchantId: payment.merchantId,
      userId: payment.userId,
      direction: payment.direction,
      amount: payment.amount.toJSON(),
      fee: payment.fee.toJSON(),
      reference: payment.reference,
      refundId: input.transferId,
      refundedAmount: amount.toJSON(),
      refundedAt: input.postedAt,
    });

    this.notify(payment.userId, payment.merchantId, payment);
  }

  private async publish(
    definition: EventDefinition<string, ZodType>,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.outbox.publish(definition, payload, {
      aggregateType: 'Payment',
      aggregateId: String(payload['paymentId']),
    });
  }

  private notify(userId: string, merchantId: string, payment: Payment): void {
    this.events.emit(PAYMENT_UPDATED_EVENT, {
      userId,
      merchantId,
      payment: toPaymentView(payment),
    } satisfies PaymentUpdatedEvent);
  }
}

/**
 * Extracts what left the user's available balance.
 *
 * A refund debits `user:<id>:available` by the refunded amount; the fee
 * lines hit house accounts and must not be counted.
 */
function refundedAmountFrom(input: TransferPostedInput, payment: Payment): Money | null {
  const account = `user:${payment.userId}:available:${payment.amount.currencyCode}`;

  const line = input.lines.find(
    (candidate) => candidate.account === account && candidate.direction === 'debit',
  );

  return line ? Money.fromMinor(line.amount.amount, line.amount.currency) : null;
}

/** Ledger vocabulary → payment vocabulary. The contexts do not share enums. */
function mapRejection(reason: LedgerRejectionReason): PaymentFailureReason {
  switch (reason) {
    case 'insufficient_funds':
      return 'insufficient_funds';
    case 'wallet_frozen':
      return 'wallet_frozen';
    case 'wallet_not_found':
      return 'wallet_not_found';
    case 'currency_mismatch':
      return 'currency_mismatch';
    case 'limit_exceeded':
      return 'limit_exceeded';
    case 'unbalanced_entry':
      return 'internal_error';
  }
}
