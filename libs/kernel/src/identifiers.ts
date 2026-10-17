import { randomUUID } from 'node:crypto';
import { ValidationError } from './errors.js';
import { type Result, err, ok } from './result.js';

declare const brand: unique symbol;

/**
 * Nominal typing for identifiers. `UserId` and `WalletId` are both strings at
 * runtime but are not assignable to each other, which kills a whole class of
 * "passed the wrong id" bugs that plain `string` ids invite.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Builds a constructor + parser pair for one branded UUID type.
 *
 * ```ts
 * export type WalletId = Brand<string, 'WalletId'>;
 * export const WalletId = uuidBrand<WalletId>('WalletId');
 * ```
 */
export function uuidBrand<T extends Brand<string, string>>(name: string) {
  return {
    /** Trusted construction — use for values coming out of the database. */
    of(value: string): T {
      return value as T;
    },
    /** Untrusted construction — use for values coming from the network. */
    parse(value: unknown): Result<T, ValidationError> {
      if (typeof value !== 'string' || !isUuid(value)) {
        return err(new ValidationError(`${name} must be a UUID`, { value }, 'INVALID_IDENTIFIER'));
      }
      return ok(value as T);
    },
    create(): T {
      return randomUUID() as T;
    },
    name,
  } as const;
}
