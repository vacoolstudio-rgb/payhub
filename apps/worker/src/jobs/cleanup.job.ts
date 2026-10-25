import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  InboxRepository,
  OutboxRepository,
  TransactionManager,
  Transactional,
} from '@payhub/persistence';
import { DistributedLockService } from '@payhub/redis';
import { DEDUPLICATION_RETENTION_MS } from '@payhub/messaging';

/**
 * Retention.
 *
 * Three tables grow forever if nobody prunes them, and all three are
 * append-mostly infrastructure rather than business records:
 *
 *  • `outbox_messages` — published rows are kept briefly so an operator can
 *    answer "was this event actually emitted?" and then dropped.
 *  • `processed_messages` — the inbox only needs to remember a message
 *    id for longer than the broker keeps the message. That reasoning was
 *    right and the number was not: fourteen days, chosen independently,
 *    against a dead-letter topic that holds messages for thirty. A DLQ
 *    replay is something a person does after an investigation, which is
 *    precisely the delay that retention exists to cover — so between day
 *    fourteen and day thirty a replay arrived with nothing left to
 *    recognise it. The cutoff is now derived from the retention it has
 *    to outlive rather than guessed next to it.
 *  • `refresh_sessions` — an expired session cannot be used; keeping it
 *    only makes the unique index bigger.
 *
 * Deliberately *not* pruned: payments, journal entries, postings. Those are
 * financial records with a legal retention period, and archiving them is a
 * different conversation from garbage collection.
 */
@Injectable()
export class CleanupJob {
  private readonly logger = new Logger(CleanupJob.name);

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly inbox: InboxRepository,
    private readonly transactions: TransactionManager,
    private readonly locks: DistributedLockService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'retention-cleanup' })
  async run(): Promise<void> {
    await this.locks.withLock(
      'cron:retention-cleanup',
      { ttlMs: 5 * 60_000, waitMs: 0, autoExtend: true },
      async () => this.prune(),
    );
  }

  @Transactional()
  private async prune(): Promise<void> {
    const now = Date.now();

    const publishedRemoved = await this.outbox.purgePublishedBefore(
      new Date(now - 7 * 86_400_000),
    );
    const inboxRemoved = await this.inbox.purgeBefore(
      new Date(now - DEDUPLICATION_RETENTION_MS),
    );

    const sessions = (await this.transactions.manager.query(
      `DELETE FROM payhub.refresh_sessions
       WHERE expires_at < now() - interval '7 days'
       RETURNING id`,
    )) as unknown[];

    if (publishedRemoved + inboxRemoved + sessions.length > 0) {
      this.logger.log(
        `Retention sweep: outbox=${publishedRemoved}, inbox=${inboxRemoved}, sessions=${sessions.length}`,
      );
    }
  }
}
