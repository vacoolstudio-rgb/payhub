import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundError } from '@payhub/kernel';
import { Transactional } from '@payhub/persistence';
import { OutboxPublisher } from '@payhub/messaging';
import { PaymentFailed as PaymentFailedContract } from '@payhub/contracts';
import { PaymentId } from '../../domain/payment.aggregate.js';
import { PAYMENT_REPOSITORY, type PaymentRepository } from '../../domain/payment.repository.js';
import { PAYMENT_UPDATED_EVENT, type PaymentUpdatedEvent } from '../payment.events.js';
import { type PaymentView, toPaymentView } from '../payment.view.js';
import { CancelPayment } from './payment.commands.js';

@CommandHandler(CancelPayment)
export class CancelPaymentHandler implements ICommandHandler<CancelPayment, PaymentView> {
  private readonly logger = new Logger(CancelPaymentHandler.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    private readonly outbox: OutboxPublisher,
    private readonly events: EventEmitter2,
  ) {}

  @Transactional()
  async execute(command: CancelPayment): Promise<PaymentView> {
    const payment = await this.payments.findByIdForUpdate(
      PaymentId.of(command.input.paymentId),
    );

    if (!payment) {
      throw new NotFoundError('Payment', command.input.paymentId);
    }
    // Not a `ForbiddenError`: answering "this one is not yours" tells a
    // caller the id is real. Measured — cancelling a stranger's payment
    // returned 403 and cancelling a random uuid returned 404, which is a
    // free oracle for confirming that an id seen somewhere is a live
    // payment. An object the caller may not act on is indistinguishable
    // from one that does not exist.
    if (payment.userId !== command.input.actorUserId) {
      throw new NotFoundError('Payment', command.input.paymentId);
    }

    // The state machine decides whether cancellation is still possible —
    // a payment already handed to the ledger cannot be cancelled, only
    // refunded.
    const cancelled = payment.cancel();
    if (cancelled.isErr()) {
      throw cancelled.error;
    }

    await this.payments.save(payment);

    for (const event of payment.pullDomainEvents()) {
      if (event.eventName === 'payment.failed.v1') {
        await this.outbox.publish(PaymentFailedContract, event.payload() as never, {
          aggregateType: 'Payment',
          aggregateId: payment.id,
          messageId: event.eventId,
        });
      }
    }

    this.logger.log(`Payment ${payment.id} cancelled by user`);

    const view = toPaymentView(payment);
    this.events.emit(PAYMENT_UPDATED_EVENT, {
      userId: payment.userId,
      merchantId: payment.merchantId,
      payment: view,
    } satisfies PaymentUpdatedEvent);

    return view;
  }
}
