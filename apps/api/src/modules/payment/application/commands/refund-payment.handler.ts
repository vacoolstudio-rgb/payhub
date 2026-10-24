import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { ForbiddenError, Money, NotFoundError } from '@payhub/kernel';
import { Transactional } from '@payhub/persistence';
import { OutboxPublisher } from '@payhub/messaging';
import { PostTransferCommand } from '@payhub/contracts';
import {
  PAYMENT_PROVIDER_REGISTRY,
  type PaymentProviderRegistry,
} from '../../domain/payment-provider.port.js';
import { MERCHANT_AUTHORITY, type MerchantAuthority } from '../../domain/merchant-authority.port.js';
import { type Payment, PaymentDirection, PaymentId } from '../../domain/payment.aggregate.js';
import { PAYMENT_REPOSITORY, type PaymentRepository } from '../../domain/payment.repository.js';
import { PAYMENT_UPDATED_EVENT, type PaymentUpdatedEvent } from '../payment.events.js';
import { type PaymentView, toPaymentView } from '../payment.view.js';
import { RefundPayment } from './payment.commands.js';

interface PreparedRefund {
  readonly paymentId: string;
  /** Minted and persisted in step 1, so a crash leaves something to retry by. */
  readonly transferId: string;
  readonly amount: Money;
  readonly providerReference: string | null;
  readonly method: string;
  readonly needsProvider: boolean;
}

/**
 * Refunds are compensating transactions, not deletions.
 *
 * The original payment and its journal entry stay exactly as they were; a
 * second, opposite movement is recorded. Partial refunds are supported and
 * the payment only becomes `refunded` once the full amount is returned.
 *
 * The flow is split into three steps with the provider call **outside** any
 * transaction, for the same reason `CreatePaymentHandler` is:
 *
 *   1. move the payment to `refunding` and persist it      (transaction)
 *   2. ask the provider to return the money                (network I/O)
 *   3. emit the ledger command, or roll step 1 back        (transaction)
 *
 * Holding a row lock across an HTTP call to a PSP drains the connection
 * pool long before the PSP times out. Step 3's rollback is what keeps a
 * declined refund from stranding the payment in `refunding` — a state no
 * cron sweeps.
 */
@CommandHandler(RefundPayment)
export class RefundPaymentHandler implements ICommandHandler<RefundPayment, PaymentView> {
  private readonly logger = new Logger(RefundPaymentHandler.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(PAYMENT_PROVIDER_REGISTRY) private readonly providers: PaymentProviderRegistry,
    @Inject(MERCHANT_AUTHORITY) private readonly merchants: MerchantAuthority,
    private readonly outbox: OutboxPublisher,
    private readonly events: EventEmitter2,
  ) {}

  async execute(command: RefundPayment): Promise<PaymentView> {
    const prepared = await this.beginRefund(command);

    if (prepared.needsProvider && prepared.providerReference) {
      const provider = this.providers.forMethod(prepared.method);
      const refunded = await provider.refund(prepared.providerReference, prepared.amount);

      if (refunded.isErr()) {
        // Put the payment back where it was. Leaving it in `refunding`
        // would make it invisible to both the user and every sweep.
        await this.abortRefund(prepared.paymentId);
        this.logger.error(
          `Provider refund failed for ${prepared.paymentId}: ${refunded.error.message}`,
        );
        throw refunded.error;
      }
    }

    return this.requestLedgerRefund(prepared, command.input.reason);
  }

  // --- step 1 -------------------------------------------------------------

  @Transactional()
  private async beginRefund(command: RefundPayment): Promise<PreparedRefund> {
    const { input } = command;
    const payment = await this.payments.findByIdForUpdate(PaymentId.of(input.paymentId));

    if (!payment) {
      throw new NotFoundError('Payment', input.paymentId);
    }
    await this.assertActor(payment, input);

    // Omitting the amount means "refund everything that is still refundable".
    let refundAmount = payment.refundableAmount;

    if (input.amountMajor) {
      const parsed = Money.parseMajor(input.amountMajor, payment.amount.currency);
      if (parsed.isErr()) {
        throw parsed.error;
      }
      refundAmount = parsed.value;
    }

    const transferId = randomUUID();
    const started = payment.beginRefund(refundAmount, transferId);
    if (started.isErr()) {
      throw started.error;
    }

    await this.payments.save(payment);

    return {
      paymentId: payment.id,
      transferId,
      amount: refundAmount,
      providerReference: payment.providerReference,
      method: payment.method,
      // An internal transfer never touched an external rail.
      needsProvider: payment.direction !== PaymentDirection.Transfer,
    };
  }

  // --- step 3 -------------------------------------------------------------

  @Transactional()
  private async requestLedgerRefund(
    prepared: PreparedRefund,
    reason: string,
  ): Promise<PaymentView> {
    const payment = await this.load(prepared.paymentId);

    await this.outbox.publish(
      PostTransferCommand,
      {
        transferId: prepared.transferId,
        paymentId: payment.id,
        userId: payment.userId,
        counterpartyUserId: payment.counterpartyUserId,
        merchantId: payment.merchantId,
        operation: 'refund',
        amount: prepared.amount.toJSON(),
        fee: Money.zero(payment.amount.currency).toJSON(),
        provider: payment.method,
        description: `refund ${payment.reference}: ${reason}`,
        requestedAt: new Date().toISOString(),
      },
      { aggregateType: 'Payment', aggregateId: payment.id, partitionKey: payment.id },
    );

    this.logger.log(
      `Refund of ${prepared.amount.toString()} requested for payment ${payment.id}`,
    );

    return this.notify(payment);
  }

  @Transactional()
  private async abortRefund(paymentId: string): Promise<void> {
    const payment = await this.load(paymentId);

    const cancelled = payment.cancelRefund();
    if (cancelled.isErr()) {
      throw cancelled.error;
    }

    await this.payments.save(payment);
    this.notify(payment);
  }

  // --- helpers ------------------------------------------------------------

  private async load(paymentId: string): Promise<Payment> {
    const payment = await this.payments.findByIdForUpdate(PaymentId.of(paymentId));
    if (!payment) {
      throw new NotFoundError('Payment', paymentId);
    }
    return payment;
  }

  private notify(payment: Payment): PaymentView {
    const view = toPaymentView(payment);

    this.events.emit(PAYMENT_UPDATED_EVENT, {
      userId: payment.userId,
      merchantId: payment.merchantId,
      payment: view,
    } satisfies PaymentUpdatedEvent);

    return view;
  }

  /**
   * Only the merchant that took the payment may return it.
   *
   * This used to read `payment.userId === actorUserId` — refuse the
   * payer, allow everyone else — with a comment saying only the merchant
   * side could refund. The two disagreed, and the permission guard in
   * front of the route hid it: `payment:refund` belongs to every
   * `merchant_owner`, so the check that was supposed to narrow that down
   * to *this* merchant narrowed nothing. One merchant owner could refund
   * another merchant's captured payment, and the money moved.
   *
   * Refusing the payer falls out of the ownership rule rather than being
   * a rule of its own, and a merchant that bought from itself is a
   * merchant refunding its own sale — which is allowed, and was not.
   */
  private async assertActor(
    payment: Payment,
    input: { readonly actorUserId: string; readonly actorIsPlatformAdmin: boolean },
  ): Promise<void> {
    if (input.actorIsPlatformAdmin) {
      return;
    }

    if (!(await this.merchants.mayActFor(payment.merchantId, input.actorUserId))) {
      throw new ForbiddenError('Only the merchant can refund a payment', 'REFUND_FORBIDDEN', {
        paymentId: payment.id,
      });
    }
  }
}
