import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { type WorkerConfig, workerConfig } from '@payhub/config';
import { Money } from '@payhub/kernel';
import { MetricsService } from '@payhub/observability';
import { AdvisoryLockService, TransactionManager, Transactional } from '@payhub/persistence';

export interface ReconciliationReport {
  readonly currency: string;
  /** Signed sum of every posting. Must be exactly zero in a correct ledger. */
  readonly trialBalanceMinor: string;
  readonly driftingWallets: ReadonlyArray<{
    walletId: string;
    projectedMinor: string;
    journalMinor: string;
    deltaMinor: string;
  }>;
  readonly checkedWallets: number;
  readonly healed: number;
}

/**
 * Ledger reconciliation.
 *
 * Two independent checks, both of which should always pass — the point is
 * to find out *immediately* when they do not:
 *
 *  1. **Trial balance.** In double-entry bookkeeping the signed sum of every
 *     posting is zero by construction. A non-zero result means a posting was
 *     lost, duplicated, or written outside the aggregate. This is the
 *     cheapest possible integrity check on the whole system and it catches
 *     things no per-row validation can.
 *
 *  2. **Projection drift.** `wallets.available_minor` is a cache of the
 *     journal. If the two disagree, the journal wins — it is append-only and
 *     protected by a trigger, while the projection is updated by application
 *     code. Healing rewrites the projection from the postings.
 *
 * The lock is a Postgres advisory lock rather than a Redis one: this job
 * reads and writes the same database it locks against, so the lock and the
 * work share a failure domain. If the process dies, the session ends and
 * the lock is gone — no lease to expire while a transaction is still open.
 */
@Injectable()
export class LedgerReconciliationJob {
  private readonly logger = new Logger(LedgerReconciliationJob.name);

  /**
   * Queries go through `TransactionManager`, never through a `DataSource`.
   *
   * `@Transactional()` puts an `EntityManager` bound to one connection in
   * AsyncLocalStorage; `dataSource.query()` takes a *different* connection
   * from the pool, so the work would run outside the transaction it looks
   * like it is in — the isolation level below would be decoration, and a
   * rollback would leave the writes behind.
   */
  constructor(
    private readonly transactions: TransactionManager,
    private readonly locks: AdvisoryLockService,
    private readonly metrics: MetricsService,
    @Inject(workerConfig.KEY) private readonly config: WorkerConfig,
  ) {}

