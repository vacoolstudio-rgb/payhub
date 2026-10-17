import { ValidationError, ValueObject, type Result, err, ok } from '@payhub/kernel';
import { isPrivateHost } from '@payhub/shared';

interface WebhookEndpointProps {
  readonly url: string;
  /** Shared secret used to sign deliveries. Never returned to the client. */
  readonly secret: string;
  readonly subscribedEvents: readonly string[];
  readonly active: boolean;
}

/**
 * A merchant's webhook destination.
 *
 * The URL is validated at construction, including an SSRF guard: a merchant
 * must not be able to make our workers probe `http://169.254.169.254/` or
 * anything inside the cluster. In production the egress proxy enforces this
 * too, but defence in depth is cheap here.
 *
 * This is only half the guard. It checks a *string*, so it cannot see a
 * hostname that resolves to a private address — the worker checks the
 * resolved address again before it connects.
 */
export class WebhookEndpoint extends ValueObject<WebhookEndpointProps> {
  private constructor(props: WebhookEndpointProps) {
    super(props);
  }

  static create(input: {
    url: string;
    secret: string;
    subscribedEvents?: readonly string[];
    active?: boolean;
    allowInsecure?: boolean;
  }): Result<WebhookEndpoint, ValidationError> {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return err(new ValidationError('Webhook URL is malformed', { url: input.url }, 'INVALID_WEBHOOK_URL'));
    }

    if (parsed.protocol !== 'https:' && !input.allowInsecure) {
      return err(
        new ValidationError('Webhook URL must use HTTPS', { url: input.url }, 'INVALID_WEBHOOK_URL'),
      );
    }

    if (isPrivateHost(parsed.hostname)) {
      return err(
        new ValidationError(
          'Webhook URL must point at a public host',
          { host: parsed.hostname },
          'WEBHOOK_URL_FORBIDDEN',
        ),
      );
    }

    return ok(
      new WebhookEndpoint({
        url: parsed.toString(),
        secret: input.secret,
        subscribedEvents: input.subscribedEvents ?? ['*'],
        active: input.active ?? true,
      }),
    );
  }

  static of(props: WebhookEndpointProps): WebhookEndpoint {
    return new WebhookEndpoint(props);
  }

  wantsEvent(eventType: string): boolean {
    return (
      this.props.active &&
      (this.props.subscribedEvents.includes('*') ||
        this.props.subscribedEvents.includes(eventType))
    );
  }

  get url(): string {
    return this.props.url;
  }

  get secret(): string {
    return this.props.secret;
  }

  get subscribedEvents(): readonly string[] {
    return this.props.subscribedEvents;
  }

  get active(): boolean {
    return this.props.active;
  }
}
