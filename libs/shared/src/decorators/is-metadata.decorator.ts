import { registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';

/** Stripe's shape, for the same reasons: enough for a correlation id, not a document store. */
export const METADATA_LIMITS = {
  maxKeys: 50,
  maxKeyLength: 40,
  maxValueLength: 500,
} as const;

/**
 * A bag of short strings a caller can attach to a payment.
 *
 * It was `@IsObject()` and nothing else, which validates almost
 * nothing: the TypeScript type says `Record<string, string>` and the
 * runtime accepted nested objects, arrays, numbers, any number of keys,
 * and as many bytes as the request body limit allowed. Every payment
 * row carries this in a jsonb column, so "as much as the body limit
 * allows" is the real bound on how much storage one caller can attach
 * to one payment — measured at 50 kB accepted and persisted before this
 * existed, on a 256 kB body limit.
 *
 * The limits are Stripe's, which are the ones integrators already
 * expect, and they say what the field is for: correlating a payment
 * with an order in someone else's system, not storing the order.
 */
export function IsMetadata(options?: ValidationOptions) {
  return function register(object: object, propertyName: string): void {
    registerDecorator({
      name: 'isMetadata',
      target: object.constructor,
      propertyName,
      ...(options ? { options } : {}),
      validator: {
        validate(value: unknown): boolean {
          return describe(value) === null;
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} ${describe(args.value) ?? 'is invalid'}`;
        },
      },
    });
  };
}

/** The reason it is unacceptable, or null when it is fine. */
function describe(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'must be an object of string values';
  }

  const entries = Object.entries(value as Record<string, unknown>);

  if (entries.length > METADATA_LIMITS.maxKeys) {
    return `may not have more than ${METADATA_LIMITS.maxKeys} keys`;
  }

  for (const [key, entry] of entries) {
    if (key.length > METADATA_LIMITS.maxKeyLength) {
      return `keys may not be longer than ${METADATA_LIMITS.maxKeyLength} characters`;
    }
    if (typeof entry !== 'string') {
      return 'values must be strings';
    }
    if (entry.length > METADATA_LIMITS.maxValueLength) {
      return `values may not be longer than ${METADATA_LIMITS.maxValueLength} characters`;
    }
  }

  return null;
}
