import {
  AggregateRoot,
  type Brand,
  DomainEvent,
  Money,
  type Result,
  err,
  ok,
  uuidBrand,
} from '@payhub/kernel';
import {
  InsufficientFundsError,
  WalletClosedError,
  WalletFrozenError,
} from '../ledger/ledger.errors.js';

export type WalletId = Brand<string, 'WalletId'>;
export const WalletId = uuidBrand<WalletId>('WalletId');

export const WalletStatus = {
  Active: 'active',
  /** Compliance hold: reads work, money does not move. */
  Frozen: 'frozen',
  Closed: 'closed',
} as const;

export type WalletStatus = (typeof WalletStatus)[keyof typeof WalletStatus];

export type WalletMovementError = InsufficientFundsError | WalletFrozenError | WalletClosedError;

interface WalletProps {
  readonly userId: string;
  readonly currency: string;
  available: Money;
  pending: Money;
  status: WalletStatus;
  readonly createdAt: Date;
  updatedAt: Date;
}

/**
 * Wallet aggregate — the consistency boundary for one user's money in one
 * currency.
 *
 * The wallet row is a *projection* of the journal: the authoritative balance
 * is the sum of the postings, and this aggregate exists so a balance check
 * does not have to aggregate a million rows on every request. The
 * reconciliation job compares the two and alerts on drift, which is why the
 * projection is allowed to exist at all.
 *
 * Two independent protections against double-spend:
 *   • pessimistic `SELECT … FOR UPDATE` on this row inside the posting
 *     transaction, which serialises concurrent debits of the same wallet;
 *   • an optimistic `version` column, which catches a lost update if a code
 *     path ever forgets the lock.
 */
export class Wallet extends AggregateRoot<WalletId> {
  private constructor(
    id: WalletId,
    private readonly props: WalletProps,
  ) {
    super(id);
  }

  static open(input: { id: WalletId; userId: string; currency: string; now?: Date }): Wallet {
    const now = input.now ?? new Date();
    const wallet = new Wallet(input.id, {
      userId: input.userId,
      currency: input.currency,
      available: Money.zero(input.currency),
      pending: Money.zero(input.currency),
      status: WalletStatus.Active,
      createdAt: now,
      updatedAt: now,
    });

    wallet.raise(new WalletOpened(wallet));
    return wallet;
  }

  static rehydrate(id: WalletId, props: WalletProps, version: number): Wallet {
    const wallet = new Wallet(id, props);
    wallet.setVersion(version);
    return wallet;
  }

  // --- behaviour ----------------------------------------------------------

  /** Money arrives: a deposit lands, or a refund is paid back in. */
  credit(amount: Money): Result<void, WalletMovementError> {
    const guard = this.assertMovable();
    if (guard.isErr()) {
      return guard;
    }
    this.assertCurrency(amount);

    this.props.available = this.props.available.add(amount);
    this.touch();
    this.raise(new WalletBalanceChanged(this));
    return ok(undefined);
  }

  /** Money leaves immediately — only valid when the funds are available. */
  debit(amount: Money): Result<void, WalletMovementError> {
    const guard = this.assertMovable();
    if (guard.isErr()) {
      return guard;
    }
    this.assertCurrency(amount);

    if (this.props.available.lessThan(amount)) {
      return err(new InsufficientFundsError(this.id, this.props.available, amount));
    }

    this.props.available = this.props.available.subtract(amount);
    this.touch();
    this.raise(new WalletBalanceChanged(this));
    return ok(undefined);
  }

  /**
   * Authorisation: the amount is reserved but still belongs to the user.
   * Modelled explicitly so a pending withdrawal cannot be spent twice while
   * the provider is still deciding.
   */
  hold(amount: Money): Result<void, WalletMovementError> {
    const guard = this.assertMovable();
    if (guard.isErr()) {
      return guard;
    }
    this.assertCurrency(amount);

    if (this.props.available.lessThan(amount)) {
      return err(new InsufficientFundsError(this.id, this.props.available, amount));
    }

    this.props.available = this.props.available.subtract(amount);
    this.props.pending = this.props.pending.add(amount);
    this.touch();
    this.raise(new WalletBalanceChanged(this));
    return ok(undefined);
  }

  /** Capture settles a hold: the held money finally leaves the wallet. */
  capture(amount: Money): Result<void, WalletMovementError> {
    const guard = this.assertMovable();
    if (guard.isErr()) {
      return guard;
    }
    this.assertCurrency(amount);

    if (this.props.pending.lessThan(amount)) {
      return err(new InsufficientFundsError(this.id, this.props.pending, amount));
    }

    this.props.pending = this.props.pending.subtract(amount);
    this.touch();
    this.raise(new WalletBalanceChanged(this));
    return ok(undefined);
  }

  /** The authorisation expired or was cancelled: give the money back. */
  release(amount: Money): Result<void, WalletMovementError> {
    const guard = this.assertMovable();
    if (guard.isErr()) {
      return guard;
    }
    this.assertCurrency(amount);

    if (this.props.pending.lessThan(amount)) {
      return err(new InsufficientFundsError(this.id, this.props.pending, amount));
    }

    this.props.pending = this.props.pending.subtract(amount);
    this.props.available = this.props.available.add(amount);
    this.touch();
    this.raise(new WalletBalanceChanged(this));
    return ok(undefined);
  }

