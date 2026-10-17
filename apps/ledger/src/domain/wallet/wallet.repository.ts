import type { Money } from '@payhub/kernel';
import type { Wallet, WalletId } from './wallet.aggregate.js';

export interface WalletIdentity {
  readonly userId: string;
  readonly currency: string;
}

export const WALLET_REPOSITORY = Symbol.for('payhub:WalletRepository');

/**
 * Port owned by the domain; the TypeORM implementation lives in
 * `infrastructure` and depends on this, never the other way round.
 */
export interface WalletRepository {
  findById(id: WalletId): Promise<Wallet | null>;
  findByUserAndCurrency(userId: string, currency: string): Promise<Wallet | null>;
  findAllByUser(userId: string): Promise<Wallet[]>;

  /**
   * Loads the wallet with a row-level write lock.
   *
   * Must be called inside a transaction. Locks are always taken in a
   * deterministic order (see `lockMany`) — two transfers touching the same
   * pair of wallets in opposite orders is the textbook deadlock.
   */
  findByIdForUpdate(id: WalletId): Promise<Wallet | null>;

  /** Locks several wallets at once, ordered by id to avoid deadlocks. */
  lockMany(ids: readonly WalletId[]): Promise<Map<WalletId, Wallet>>;

  /** Opens the wallet if it does not exist yet, atomically. */
  findOrOpen(userId: string, currency: string): Promise<Wallet>;

  /**
   * Batched `findOrOpen`.
   *
   * A transfer touches two wallets, a refund with a fee three. Calling
   * `findOrOpen` per participant is two to three round trips each, all of
   * them inside the business transaction and therefore all of them adding
   * to the time the row locks are held. This does it in three statements
   * regardless of how many wallets are involved.
   */
  ensureMany(identities: ReadonlyArray<WalletIdentity>): Promise<Wallet[]>;

  /** Persists with an optimistic-version check. */
  save(wallet: Wallet): Promise<void>;

  /** Authoritative balance recomputed from the journal, for reconciliation. */
  computeBalanceFromJournal(id: WalletId): Promise<{ available: Money; pending: Money }>;
}
