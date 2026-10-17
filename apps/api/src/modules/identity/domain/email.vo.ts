import { ValidationError, ValueObject, type Result, err, ok } from '@payhub/kernel';

interface EmailProps {
  readonly value: string;
}

/**
 * Email as a value object with a single canonical form.
 *
 * Normalising on construction (trim + lowercase) is what makes
 * `UNIQUE(email)` actually mean "one account per address" — otherwise
 * `Bob@x.com` and `bob@x.com` are two users and the login flow becomes a
 * guessing game.
 */
export class Email extends ValueObject<EmailProps> {
  // Deliberately permissive: RFC 5322 in a regex is a myth, and the real
  // verification is the confirmation link we send.
  private static readonly PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

  private constructor(props: EmailProps) {
    super(props);
  }

  static create(raw: string): Result<Email, ValidationError> {
    const normalised = raw.trim().toLowerCase();

    if (normalised.length === 0 || normalised.length > 254) {
      return err(new ValidationError('Email length is out of range', {}, 'INVALID_EMAIL'));
    }
    if (!Email.PATTERN.test(normalised)) {
      return err(new ValidationError('Email is not a valid address', {}, 'INVALID_EMAIL'));
    }

    return ok(new Email({ value: normalised }));
  }

  /** Trusted construction for values already stored in the database. */
  static of(value: string): Email {
    return new Email({ value });
  }

  get value(): string {
    return this.props.value;
  }

  get domain(): string {
    return this.props.value.slice(this.props.value.indexOf('@') + 1);
  }

  /** `b***@example.com` — for logs and support tooling. */
  masked(): string {
    const [local = '', domain = ''] = this.props.value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }

  override toString(): string {
    return this.props.value;
  }
}
