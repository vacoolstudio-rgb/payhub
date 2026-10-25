import { Injectable, Logger } from '@nestjs/common';

export interface NotificationPayload {
  readonly userId: string;
  readonly template: string;
  readonly subject: string;
  readonly variables: Readonly<Record<string, string>>;
}

export const NOTIFICATION_CHANNEL = Symbol.for('payhub:NotificationChannel');

/**
 * A delivery channel. Email, push and SMS differ in cost, latency and
 * failure modes, so each one is its own adapter behind a shared port and
 * the dispatcher decides which to use per template.
 */
export interface NotificationChannel {
  readonly name: 'email' | 'push' | 'sms';
  send(payload: NotificationPayload): Promise<void>;
}

/**
 * Stand-in for an ESP (SES, Postmark, …).
 *
 * Deliberately a logger rather than a half-real SMTP client: the interesting
 * engineering in this service is the consumer semantics and the routing, and
 * a fake adapter keeps the whole stack runnable with `docker compose up`.
 */
@Injectable()
export class EmailChannel implements NotificationChannel {
  readonly name = 'email' as const;
  private readonly logger = new Logger(EmailChannel.name);

  async send(payload: NotificationPayload): Promise<void> {
    // The variables are the one part of a notification that carries
    // personal data — a name, an address, sometimes an amount — and
    // this used to stringify all of them into the message. Measured: a
    // registration wrote the new user's address and display name to the
    // log in plain text.
    //
    // Stringified is the detail that matters. Redaction walks objects
    // and masks by key; a value already baked into a message string is
    // past the point where anything can find it. The keys are safe to
    // log and say as much for debugging; the values are not.
    this.logger.log(
      `email → user=${payload.userId} template=${payload.template} ` +
        `fields=[${Object.keys(payload.variables).sort().join(', ')}]`,
    );
  }
}

@Injectable()
export class PushChannel implements NotificationChannel {
  readonly name = 'push' as const;
  private readonly logger = new Logger(PushChannel.name);

  async send(payload: NotificationPayload): Promise<void> {
    this.logger.log(`push → user=${payload.userId} template=${payload.template}`);
  }
}
