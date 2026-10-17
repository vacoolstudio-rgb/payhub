import { Injectable, Logger } from '@nestjs/common';
import { Money } from '@payhub/kernel';
import { RedisService } from '@payhub/redis';
import { EmailChannel, type NotificationPayload, PushChannel } from './notification.channels.js';

export type NotificationKind =
  | 'payment_captured'
  | 'payment_failed'
  | 'payment_refunded'
  | 'welcome';

/**
 * Routing and suppression.
 *
 * Two rules that any real notification service needs and that are easy to
 * forget:
 *
 *  • **Deduplication across restarts.** The consumer is at-least-once, so
 *    the same event can arrive twice. A Redis key keyed by (user, event) is
 *    enough here — unlike the ledger, a duplicate email is annoying rather
 *    than financially wrong, so this does not need a database transaction.
 *
 *  • **Rate limiting per user.** A merchant retrying a batch of 500 payments
 *    must not generate 500 push notifications in one minute.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  private static readonly ROUTING: Record<NotificationKind, Array<'email' | 'push'>> = {
    payment_captured: ['push'],
    payment_failed: ['email', 'push'],
    payment_refunded: ['email'],
    welcome: ['email'],
  };

  constructor(
    private readonly email: EmailChannel,
    private readonly push: PushChannel,
    private readonly redis: RedisService,
  ) {}

  async dispatch(input: {
    kind: NotificationKind;
    eventId: string;
    userId: string;
    subject: string;
    variables: Record<string, string>;
  }): Promise<void> {
    const deduped = await this.redis.client.set(
      `notif:sent:${input.userId}:${input.eventId}`,
      '1',
      'EX',
      86_400,
      'NX',
    );

    if (!deduped) {
      this.logger.debug(`Already notified ${input.userId} about ${input.eventId}`);
      return;
    }

    const budget = await this.redis.client.incr(`notif:rate:${input.userId}`);
    if (budget === 1) {
      await this.redis.client.expire(`notif:rate:${input.userId}`, 60);
    }
    if (budget > 30) {
      this.logger.warn(`Suppressing notification for ${input.userId}: 30/min exceeded`);
      return;
    }

    const payload: NotificationPayload = {
      userId: input.userId,
      template: input.kind,
      subject: input.subject,
      variables: input.variables,
    };

    for (const channel of NotificationDispatcher.ROUTING[input.kind]) {
      const adapter = channel === 'email' ? this.email : this.push;
      try {
        await adapter.send(payload);
      } catch (error) {
        // One failing channel must not stop the others.
        this.logger.error(
          `${channel} delivery failed for ${input.userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** Formats money for a human, from the wire representation. */
  static formatMoney(money: { amount: string; currency: string }): string {
    return Money.fromMinor(money.amount, money.currency).format();
  }
}
