import { ValidationError, ValueObject, type Result, err, isUuid, ok } from '@payhub/kernel';

/**
 * Chart of accounts, expressed as a parsed reference rather than a free
 * string. Typos become validation errors instead of a journal entry that
 * balances against an account nobody owns.
 */
export const AccountKind = {
  /** What the platform owes a user — a liability from our point of view. */
  UserAvailable: 'user_available',
  /** Authorised but not yet captured; still the user's money, just frozen. */
  UserPending: 'user_pending',
  /** Cash held at the payment provider — an asset. */
  External: 'external',
  /** Platform revenue. */
  HouseFees: 'house_fees',
  /** Clearing account used while a transfer is in flight. */
  HouseSettlement: 'house_settlement',
} as const;

export type AccountKind = (typeof AccountKind)[keyof typeof AccountKind];

/**
 * Accounting sign convention. Debits increase assets and expenses; credits
 * increase liabilities, equity and revenue. A user's balance lives in a
 * liability account, so crediting it means the user has *more* money — the
 * opposite of banking-app intuition, and the reason this is spelled out here.
 */
export const NormalBalance: Record<AccountKind, 'debit' | 'credit'> = {
  [AccountKind.UserAvailable]: 'credit',
  [AccountKind.UserPending]: 'credit',
  [AccountKind.External]: 'debit',
  [AccountKind.HouseFees]: 'credit',
  [AccountKind.HouseSettlement]: 'debit',
};

interface AccountRefProps {
  readonly kind: AccountKind;
  readonly ownerId: string | null;
  readonly currency: string;
}

export class AccountRef extends ValueObject<AccountRefProps> {
  private constructor(props: AccountRefProps) {
    super(props);
  }

  static userAvailable(userId: string, currency: string): AccountRef {
    return new AccountRef({ kind: AccountKind.UserAvailable, ownerId: userId, currency });
  }

  static userPending(userId: string, currency: string): AccountRef {
    return new AccountRef({ kind: AccountKind.UserPending, ownerId: userId, currency });
  }

  static external(provider: string, currency: string): AccountRef {
    return new AccountRef({ kind: AccountKind.External, ownerId: provider, currency });
  }

  static houseFees(currency: string): AccountRef {
    return new AccountRef({ kind: AccountKind.HouseFees, ownerId: null, currency });
  }

  static houseSettlement(currency: string): AccountRef {
    return new AccountRef({ kind: AccountKind.HouseSettlement, ownerId: null, currency });
  }

  /** `user:<uuid>:available:USD` → AccountRef */
  static parse(value: string): Result<AccountRef, ValidationError> {
    const parts = value.split(':');
    const invalid = () =>
      err(new ValidationError(`Malformed account reference: ${value}`, { value }, 'INVALID_ACCOUNT'));

    const [scope] = parts;

    if (scope === 'user') {
      const [, userId, bucket, currency] = parts;
      if (!userId || !isUuid(userId) || !currency) {
        return invalid();
      }
      if (bucket === 'available') return ok(AccountRef.userAvailable(userId, currency));
      if (bucket === 'pending') return ok(AccountRef.userPending(userId, currency));
      return invalid();
    }

    if (scope === 'external') {
      const [, provider, currency] = parts;
      return provider && currency ? ok(AccountRef.external(provider, currency)) : invalid();
    }

    if (scope === 'house') {
      const [, bucket, currency] = parts;
      if (!currency) return invalid();
      if (bucket === 'fees') return ok(AccountRef.houseFees(currency));
      if (bucket === 'settlement') return ok(AccountRef.houseSettlement(currency));
      return invalid();
    }

    return invalid();
  }

  get kind(): AccountKind {
    return this.props.kind;
  }

  get ownerId(): string | null {
    return this.props.ownerId;
  }

  get currency(): string {
    return this.props.currency;
  }

  get isUserAccount(): boolean {
    return this.props.kind === AccountKind.UserAvailable || this.props.kind === AccountKind.UserPending;
  }

  get normalBalance(): 'debit' | 'credit' {
    return NormalBalance[this.props.kind];
  }

  override toString(): string {
    switch (this.props.kind) {
      case AccountKind.UserAvailable:
        return `user:${this.props.ownerId}:available:${this.props.currency}`;
      case AccountKind.UserPending:
        return `user:${this.props.ownerId}:pending:${this.props.currency}`;
      case AccountKind.External:
        return `external:${this.props.ownerId}:${this.props.currency}`;
      case AccountKind.HouseFees:
        return `house:fees:${this.props.currency}`;
      case AccountKind.HouseSettlement:
        return `house:settlement:${this.props.currency}`;
    }
  }
}
