import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type DomainError,
  Money,
  type Result,
  ValidationError,
  err,
  ok,
} from '@payhub/kernel';
import { Transactional } from '@payhub/persistence';
import { OutboxPublisher } from '@payhub/messaging';
import { MetricsService } from '@payhub/observability';
import {
  type LedgerOperation,
  type LedgerRejectionReason,
  type MoneyDto,
  TransferPosted,
  TransferRejected,
  WalletBalanceChanged as WalletBalanceChangedContract,
} from '@payhub/contracts';
import { TransferPlanner } from '../../domain/ledger/transfer-planner.service.js';
import {
  JOURNAL_REPOSITORY,
  type JournalEntryRepository,
} from '../../domain/ledger/journal-entry.repository.js';
import {
  JournalEntry,
  type PostingLine,
  TransferId,
  TransferPurpose,
} from '../../domain/ledger/journal-entry.aggregate.js';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../../domain/wallet/wallet.repository.js';
import type { Wallet, WalletId } from '../../domain/wallet/wallet.aggregate.js';

export interface PostTransferCommand {
  readonly transferId: string;
  readonly paymentId: string;
  readonly userId: string;
  readonly counterpartyUserId: string | null;
  readonly merchantId: string;
  readonly operation: LedgerOperation;
  readonly amount: MoneyDto;
  readonly fee: MoneyDto;
  readonly provider: string;
  readonly description: string;
}

export type PostTransferOutcome =
  | { readonly status: 'posted'; readonly transferId: string }
  | { readonly status: 'duplicate'; readonly transferId: string }
  | { readonly status: 'rejected'; readonly reason: LedgerRejectionReason; readonly detail: string };

/**
 * The write side of the ledger.
 *
 * Everything below happens in **one** database transaction: the duplicate
 * check, the wallet locks, the balance updates, the journal insert and the
 * outbox row. Either the money moved and the rest of the platform will hear
 * about it, or nothing happened at all.
 *
 * Rejections are a normal outcome, not an exception: the transaction still
 * commits, carrying the inbox row (so the command is not redelivered) and a
 * `transfer_rejected` event (so the payment saga can fail the payment).
 * Throwing here would roll both back and the saga would hang forever.
 */
@Injectable()
export class PostTransferService {
  private readonly logger = new Logger(PostTransferService.name);

