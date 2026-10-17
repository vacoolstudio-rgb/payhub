import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { type ResilienceConfig, resilienceConfig } from '@payhub/config';
import { type LedgerOperation, PaymentFailed, PostTransferCommand } from '@payhub/contracts';
import { OutboxPublisher } from '@payhub/messaging';
import {
  AdvisoryLockService,
  TransactionManager,
  Transactional,
  normaliseReturning,
} from '@payhub/persistence';
import { DistributedLockService } from '@payhub/redis';
import { MetricsService } from '@payhub/observability';

interface StalePaymentRow {
  id: string;
  merchant_id: string;
  user_id: string;
  direction: string;
  amount_minor: string;
  fee_minor: string;
  currency: string;
  reference: string;
  status: string;
  method: string;
  counterparty_user_id: string | null;
  transfer_id: string | null;
  refund_transfer_id: string | null;
  refund_amount_minor: string | null;
}

/**
 * Compensation jobs.
 *
 * Both of the distributed-locking strategies the platform uses are on
 * display here, applied where each one is actually appropriate:
 *
 *  • **Redis lock** for the expiry sweep. Running it twice would be
 *    wasteful, not wrong (every action underneath is idempotent), so an
 *    efficiency lock is the right trade — cheap, fast, no database
 *    connection held for the duration.
 *
 *  • **Postgres advisory lock** for the stuck-payment sweep, which issues
 *    compensating commands. Here a double run is a correctness concern, and
 *    the advisory lock lives in the same system as the data: it is released
 *    by the same commit that makes the work visible, so there is no window
 *    where the lease expired but the transaction is still in flight.
 *    Redlock cannot give that guarantee — see `DistributedLockService` for
 *    the longer argument.
 */
@Injectable()
export class PaymentExpiryJob {
  private readonly logger = new Logger(PaymentExpiryJob.name);

  constructor(
    // The ambient transaction, not a fresh pool connection — see the note
    // in LedgerReconciliationJob for why this distinction is not cosmetic.
    private readonly transactions: TransactionManager,
    private readonly locks: DistributedLockService,
    private readonly advisoryLocks: AdvisoryLockService,
    private readonly outbox: OutboxPublisher,
    private readonly metrics: MetricsService,
    @Inject(resilienceConfig.KEY) private readonly config: ResilienceConfig,
  ) {}

  /**
   * Fails authorisations whose window elapsed.
   *
   * `@Cron` fires on *every* replica — that is the N-instances problem the
   * lock exists to solve. Without it, three pods would each try to expire
   * the same payments and race on the row locks.
   */
  @Cron('*/1 * * * *', { name: 'payment-expiry' })
  async expireStalePayments(): Promise<void> {
    const outcome = await this.locks.withLock(
      'cron:payment-expiry',
      { ttlMs: this.config.distributedLockTtlMs, waitMs: 0, autoExtend: true },
      async () => this.runExpiry(),
    );

    if (outcome === null) {
      this.logger.debug('Expiry sweep is running on another instance');
    }
  }

  @Transactional()
  private async runExpiry(): Promise<number> {
    // `FOR UPDATE SKIP LOCKED` lets the sweep make progress even if a
    // payment is being written by an API request right now.
    const rows = normaliseReturning<StalePaymentRow>(
      await this.transactions.manager.query(
      `
      WITH stale AS (
        SELECT id FROM payhub.payments
        WHERE expires_at < now()
          AND status IN ('pending', 'authorized')
        ORDER BY expires_at
        LIMIT 200
        FOR UPDATE SKIP LOCKED
      )
      UPDATE payhub.payments AS p
      SET status = 'failed',
          failure_reason = 'expired',
          failure_detail = 'Authorisation window elapsed',
          settled_at = now(),
          updated_at = now(),
          version = p.version + 1
      FROM stale
      WHERE p.id = stale.id
      RETURNING p.id, p.merchant_id, p.user_id, p.direction, p.amount_minor,
                p.fee_minor, p.currency, p.reference, p.status, p.method,
                p.counterparty_user_id, p.transfer_id
      `,
      ),
    );

    for (const row of rows) {
      await this.outbox.publish(
        PaymentFailed,
        {
          paymentId: row.id,
          merchantId: row.merchant_id,
          userId: row.user_id,
          direction: row.direction as 'deposit' | 'withdrawal' | 'transfer',
          amount: { amount: row.amount_minor, currency: row.currency },
          fee: { amount: row.fee_minor, currency: row.currency },
          reference: row.reference,
          reason: 'expired',
          detail: 'Authorisation window elapsed',
          failedAt: new Date().toISOString(),
        },
        { aggregateType: 'Payment', aggregateId: row.id },
      );

      this.metrics.paymentsTotal.inc({
        direction: row.direction,
        status: 'expired',
        currency: row.currency,
      });
    }

    if (rows.length > 0) {
      this.logger.log(`Expired ${rows.length} stale payment(s)`);
    }

    return rows.length;
  }

  /**
   * Payments that reached `capturing` and never heard back from the ledger.
   *
   * Two possible causes: the command was lost (re-sending is safe — the
   * ledger deduplicates on `transferId`), or the ledger posted and its reply
   * was lost (in which case the re-sent command is a no-op). Either way the
   * fix is the same, which is exactly why the ledger's idempotency key is
   * part of the design and not an afterthought.
   */
  @Cron('*/5 * * * *', { name: 'stuck-payments' })
  async recoverStuckPayments(): Promise<void> {
    const result = await this.advisoryLocks.withSessionLock(
      'cron:stuck-payments',
      async () => this.runStuckRecovery(),
    );

    if (result === null) {
      this.logger.debug('Stuck-payment sweep is running on another instance');
    }
  }

