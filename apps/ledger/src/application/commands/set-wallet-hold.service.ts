import { Inject, Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@payhub/persistence';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../../domain/wallet/wallet.repository.js';
import type { Wallet } from '../../domain/wallet/wallet.aggregate.js';

export interface SetWalletHoldCommand {
  readonly userId: string;
  /** Omitted applies to every currency the user holds. */
  readonly currency?: string | undefined;
  readonly frozen: boolean;
  readonly reason: string;
  readonly actorUserId: string;
}

export interface SetWalletHoldResult {
  readonly affected: number;
  readonly walletIds: readonly string[];
}

/**
 * Freezes a user's wallets, or releases them.
 *
 * Everything this needs already existed. The ledger refuses a transfer
 * out of a frozen wallet, the aggregate has `freeze()` and
 * `unfreeze()`, there is a `WalletFrozen` event, the status column
 * permits it and `wallet:freeze` sits in the permission matrix. The
 * only missing piece was something that called them — so the one
 * control a payments platform reaches for during a fraud alert could
 * not be reached at all.
 *
 * Idempotent by construction: the aggregate's `freeze()` returns early
 * when the wallet is already frozen, so a redelivered command is a
 * no-op rather than a second event.
 *
 * Locked for update, like every other write that touches a wallet. A
 * freeze racing a transfer must not interleave with it — the point of
 * the freeze is that the transfer either happened before it or is
 * refused by it, never half of each.
 */
@Injectable()
export class SetWalletHoldService {
  private readonly logger = new Logger(SetWalletHoldService.name);

  constructor(@Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository) {}

  @Transactional()
  async execute(command: SetWalletHoldCommand): Promise<SetWalletHoldResult> {
    const candidates = await this.wallets.findAllByUser(command.userId);
    const scoped = command.currency
      ? candidates.filter((wallet) => wallet.currency === command.currency)
      : candidates;

    if (scoped.length === 0) {
      return { affected: 0, walletIds: [] };
    }

    // Deterministic order, taken the same way every other multi-wallet
    // write takes it: two operations locking the same pair in opposite
    // orders is the textbook deadlock.
    const locked = await this.wallets.lockMany(scoped.map((wallet) => wallet.id));

    const changed: Wallet[] = [];
    for (const wallet of locked.values()) {
      const before = wallet.status;

      if (command.frozen) {
        wallet.freeze(command.reason);
      } else {
        wallet.unfreeze();
      }

      if (wallet.status !== before) {
        await this.wallets.save(wallet);
        changed.push(wallet);
      }
    }

    this.logger.log(
      `${command.frozen ? 'Froze' : 'Released'} ${changed.length} wallet(s) for user ` +
        `${command.userId} by ${command.actorUserId}: ${command.reason}`,
    );

    return { affected: changed.length, walletIds: changed.map((wallet) => wallet.id) };
  }
}
