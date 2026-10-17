import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotFoundError } from '@payhub/kernel';
import { Transactional } from '@payhub/persistence';
import { OutboxPublisher } from '@payhub/messaging';
import { TransferPosted } from '@payhub/contracts';
import {
  JOURNAL_REPOSITORY,
  type JournalEntryRepository,
} from '../../domain/ledger/journal-entry.repository.js';
import { TransferId } from '../../domain/ledger/journal-entry.aggregate.js';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../../domain/wallet/wallet.repository.js';
import type { WalletId } from '../../domain/wallet/wallet.aggregate.js';

export interface ReverseTransferCommand {
  readonly transferId: string;
  readonly reversalId: string;
  readonly paymentId: string;
  readonly reason: string;
}

/**
 * Compensating action for the payment saga.
 *
 * A ledger is append-only, so "undo" means posting the mirror image of the
 * original entry. The original stays visible in the statement — which is the
 * behaviour auditors and support agents both need.
 */
@Injectable()
export class ReverseTransferService {
  private readonly logger = new Logger(ReverseTransferService.name);

  constructor(
    @Inject(JOURNAL_REPOSITORY) private readonly journal: JournalEntryRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    private readonly outbox: OutboxPublisher,
  ) {}

  @Transactional({ isolation: 'READ COMMITTED', retries: 2 })
  async execute(command: ReverseTransferCommand): Promise<{ status: 'reversed' | 'duplicate' }> {
    const reversalId = TransferId.of(command.reversalId);

    if (await this.journal.exists(reversalId)) {
      return { status: 'duplicate' };
    }

    const original = await this.journal.findById(TransferId.of(command.transferId));
    if (!original) {
      throw new NotFoundError('JournalEntry', command.transferId);
    }

    if (original.isReversed) {
      this.logger.debug(`Transfer ${command.transferId} is already reversed`);
      return { status: 'duplicate' };
    }

    const reversal = original.reverse(reversalId, command.reason);
    if (reversal.isErr()) {
      throw reversal.error;
    }

    // Lock the wallets the reversal touches before mutating projections.
    const identities = new Map<string, { userId: string; currency: string }>();
    for (const line of reversal.value.lines) {
      if (line.account.isUserAccount && line.account.ownerId) {
        identities.set(`${line.account.ownerId}:${line.account.currency}`, {
          userId: line.account.ownerId,
          currency: line.account.currency,
        });
      }
    }

    const walletIds: WalletId[] = [];
    for (const identity of identities.values()) {
      const wallet = await this.wallets.findByUserAndCurrency(identity.userId, identity.currency);
      if (wallet) {
        walletIds.push(wallet.id);
      }
    }

    const locked = await this.wallets.lockMany(
      walletIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );

    for (const line of reversal.value.lines) {
      if (!line.account.isUserAccount || !line.account.ownerId) {
        continue;
      }
      const wallet = [...locked.values()].find(
        (candidate) =>
          candidate.userId === line.account.ownerId &&
          candidate.currency === line.account.currency,
      );
      if (!wallet) {
        continue;
      }

      const bucket = line.account.kind === 'user_pending' ? 'pending' : 'available';
      const applied = wallet.applyPosting(bucket, line.direction, line.amount);
      if (applied.isErr()) {
        // A reversal that cannot be applied means the user already spent the
        // money. That is a recovery case for operations, not something to
        // silently swallow.
        throw applied.error;
      }
      await this.wallets.save(wallet);
    }

    await this.journal.append(reversal.value);
    await this.journal.markReversed(original.id, reversalId);

    await this.outbox.publish(
      TransferPosted,
      {
        transferId: reversalId,
        paymentId: command.paymentId,
        userId: original.userId ?? '',
        purpose: 'reversal',
        lines: reversal.value.lines.map((line) => ({
          account: line.account.toString(),
          direction: line.direction,
          amount: line.amount.toJSON(),
        })),
        postedAt: reversal.value.postedAt.toISOString(),
      },
      { aggregateType: 'JournalEntry', aggregateId: reversalId, partitionKey: command.paymentId },
    );

    this.logger.log(`Reversed transfer ${command.transferId} as ${reversalId}`);
    return { status: 'reversed' };
  }
}
