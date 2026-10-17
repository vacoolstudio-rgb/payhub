import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { Money, NotFoundError } from '@payhub/kernel';
import { Transactional } from '@payhub/persistence';
import { OutboxPublisher } from '@payhub/messaging';
import { MetricsService } from '@payhub/observability';
import type { ZodType } from 'zod';
import {
  type EventDefinition,
  PaymentAuthorized as PaymentAuthorizedContract,
  PaymentFailed as PaymentFailedContract,
  PaymentInitiated as PaymentInitiatedContract,
  PostTransferCommand,
} from '@payhub/contracts';
import { MERCHANT_PRICING, type MerchantPricing } from '../../domain/merchant-pricing.port.js';
import {
  PAYMENT_PROVIDER_REGISTRY,
  type PaymentProviderRegistry,
} from '../../domain/payment-provider.port.js';
import {
  Payment,
  PaymentDirection,
  PaymentId,
  type PaymentFailureReason,
} from '../../domain/payment.aggregate.js';
import { PAYMENT_REPOSITORY, type PaymentRepository } from '../../domain/payment.repository.js';
import { PAYMENT_UPDATED_EVENT, type PaymentUpdatedEvent } from '../payment.events.js';
import { type PaymentView, toPaymentView } from '../payment.view.js';
import { CreatePayment } from './payment.commands.js';

/**
 * Entry point of the payment saga.
 *
 * The flow is deliberately split into three steps with the *external* call
 * in the middle and outside any transaction:
 *
 *   1. persist a `pending` payment + emit `payment.initiated`  (transaction)
 *   2. ask the provider to authorise                            (network I/O)
 *   3. record the answer and hand over to the ledger            (transaction)
 *
 * Holding a database transaction open across an HTTP call to a PSP is the
 * single most damaging thing you can do to a payments service: a provider
 * that takes 10 s to answer pins a connection and a row lock for 10 s, and
 * the pool is exhausted long before the provider times out.
 *
 * The cost of splitting is a crash window between 2 and 3 — a provider
 * authorisation we never recorded. That is exactly what reconciliation is
 * for, and it is a far cheaper failure than a locked-up database.
 */
@CommandHandler(CreatePayment)
export class CreatePaymentHandler implements ICommandHandler<CreatePayment, PaymentView> {
  private readonly logger = new Logger(CreatePaymentHandler.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(MERCHANT_PRICING) private readonly pricing: MerchantPricing,
    @Inject(PAYMENT_PROVIDER_REGISTRY) private readonly providers: PaymentProviderRegistry,
    private readonly outbox: OutboxPublisher,
    private readonly metrics: MetricsService,
    private readonly events: EventEmitter2,
  ) {}

  async execute(command: CreatePayment): Promise<PaymentView> {
    const payment = await this.createPending(command);

    this.metrics.paymentsTotal.inc({
      direction: payment.direction,
      status: 'initiated',
      currency: payment.amount.currencyCode,
    });

    // Internal transfers have no external rail: nothing to authorise, the
    // ledger is the only authority.
    if (payment.direction === PaymentDirection.Transfer) {
      return this.handOverToLedger(payment.id);
    }

    const provider = this.providers.forMethod(payment.method);

    const authorization = await provider.authorize({
      paymentId: payment.id,
      userId: payment.userId,
      amount: payment.amount,
      currency: payment.amount.currencyCode,
      reference: payment.reference,
      metadata: payment.metadata,
    });

    if (authorization.isErr()) {
      return this.failPayment(
        payment.id,
        'provider_unavailable',
        authorization.error.message,
      );
    }

    if (!authorization.value.approved) {
      return this.failPayment(
        payment.id,
        'provider_declined',
        authorization.value.declineReason ?? 'Declined by provider',
      );
    }

    return this.recordAuthorization(payment.id, authorization.value.providerReference);
  }

  // --- step 1 -------------------------------------------------------------