  /**
   * Low-level application of one journal posting to this wallet.
   *
   * The semantic methods above are the vocabulary the application layer uses;
   * this is the mechanical counterpart the ledger uses when replaying a
   * balanced entry, so the projection can never diverge from the postings by
   * construction.
   */
  applyPosting(
    bucket: 'available' | 'pending',
    direction: 'debit' | 'credit',
    amount: Money,
  ): Result<void, WalletMovementError> {
    const guard = this.assertMovable();
    if (guard.isErr()) {
      return guard;
    }
    this.assertCurrency(amount);

    const current = bucket === 'available' ? this.props.available : this.props.pending;

    // User buckets are liability accounts: a credit increases what we owe.
    const next = direction === 'credit' ? current.add(amount) : current.subtract(amount);

    if (next.isNegative()) {
      return err(new InsufficientFundsError(this.id, current, amount));
    }

    if (bucket === 'available') {
      this.props.available = next;
    } else {
      this.props.pending = next;
    }

    this.touch();
    this.raise(new WalletBalanceChanged(this));
    return ok(undefined);
  }

  freeze(reason: string): void {
    if (this.props.status === WalletStatus.Frozen) {
      return;
    }
    this.props.status = WalletStatus.Frozen;
    this.touch();
    this.raise(new WalletFrozen(this, reason));
  }

  unfreeze(): void {
    if (this.props.status !== WalletStatus.Frozen) {
      return;
    }
    this.props.status = WalletStatus.Active;
    this.touch();
  }

  close(): Result<void, WalletMovementError> {
    if (this.props.status === WalletStatus.Closed) {
      return ok(undefined);
    }
    if (!this.total.isZero()) {
      return err(new WalletFrozenError(this.id));
    }
    this.props.status = WalletStatus.Closed;
    this.touch();
    return ok(undefined);
  }

  /** Replaces the projection with the authoritative value from the journal. */
  reconcileTo(available: Money, pending: Money): void {
    this.props.available = available;
    this.props.pending = pending;
    this.touch();
  }

  // --- accessors ----------------------------------------------------------

  get userId(): string {
    return this.props.userId;
  }

  get currency(): string {
    return this.props.currency;
  }

  get available(): Money {
    return this.props.available;
  }

  get pending(): Money {
    return this.props.pending;
  }

  get total(): Money {
    return this.props.available.add(this.props.pending);
  }

  get status(): WalletStatus {
    return this.props.status;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  // --- guards -------------------------------------------------------------

  private assertMovable(): Result<void, WalletMovementError> {
    if (this.props.status === WalletStatus.Frozen) {
      return err(new WalletFrozenError(this.id));
    }
    if (this.props.status === WalletStatus.Closed) {
      return err(new WalletClosedError(this.id));
    }
    return ok(undefined);
  }

  private assertCurrency(amount: Money): void {
    if (amount.currencyCode !== this.props.currency) {
      // A programming error, not a user-facing one: the application layer
      // must route the command to the wallet of the right currency.
      throw new Error(
        `Wallet ${this.id} is in ${this.props.currency}, received ${amount.currencyCode}`,
      );
    }
  }

  private touch(): void {
    this.props.updatedAt = new Date();
  }
}

// --- domain events --------------------------------------------------------

export class WalletOpened extends DomainEvent {
  readonly eventName = 'ledger.wallet_opened.v1';
  readonly aggregateType = 'Wallet';

  constructor(private readonly wallet: Wallet) {
    super();
  }

  get aggregateId(): string {
    return this.wallet.id;
  }

  payload(): Record<string, unknown> {
    return {
      walletId: this.wallet.id,
      userId: this.wallet.userId,
      currency: this.wallet.currency,
    };
  }
}

export class WalletBalanceChanged extends DomainEvent {
  readonly eventName = 'ledger.wallet_balance_changed.v1';
  readonly aggregateType = 'Wallet';

  constructor(private readonly wallet: Wallet) {
    super();
  }

  get aggregateId(): string {
    return this.wallet.id;
  }

  payload(): Record<string, unknown> {
    return {
      walletId: this.wallet.id,
      userId: this.wallet.userId,
      available: this.wallet.available.toJSON(),
      pending: this.wallet.pending.toJSON(),
      version: this.wallet.version,
      changedAt: this.wallet.updatedAt.toISOString(),
    };
  }
}

export class WalletFrozen extends DomainEvent {
  readonly eventName = 'ledger.wallet_frozen.v1';
  readonly aggregateType = 'Wallet';

  constructor(
    private readonly wallet: Wallet,
    private readonly reason: string,
  ) {
    super();
  }

  get aggregateId(): string {
    return this.wallet.id;
  }

  payload(): Record<string, unknown> {
    return { walletId: this.wallet.id, userId: this.wallet.userId, reason: this.reason };
  }
}
