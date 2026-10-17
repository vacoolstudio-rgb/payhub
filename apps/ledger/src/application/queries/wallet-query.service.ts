import { Inject, Injectable } from '@nestjs/common';
import { type CursorPage, Money, NotFoundError } from '@payhub/kernel';
import { CacheService } from '@payhub/redis';
import { Transactional } from '@payhub/persistence';
import {
  JOURNAL_REPOSITORY,
  type JournalEntryRepository,
  type StatementFilter,
  type StatementRow,
} from '../../domain/ledger/journal-entry.repository.js';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../../domain/wallet/wallet.repository.js';
import { WalletId } from '../../domain/wallet/wallet.aggregate.js';

export interface WalletView {
  readonly id: string;
  readonly userId: string;
  readonly currency: string;
  readonly available: string;
  readonly pending: string;
  readonly total: string;
  readonly status: string;
  readonly version: number;
  readonly updatedAt: string;
}

/**
 * Read side. Deliberately separate from the command services: it is allowed
 * to hit a cache, skip the aggregates and return flat view models, none of
 * which the write side may do.
 */
@Injectable()
export class WalletQueryService {
  private static readonly CACHE_TTL_SEC = 15;

  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(JOURNAL_REPOSITORY) private readonly journal: JournalEntryRepository,
    private readonly cache: CacheService,
  ) {}

  /**
   * Balances are cached for a few seconds only.
   *
   * A stale balance is a support ticket, so the TTL is short and every write
   * path invalidates the key explicitly. The cache exists for the dashboard
   * poll and the GraphQL fan-out, not to hide a slow query.
   */
  async getBalances(userId: string): Promise<WalletView[]> {
    const cached = await this.cache.getOrSet<WalletView[]>(
      `wallet:balances:${userId}`,
      async () => {
        const wallets = await this.wallets.findAllByUser(userId);
        return wallets.map(toView);
      },
      // Balances are the hottest read in the platform, and the dashboard
      // asks for them several times per render.
      { ttlSec: WalletQueryService.CACHE_TTL_SEC, negativeTtlSec: 5, l1: true },
    );

    return cached ?? [];
  }

  async invalidate(userId: string): Promise<void> {
    await this.cache.del(`wallet:balances:${userId}`);
  }

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.wallets.findById(WalletId.of(walletId));
    if (!wallet) {
      throw new NotFoundError('Wallet', walletId);
    }
    return toView(wallet);
  }

  async getStatement(filter: StatementFilter): Promise<CursorPage<StatementRow>> {
    return this.journal.statement(filter);
  }

  /**
   * Authoritative balance, recomputed from the journal. Slow by design and
   * used by reconciliation and support tooling, never on the hot path.
   */
  @Transactional({ propagation: 'REQUIRES_NEW', readOnly: true })
  async recomputeFromJournal(
    walletId: string,
  ): Promise<{ available: Money; pending: Money; projected: WalletView }> {
    const id = WalletId.of(walletId);
    const wallet = await this.wallets.findById(id);
    if (!wallet) {
      throw new NotFoundError('Wallet', walletId);
    }

    const authoritative = await this.wallets.computeBalanceFromJournal(id);
    return { ...authoritative, projected: toView(wallet) };
  }
}

function toView(wallet: {
  id: string;
  userId: string;
  currency: string;
  available: Money;
  pending: Money;
  total: Money;
  status: string;
  version: number;
  updatedAt: Date;
}): WalletView {
  return {
    id: wallet.id,
    userId: wallet.userId,
    currency: wallet.currency,
    available: wallet.available.toMajorString(),
    pending: wallet.pending.toMajorString(),
    total: wallet.total.toMajorString(),
    status: wallet.status,
    version: wallet.version,
    updatedAt: wallet.updatedAt.toISOString(),
  };
}