  @Transactional()
  private async createPending(command: CreatePayment): Promise<Payment> {
    const { input } = command;

    const amount = Money.parseMajor(input.amountMajor, input.currency);
    if (amount.isErr()) {
      throw amount.error;
    }

    const pricing = await this.pricing.resolve(input.merchantId, input.currency);
    if (pricing.isErr()) {
      throw pricing.error;
    }

    const fee = pricing.value.feeFor(amount.value);

    const payment = Payment.initiate({
      id: PaymentId.create(),
      merchantId: input.merchantId,
      userId: input.userId,
      counterpartyUserId: input.counterpartyUserId ?? null,
      direction: input.direction,
      amount: amount.value,
      fee,
      method: input.method,
      reference: input.reference ?? `ph_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: input.metadata ?? {},
    });

    if (payment.isErr()) {
      throw payment.error;
    }

    await this.payments.insert(payment.value);
    await this.publishDomainEvents(payment.value);

    return payment.value;
  }

  // --- step 3a ------------------------------------------------------------

  @Transactional()
  private async recordAuthorization(
    paymentId: string,
    providerReference: string,
  ): Promise<PaymentView> {
    const payment = await this.load(paymentId);

    const authorized = payment.authorize(providerReference);
    if (authorized.isErr()) {
      throw authorized.error;
    }

    await this.payments.save(payment);
    await this.publishDomainEvents(payment);
    await this.requestLedgerPosting(payment);

    return this.finish(payment);
  }

  /** Transfers skip authorisation and go straight to the ledger. */
  @Transactional()
  private async handOverToLedger(paymentId: string): Promise<PaymentView> {
    const payment = await this.load(paymentId);
    await this.requestLedgerPosting(payment);
    return this.finish(payment);
  }

  // --- step 3b ------------------------------------------------------------

  @Transactional()
  private async failPayment(
    paymentId: string,
    reason: PaymentFailureReason,
    detail: string,
  ): Promise<PaymentView> {
    const payment = await this.load(paymentId);

    const failed = payment.fail(reason, detail);
    if (failed.isErr()) {
      throw failed.error;
    }

    await this.payments.save(payment);
    await this.publishDomainEvents(payment);

    this.metrics.paymentsTotal.inc({
      direction: payment.direction,
      status: 'failed',
      currency: payment.amount.currencyCode,
    });

    this.logger.warn(`Payment ${payment.id} failed at authorisation: ${reason} — ${detail}`);
    return this.finish(payment);
  }

  // --- shared -------------------------------------------------------------

  /**
   * Emits the ledger command through the outbox, inside the same transaction
   * that moved the payment into `capturing`. The payment cannot be waiting
   * for a command that was never sent, and vice versa.
   */
  private async requestLedgerPosting(payment: Payment): Promise<void> {
    const transferId = randomUUID();

    const started = payment.beginCapture(transferId);
    if (started.isErr()) {
      throw started.error;
    }

    await this.payments.save(payment);

    await this.outbox.publish(
      PostTransferCommand,
      {
        transferId,
        paymentId: payment.id,
        userId: payment.userId,
        counterpartyUserId: payment.counterpartyUserId,
        merchantId: payment.merchantId,
        operation: payment.direction === PaymentDirection.Withdrawal ? 'withdrawal' : payment.direction === PaymentDirection.Transfer ? 'transfer' : 'deposit',
        amount: payment.amount.toJSON(),
        fee: payment.fee.toJSON(),
        provider: payment.method,
        description: `${payment.direction} ${payment.reference}`,
        requestedAt: new Date().toISOString(),
      },
      {
        aggregateType: 'Payment',
        aggregateId: payment.id,
        // Same partition key as the payment events: the ledger sees commands
        // for one payment in the order they were issued.
        partitionKey: payment.id,
      },
    );
  }

  private async load(paymentId: string): Promise<Payment> {
    const payment = await this.payments.findByIdForUpdate(PaymentId.of(paymentId));
    if (!payment) {
      throw new NotFoundError('Payment', paymentId);
    }
    return payment;
  }

  /** Drains the aggregate's buffer into the outbox. */
  private async publishDomainEvents(payment: Payment): Promise<void> {
    for (const event of payment.pullDomainEvents()) {
      const definition = CONTRACT_BY_EVENT[event.eventName];
      if (!definition) {
        continue;
      }

      await this.outbox.publish(definition, event.payload(), {
        aggregateType: 'Payment',
        aggregateId: payment.id,
        messageId: event.eventId,
      });
    }
  }

  private finish(payment: Payment): PaymentView {
    const view = toPaymentView(payment);

    // Local, in-process notification that drives the WebSocket push. Kept
    // separate from the integration events: this one must not be replayed.
    this.events.emit(PAYMENT_UPDATED_EVENT, {
      userId: payment.userId,
      merchantId: payment.merchantId,
      payment: view,
    } satisfies PaymentUpdatedEvent);

    return view;
  }
}

/**
 * Domain event → integration contract.
 *
 * Not every domain event leaves the service: the ones missing from this map
 * stay internal, which is the point of having two vocabularies.
 */
const CONTRACT_BY_EVENT: Readonly<Record<string, EventDefinition<string, ZodType>>> = {
  'payment.initiated.v1': PaymentInitiatedContract,
  'payment.authorized.v1': PaymentAuthorizedContract,
  'payment.failed.v1': PaymentFailedContract,
};