  /**
   * Refunds that never came back.
   *
   * `refunding` is entered in one transaction and left by an event from
   * the ledger. A process that dies in between, or a reply that is lost,
   * strands the payment: the customer has not been refunded, and
   * `beginRefund` refuses to start again from `refunding`, so nobody can
   * retry it from the outside. Until now nothing swept this state at
   * all — the refund handler's own comment said as much.
   *
   * Recovery is the same shape as the capture sweep and safe for the
   * same reason: re-issuing the *same* `refund_transfer_id` is a no-op
   * in the ledger if the transfer already posted, and the missing
   * movement if it did not.
   */
  @Cron('*/5 * * * *', { name: 'stalled-refunds' })
  async recoverStalledRefunds(): Promise<void> {
    const result = await this.advisoryLocks.withSessionLock(
      'cron:stalled-refunds',
      async () => this.runRefundRecovery(),
    );

    if (result === null) {
      this.logger.debug('Stalled-refund sweep is running on another instance');
    }
  }

  @Transactional()
  private async runRefundRecovery(): Promise<number> {
    const rows = (await this.transactions.manager.query(
      `
      SELECT id, merchant_id, user_id, direction, amount_minor, fee_minor,
             currency, reference, status, method, counterparty_user_id,
             transfer_id, refund_transfer_id, refund_amount_minor
      FROM payhub.payments
      WHERE status = 'refunding'
        AND updated_at < now() - interval '10 minutes'
      ORDER BY updated_at
      LIMIT 100
      `,
    )) as StalePaymentRow[];

    let reissued = 0;

    for (const row of rows) {
      // Rows stranded before the id was persisted cannot be recovered
      // automatically: re-issuing under a new id would be a *second*
      // refund if the first one actually posted.
      if (!row.refund_transfer_id || !row.refund_amount_minor) {
        this.logger.error(
          `Payment ${row.id} has been refunding past the cutoff with no refund transfer id — needs manual review`,
        );
        this.metrics.recoverySkipped.inc({ job: 'stalled-refunds', reason: 'no_transfer_id' });
        continue;
      }

      this.logger.warn(`Re-issuing the stalled refund for payment ${row.id}`);

      await this.outbox.publish(
        PostTransferCommand,
        {
          transferId: row.refund_transfer_id,
          paymentId: row.id,
          userId: row.user_id,
          counterpartyUserId: row.counterparty_user_id,
          merchantId: row.merchant_id,
          operation: 'refund',
          amount: { amount: row.refund_amount_minor, currency: row.currency },
          fee: { amount: '0', currency: row.currency },
          provider: row.method,
          description: `refund recovery ${row.reference}`,
          requestedAt: new Date().toISOString(),
        },
        { aggregateType: 'Payment', aggregateId: row.id, partitionKey: row.id },
      );
      reissued += 1;
    }

    return reissued;
  }

  @Transactional()
  private async runStuckRecovery(): Promise<number> {
    const rows = (await this.transactions.manager.query(
      `
      SELECT id, merchant_id, user_id, direction, amount_minor, fee_minor,
             currency, reference, status, method, counterparty_user_id, transfer_id
      FROM payhub.payments
      WHERE status = 'capturing'
        AND updated_at < now() - interval '10 minutes'
      ORDER BY updated_at
      LIMIT 100
      `,
    )) as StalePaymentRow[];

    for (const row of rows) {
      /**
       * Never invent a transfer id here.
       *
       * This used to read `row.transfer_id ?? randomUUID()`, directly
       * under a comment explaining that re-issuing is safe *because* the
       * id is the same. A fresh id is the opposite: the ledger
       * deduplicates on `transferId`, so a new one is a new transfer, and
       * this cron would mint another every five minutes until somebody
       * noticed the balance. The invariant that made it unreachable —
       * `beginCapture` sets the status and the id together — lived only
       * in code; it is a database constraint now, and this is the second
       * lock on the same door.
       */
      if (!row.transfer_id) {
        this.logger.error(
          `Payment ${row.id} is capturing with no transfer id — refusing to recover it automatically`,
        );
        this.metrics.recoverySkipped.inc({ job: 'stuck-payments', reason: 'no_transfer_id' });
        continue;
      }

      this.logger.warn(
        `Payment ${row.id} has been capturing since before the cutoff — re-issuing the ledger command`,
      );

      // Re-issue the *same* command with the *same* transferId. The
      // ledger's unique key turns a duplicate into a no-op, so this is safe
      // whether the original command was lost or its reply was.
      await this.outbox.publish(
        PostTransferCommand,
        {
          transferId: row.transfer_id,
          paymentId: row.id,
          userId: row.user_id,
          counterpartyUserId: row.counterparty_user_id,
          merchantId: row.merchant_id,
          operation: row.direction as LedgerOperation,
          amount: { amount: row.amount_minor, currency: row.currency },
          fee: { amount: row.fee_minor, currency: row.currency },
          provider: row.method,
          description: `recovery ${row.reference}`,
          requestedAt: new Date().toISOString(),
        },
        { aggregateType: 'Payment', aggregateId: row.id, partitionKey: row.id },
      );
    }

    return rows.length;
  }
}