  @Cron(process.env['RECONCILIATION_CRON'] ?? '*/5 * * * *', { name: 'ledger-reconciliation' })
  async scheduled(): Promise<void> {
    const reports = await this.locks.withSessionLock('cron:ledger-reconciliation', async () => {
      const currencies = await this.activeCurrencies();
      return Promise.all(currencies.map((currency) => this.reconcile(currency)));
    });

    if (reports === null) {
      this.logger.debug('Reconciliation is running on another instance');
      return;
    }

    for (const report of reports) {
      // One currency's reporting must not silence the others. These are
      // alarms; losing the rest of them to a formatting failure in the
      // first is the opposite of what this job is for.
      try {
        this.report(report);
      } catch (error) {
        // The alarm itself failing is the one failure nobody can infer
        // from the absence of an alarm.
        this.metrics.suppressedFailures.inc({
          site: 'reconciliation-report',
          reason: 'report_threw',
        });
        this.logger.error(
          `Failed to report reconciliation for ${report.currency}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * One currency at a time, inside a REPEATABLE READ transaction.
   *
   * The isolation level matters here and nowhere else in the ledger: the
   * trial balance and the per-wallet sums must be computed against the same
   * snapshot, or a payment committing between the two queries looks exactly
   * like drift.
   */
  @Transactional({ isolation: 'REPEATABLE READ', readOnly: false, retries: 2 })
  async reconcile(currency: string, heal = true): Promise<ReconciliationReport> {
    const totals = (await this.transactions.manager.query(
      `
      SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END), 0)::text AS total
      FROM ledger.postings
      WHERE currency = $1
      `,
      [currency],
    )) as Array<{ total: string }>;
    const total = totals[0]?.total ?? '0';

    const drifting = (await this.transactions.manager.query(
      `
      WITH journal AS (
        SELECT owner_id,
               SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END)
                 FILTER (WHERE account_kind = 'user_available') AS available,
               SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END)
                 FILTER (WHERE account_kind = 'user_pending') AS pending
        FROM ledger.postings
        WHERE currency = $1 AND owner_id IS NOT NULL
        GROUP BY owner_id
      )
      SELECT w.id                                              AS "walletId",
             (w.available_minor + w.pending_minor)::text       AS "projectedMinor",
             (COALESCE(j.available, 0) + COALESCE(j.pending, 0))::text AS "journalMinor",
             (w.available_minor + w.pending_minor
               - COALESCE(j.available, 0) - COALESCE(j.pending, 0))::text AS "deltaMinor",
             COALESCE(j.available, 0)::text                    AS "journalAvailable",
             COALESCE(j.pending, 0)::text                      AS "journalPending"
      FROM ledger.wallets w
      LEFT JOIN journal j ON j.owner_id = w.user_id::text
      WHERE w.currency = $1
        AND (w.available_minor <> COALESCE(j.available, 0) OR w.pending_minor <> COALESCE(j.pending, 0))
      `,
      [currency],
    )) as Array<{
      walletId: string;
      projectedMinor: string;
      journalMinor: string;
      deltaMinor: string;
      journalAvailable: string;
      journalPending: string;
    }>;

    const counts = (await this.transactions.manager.query(
      `SELECT count(*)::int AS count FROM ledger.wallets WHERE currency = $1`,
      [currency],
    )) as Array<{ count: number }>;
    const count = counts[0]?.count ?? 0;

    let healed = 0;

    if (heal) {
      for (const row of drifting) {
        // The journal is authoritative. Rewriting the projection is safe
        // because no money moves — we are correcting a cache.
        await this.transactions.manager.query(
          `UPDATE ledger.wallets
           SET available_minor = $2, pending_minor = $3, version = version + 1, updated_at = now()
           WHERE id = $1`,
          [row.walletId, row.journalAvailable, row.journalPending],
        );
        healed += 1;
      }
    }

    return {
      currency,
      trialBalanceMinor: total,
      driftingWallets: drifting.map((row) => ({
        walletId: row.walletId,
        projectedMinor: row.projectedMinor,
        journalMinor: row.journalMinor,
        deltaMinor: row.deltaMinor,
      })),
      checkedWallets: count,
      healed,
    };
  }

  private report(report: ReconciliationReport): void {
    const drift = report.driftingWallets.reduce(
      (sum, wallet) => sum + absBigInt(BigInt(wallet.deltaMinor)),
      0n,
    );

    this.metrics.reconciliationDrift.set({ currency: report.currency }, Number(drift));
    this.metrics.trialBalance.set({ currency: report.currency }, Number(report.trialBalanceMinor));

    if (report.healed > 0) {
      this.metrics.reconciliationHealed.inc({ currency: report.currency }, report.healed);
    }

    if (report.trialBalanceMinor !== '0') {
      // This should be impossible. If it ever fires, stop trusting the
      // balances and page somebody.
      //
      // The amount is formatted defensively on purpose. This used to call
      // `Money.fromMinor(total, currency)` directly, and `Currency.of`
      // throws on a code it does not know — so the one branch that only
      // runs when the ledger is already broken crashed instead of
      // logging, and took the remaining currencies' reports with it. An
      // unregistered currency appearing in the postings is not a
      // far-fetched input here: it is one of the ways the trial balance
      // breaks in the first place.
      this.logger.error(
        `TRIAL BALANCE BROKEN for ${report.currency}: ${formatMinor(
          report.trialBalanceMinor,
          report.currency,
        )} — the ledger does not sum to zero`,
      );
    }

    if (report.driftingWallets.length > 0) {
      this.logger.warn(
        `Reconciled ${report.currency}: ${report.driftingWallets.length} drifting wallet(s) out of ` +
          `${report.checkedWallets}, healed ${report.healed}, total drift ${drift} minor units`,
      );
      for (const wallet of report.driftingWallets.slice(0, 10)) {
        this.logger.warn(
          `  wallet=${wallet.walletId} projected=${wallet.projectedMinor} journal=${wallet.journalMinor} delta=${wallet.deltaMinor}`,
        );
      }
    } else {
      this.logger.log(
        `Reconciled ${report.currency}: ${report.checkedWallets} wallet(s), no drift (cron ${this.config.reconciliationCron})`,
      );
    }
  }

  /**
   * Every currency the ledger has touched, not every currency that has a
   * wallet.
   *
   * This read `DISTINCT currency FROM ledger.wallets`, which quietly
   * narrowed the trial balance to currencies with at least one wallet
   * row. Postings exist for accounts that are not wallets — `house_fees`
   * and `external` are both in the chart of accounts — so a currency used
   * only between those, or one whose wallets were all closed, was never
   * checked at all. The blind spot sat exactly where the check matters:
   * a posting written outside the aggregate is the thing a trial balance
   * exists to catch, and it would be invisible precisely when it landed
   * somewhere without a wallet.
   *
   * The postings are the ledger; the wallets are a projection of it. Ask
   * the ledger, and keep the wallets in the union so a currency whose
   * wallet exists before its first posting is still covered.
   */
  private async activeCurrencies(): Promise<string[]> {
    const rows = (await this.transactions.manager.query(
      `SELECT currency FROM ledger.postings
       UNION
       SELECT currency FROM ledger.wallets
       ORDER BY currency`,
    )) as Array<{ currency: string }>;

    return rows.map((row) => row.currency);
  }
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Pretty when it can be, raw minor units when it cannot. Never throws. */
function formatMinor(amountMinor: string, currency: string): string {
  try {
    return Money.fromMinor(amountMinor, currency).toString();
  } catch {
    return `${amountMinor} ${currency} (minor units)`;
  }
}