  constructor(
    @Inject(JOURNAL_REPOSITORY) private readonly journal: JournalEntryRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    private readonly planner: TransferPlanner,
    private readonly outbox: OutboxPublisher,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * READ COMMITTED is enough because the critical rows are locked explicitly
   * with `SELECT … FOR UPDATE`. A higher isolation level would add
   * serialization failures without adding protection the row locks do not
   * already give — and retrying a payment is more expensive than a lock wait.
   */
  @Transactional({ isolation: 'READ COMMITTED', retries: 2 })
  async execute(command: PostTransferCommand): Promise<PostTransferOutcome> {
    const transferId = TransferId.of(command.transferId);

    // 1 — Idempotency. The transfer id is the natural key: the same command
    //     replayed by Kafka must not post the entry twice.
    if (await this.journal.exists(transferId)) {
      this.logger.debug(`Transfer ${transferId} already posted — ignoring replay`);
      return { status: 'duplicate', transferId };
    }

    // 2 — Turn the business operation into balanced postings. The chart of
    //     accounts lives here and nowhere else.
    const parsed = this.plan(command);
    if (parsed.isErr()) {
      return this.reject(command, reasonFor(parsed.error), parsed.error.message);
    }

    // 3 — Build the entry; the aggregate refuses to exist if it is unbalanced.
    const entry = JournalEntry.create({
      id: transferId,
      paymentId: command.paymentId,
      userId: command.userId,
      purpose: PURPOSE_BY_OPERATION[command.operation],
      description: command.description,
      lines: parsed.value,
    });

    if (entry.isErr()) {
      return this.reject(command, 'unbalanced_entry', entry.error.message);
    }

    // 4 — Lock every wallet the entry touches, in a deterministic order.
    const affected = await this.lockAffectedWallets(parsed.value);
    if (affected.isErr()) {
      return this.reject(command, 'wallet_not_found', affected.error.message);
    }

    // 5 — Apply postings to the projections. Any violated invariant aborts
    //     the whole entry: a half-applied journal entry is unthinkable.
    const applied = this.applyToWallets(parsed.value, affected.value);
    if (applied.isErr()) {
      return this.reject(command, reasonFor(applied.error), applied.error.message);
    }

    // 6 — Persist. The journal is the source of truth, the wallets a cache.
    await this.journal.append(entry.value);
    for (const wallet of affected.value.values()) {
      await this.wallets.save(wallet);
    }

    // 7 — Tell the world, transactionally.
    await this.outbox.publish(
      TransferPosted,
      {
        transferId,
        paymentId: command.paymentId,
        userId: command.userId,
        purpose: PURPOSE_BY_OPERATION[command.operation],
        lines: entry.value.lines.map((line) => ({
          account: line.account.toString(),
          direction: line.direction,
          amount: line.amount.toJSON(),
        })),
        postedAt: entry.value.postedAt.toISOString(),
      },
      { aggregateType: 'JournalEntry', aggregateId: transferId, partitionKey: command.paymentId },
    );

    for (const wallet of affected.value.values()) {
      await this.outbox.publish(
        WalletBalanceChangedContract,
        {
          walletId: wallet.id,
          userId: wallet.userId,
          available: wallet.available.toJSON(),
          pending: wallet.pending.toJSON(),
          version: wallet.version,
          changedAt: wallet.updatedAt.toISOString(),
        },
        { aggregateType: 'Wallet', aggregateId: wallet.id },
      );
    }

    this.metrics.ledgerPostings.inc({ purpose: command.operation, outcome: 'posted' });
    this.logger.log(
      `Posted ${command.operation} transfer ${transferId} for payment ${command.paymentId}`,
    );

    return { status: 'posted', transferId };
  }

  // --- steps --------------------------------------------------------------

  private plan(command: PostTransferCommand): Result<PostingLine[], ValidationError> {
    let amount: Money;
    let fee: Money;

    try {
      amount = Money.fromMinor(command.amount.amount, command.amount.currency);
      fee = Money.fromMinor(command.fee.amount, command.fee.currency);
    } catch (error) {
      return err(
        error instanceof ValidationError
          ? error
          : new ValidationError('Invalid amount in command', {}, 'INVALID_AMOUNT'),
      );
    }

    switch (command.operation) {
      case 'deposit':
        return this.planner.planDeposit({
          userId: command.userId,
          amount,
          fee,
          provider: command.provider,
        });

      case 'withdrawal':
        return this.planner.planWithdrawal({
          userId: command.userId,
          amount,
          fee,
          provider: command.provider,
        });

      case 'transfer':
        if (!command.counterpartyUserId) {
          return err(
            new ValidationError('A transfer needs a counterparty', {}, 'COUNTERPARTY_REQUIRED'),
          );
        }
        return this.planner.planTransfer({
          fromUserId: command.userId,
          toUserId: command.counterpartyUserId,
          amount,
          fee,
        });

      case 'refund':
        return this.planner.planRefund({
          userId: command.userId,
          amount,
          provider: command.provider,
          refundFee: fee,
        });
    }
  }

  /**
   * Deadlock avoidance: wallets are locked in ascending id order, always.
   * Two concurrent transfers A→B and B→A would otherwise each hold the lock
   * the other needs. Postgres would detect the deadlock and kill one of them,
   * but a predictable order means it never happens in the first place.
   */
  private async lockAffectedWallets(
    lines: readonly PostingLine[],
  ): Promise<Result<Map<WalletId, Wallet>, ValidationError>> {
    const userAccounts = lines.filter((line) => line.account.isUserAccount);
    const identities = new Map<string, { userId: string; currency: string }>();

    for (const line of userAccounts) {
      const userId = line.account.ownerId;
      if (!userId) {
        return err(new ValidationError('User account without an owner', {}, 'INVALID_ACCOUNT'));
      }
      identities.set(`${userId}:${line.account.currency}`, {
        userId,
        currency: line.account.currency,
      });
    }

    // Open-on-demand, batched: a first deposit must not fail because no
    // wallet row exists yet, and doing it one participant at a time would
    // add round trips to the window in which row locks are held.
    const wallets = await this.wallets.ensureMany([...identities.values()]);

    const locked = await this.wallets.lockMany(
      wallets.map((wallet) => wallet.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );

    return ok(locked);
  }

  private applyToWallets(
    lines: readonly PostingLine[],
    wallets: Map<WalletId, Wallet>,
  ): Result<void, DomainError> {
    const byIdentity = new Map<string, Wallet>();
    for (const wallet of wallets.values()) {
      byIdentity.set(`${wallet.userId}:${wallet.currency}`, wallet);
    }

    for (const line of lines) {
      if (!line.account.isUserAccount) {
        // House and external accounts have no projection row; their balance
        // is derived from the journal on demand.
        continue;
      }

      const wallet = byIdentity.get(`${line.account.ownerId}:${line.account.currency}`);
      if (!wallet) {
        return err(
          new ValidationError(
            `No wallet for ${line.account.toString()}`,
            { account: line.account.toString() },
            'WALLET_NOT_FOUND',
          ),
        );
      }

      const bucket = line.account.kind === 'user_pending' ? 'pending' : 'available';
      const applied = wallet.applyPosting(bucket, line.direction, line.amount);

      if (applied.isErr()) {
        return err(applied.error);
      }
    }

    return ok(undefined);
  }

  private async reject(
    command: PostTransferCommand,
    reason: LedgerRejectionReason,
    detail: string,
  ): Promise<PostTransferOutcome> {
    this.logger.warn(
      `Rejected transfer ${command.transferId} for payment ${command.paymentId}: ${reason} — ${detail}`,
    );

    await this.outbox.publish(
      TransferRejected,
      {
        transferId: command.transferId,
        paymentId: command.paymentId,
        userId: command.userId,
        reason,
        detail: detail.slice(0, 500),
        rejectedAt: new Date().toISOString(),
      },
      {
        aggregateType: 'JournalEntry',
        aggregateId: command.transferId,
        partitionKey: command.paymentId,
      },
    );

    this.metrics.ledgerPostings.inc({ purpose: command.operation, outcome: 'rejected' });

    return { status: 'rejected', reason, detail };
  }
}

function reasonFor(error: DomainError): LedgerRejectionReason {
  switch (error.code) {
    case 'INSUFFICIENT_FUNDS':
      return 'insufficient_funds';
    case 'WALLET_FROZEN':
    case 'WALLET_CLOSED':
      return 'wallet_frozen';
    case 'CURRENCY_MISMATCH':
      return 'currency_mismatch';
    case 'WALLET_NOT_FOUND':
      return 'wallet_not_found';
    default:
      return 'unbalanced_entry';
  }
}

/** Business operation → accounting purpose recorded on the journal entry. */
const PURPOSE_BY_OPERATION: Record<LedgerOperation, TransferPurpose> = {
  deposit: TransferPurpose.Capture,
  withdrawal: TransferPurpose.Capture,
  transfer: TransferPurpose.Capture,
  refund: TransferPurpose.Refund,
};
