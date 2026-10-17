/**
 * Domain error taxonomy.
 *
 * Every failure carries a stable machine-readable `code` (contract with API
 * clients) and a `kind` that the HTTP/transport layer maps to a status code.
 * The domain never imports `@nestjs/common` — it does not know what HTTP is.
 */

export const ErrorKind = {
  Validation: 'validation',
  NotFound: 'not_found',
  Conflict: 'conflict',
  Forbidden: 'forbidden',
  Unauthorized: 'unauthorized',
  PreconditionFailed: 'precondition_failed',
  RateLimited: 'rate_limited',
  Unavailable: 'unavailable',
  Internal: 'internal',
} as const;

export type ErrorKind = (typeof ErrorKind)[keyof typeof ErrorKind];

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly kind: ErrorKind;

  /** Structured, safe-to-serialise context. Never put secrets in here. */
  readonly details: Readonly<Record<string, unknown>>;

  protected constructor(
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    this.details = Object.freeze({ ...details });
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      kind: this.kind,
      message: this.message,
      details: this.details,
    };
  }
}

/** A value object or command failed its invariants. */
export class ValidationError extends DomainError {
  readonly code: string;
  readonly kind = ErrorKind.Validation;

  constructor(
    message: string,
    details: Record<string, unknown> = {},
    code = 'VALIDATION_FAILED',
  ) {
    super(message, details);
    this.code = code;
  }
}

export class NotFoundError extends DomainError {
  readonly code: string;
  readonly kind = ErrorKind.NotFound;

  constructor(resource: string, identifier: unknown) {
    super(`${resource} was not found`, { resource, identifier });
    this.code = `${toScreamingSnake(resource)}_NOT_FOUND`;
  }
}

export class ConflictError extends DomainError {
  readonly code: string;
  readonly kind = ErrorKind.Conflict;

  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message, details);
    this.code = code;
  }
}

export class ForbiddenError extends DomainError {
  readonly code: string;
  readonly kind = ErrorKind.Forbidden;

  constructor(message = 'Operation is not permitted', code = 'FORBIDDEN', details: Record<string, unknown> = {}) {
    super(message, details);
    this.code = code;
  }
}

export class UnauthorizedError extends DomainError {
  readonly code: string;
  readonly kind = ErrorKind.Unauthorized;

  constructor(message = 'Authentication required', code = 'UNAUTHORIZED', details: Record<string, unknown> = {}) {
    super(message, details);
    this.code = code;
  }
}

/** An aggregate was in the wrong state for the requested transition. */
export class InvalidStateError extends DomainError {
  readonly code: string;
  readonly kind = ErrorKind.PreconditionFailed;

  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message, details);
    this.code = code;
  }
}

export class RateLimitedError extends DomainError {
  readonly code = 'RATE_LIMITED';
  readonly kind = ErrorKind.RateLimited;

  constructor(
    message = 'Too many requests',
    readonly retryAfterMs: number = 1_000,
    details: Record<string, unknown> = {},
  ) {
    super(message, { ...details, retryAfterMs });
  }
}

/** A downstream dependency (PSP, LLM provider, broker) is misbehaving. */
export class DependencyFailureError extends DomainError {
  readonly code: string;
  readonly kind = ErrorKind.Unavailable;

  constructor(dependency: string, message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, { dependency, retryable: options?.retryable ?? true }, { cause: options?.cause });
    this.code = `${toScreamingSnake(dependency)}_UNAVAILABLE`;
  }

  get retryable(): boolean {
    return this.details['retryable'] === true;
  }
}

/** Optimistic concurrency control lost the race. Safe to retry the whole command. */
export class ConcurrencyError extends DomainError {
  readonly code = 'CONCURRENT_MODIFICATION';
  readonly kind = ErrorKind.Conflict;

  constructor(aggregate: string, id: unknown, expectedVersion?: number) {
    super(`${aggregate} was modified concurrently`, { aggregate, id, expectedVersion });
  }
}

function toScreamingSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toUpperCase();
}
