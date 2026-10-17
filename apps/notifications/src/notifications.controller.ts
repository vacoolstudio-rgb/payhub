import { Controller, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  type IntegrationEventEnvelope,
  PaymentCaptured,
  PaymentFailed,
  PaymentRefunded,
  Topics,
  UserRegistered,
} from '@payhub/contracts';
import type { PayHubClsStore } from '@payhub/shared';
import { NotificationDispatcher } from './channels/notification.dispatcher.js';

/**
 * Kafka consumer written with `@nestjs/microservices` — on purpose.
 *
 * The other services use kafkajs directly. Side by side, the trade-off is:
 *
 *   Nest transport                        raw kafkajs
 *   ───────────────────────────────────── ────────────────────────────────
 *   `@EventPattern`, no loop to write     you own the consumer loop
 *   one handler per topic                 route by event type yourself
 *   offsets committed for you             explicit pause/seek/commit
 *   interceptors/filters/pipes apply      plumb cross-cutting concerns
 *   retry = restart the message           retry topics, DLQ, backoff ladder
 *
 * For this service — fire-and-forget notifications where a lost message is
 * a missing email, not a lost payment — the transport is clearly the right
 * tool: less code, fewer bugs, and the delivery guarantees it offers are
 * good enough. For the ledger, where a retry ladder and per-message
 * deduplication are the whole point, it would have had to be fought.
 */
@Controller()
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(
    private readonly dispatcher: NotificationDispatcher,
    private readonly cls: ClsService<PayHubClsStore>,
  ) {}

  /**
   * Re-establishes the request's correlation id for this message.
   *
   * The services on the hand-written consumer do this in one place, in
   * `KafkaConsumerService`. The Nest transport has no such hook, so a
   * notification was the one hop in a payment's life that logged nothing
   * traceable — the id reached this process inside the envelope and was
   * dropped on the floor.
   */
  private withContext<T>(envelope: IntegrationEventEnvelope, work: () => Promise<T>): Promise<T> {
    return this.cls.run(async () => {
      this.cls.set('correlationId', envelope.correlationId);
      return work();
    });
  }

  @EventPattern(Topics.PaymentEvents)
  async onPaymentEvent(@Payload() envelope: IntegrationEventEnvelope): Promise<void> {
    return this.withContext(envelope, () => this.routePaymentEvent(envelope));
  }

  private async routePaymentEvent(envelope: IntegrationEventEnvelope): Promise<void> {
    // One topic carries several event types, so routing happens here rather
    // than through the pattern — the Nest transport matches on topic only.
    switch (envelope.type) {
      case PaymentCaptured.name: {
        const payload = PaymentCaptured.schema.parse(envelope.payload);
        await this.dispatcher.dispatch({
          kind: 'payment_captured',
          eventId: envelope.id,
          userId: payload.userId,
          subject: `Payment of ${NotificationDispatcher.formatMoney(payload.amount)} completed`,
          variables: {
            amount: NotificationDispatcher.formatMoney(payload.amount),
            reference: payload.reference,
          },
        });
        break;
      }

      case PaymentFailed.name: {
        const payload = PaymentFailed.schema.parse(envelope.payload);
        await this.dispatcher.dispatch({
          kind: 'payment_failed',
          eventId: envelope.id,
          userId: payload.userId,
          subject: `Payment of ${NotificationDispatcher.formatMoney(payload.amount)} failed`,
          variables: {
            amount: NotificationDispatcher.formatMoney(payload.amount),
            reason: payload.reason,
            reference: payload.reference,
          },
        });
        break;
      }

      case PaymentRefunded.name: {
        const payload = PaymentRefunded.schema.parse(envelope.payload);
        await this.dispatcher.dispatch({
          kind: 'payment_refunded',
          eventId: envelope.id,
          userId: payload.userId,
          subject: `Refund of ${NotificationDispatcher.formatMoney(payload.refundedAmount)} issued`,
          variables: {
            amount: NotificationDispatcher.formatMoney(payload.refundedAmount),
            reference: payload.reference,
          },
        });
        break;
      }

      default:
        // Unknown event types are skipped, not failed: another service owns
        // them and the offset should still advance.
        this.logger.debug(`Ignoring ${envelope.type}`);
    }

    this.logger.debug(`handled ${envelope.type} (${envelope.id})`);
  }

  @EventPattern(Topics.IdentityEvents)
  async onIdentityEvent(@Payload() envelope: IntegrationEventEnvelope): Promise<void> {
    if (envelope.type !== UserRegistered.name) {
      return;
    }

    return this.withContext(envelope, () => this.handleUserRegistered(envelope));
  }

  private async handleUserRegistered(envelope: IntegrationEventEnvelope): Promise<void> {
    const payload = UserRegistered.schema.parse(envelope.payload);

    await this.dispatcher.dispatch({
      kind: 'welcome',
      eventId: envelope.id,
      userId: payload.userId,
      subject: 'Welcome to PayHub',
      variables: { displayName: payload.displayName, email: payload.email },
    });
  }
}
