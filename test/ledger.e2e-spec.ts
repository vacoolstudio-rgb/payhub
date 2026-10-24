import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '@payhub/kernel';
import { OutboxPublisher } from '@payhub/messaging';
import { appConfig } from '@payhub/config';
import { MetricsService } from '@payhub/observability';
import {
  TransactionManager,
  TransactionalContext,
  createDataSource,
} from '@payhub/persistence';
import { PostTransferService } from '../apps/ledger/src/application/commands/post-transfer.service.js';
import { JOURNAL_REPOSITORY } from '../apps/ledger/src/domain/ledger/journal-entry.repository.js';
import { TransferPlanner } from '../apps/ledger/src/domain/ledger/transfer-planner.service.js';
import { LedgerReconciliationJob } from '../apps/ledger/src/application/jobs/reconciliation.job.js';
import { AdvisoryLockService } from '@payhub/persistence';
import { workerConfig } from '@payhub/config';
import { WALLET_REPOSITORY } from '../apps/ledger/src/domain/wallet/wallet.repository.js';
import { InitLedgerSchema1740000000000 } from '../apps/ledger/src/infrastructure/migrations/1740000000000-InitLedgerSchema.js';
import { DropRedundantWalletIndex1740000000004 } from '../apps/ledger/src/infrastructure/migrations/1740000000004-DropRedundantWalletIndex.js';
import { JournalEntriesAppendOnly1740000000005 } from '../apps/ledger/src/infrastructure/migrations/1740000000005-JournalEntriesAppendOnly.js';
import { JournalEntryEntity } from '../apps/ledger/src/infrastructure/persistence/entities/journal-entry.entity.js';
import { PostingEntity } from '../apps/ledger/src/infrastructure/persistence/entities/posting.entity.js';
import { WalletEntity } from '../apps/ledger/src/infrastructure/persistence/entities/wallet.entity.js';
import { TypeOrmJournalRepository } from '../apps/ledger/src/infrastructure/persistence/repositories/typeorm-journal.repository.js';
import { TypeOrmWalletRepository } from '../apps/ledger/src/infrastructure/persistence/repositories/typeorm-wallet.repository.js';

/**
 * Ledger integration tests against a real Postgres.
 *
 * These cannot be written as unit tests, and that is the entire point:
 * `SELECT … FOR UPDATE`, transaction isolation, deadlock ordering and
 * `ON CONFLICT DO NOTHING` are properties of the database, not of the
 * TypeScript. An in-memory fake would happily "pass" a double-spend test
 * that the real engine fails.
 */
const TEST_APP_CONFIG = {
  serviceName: 'payhub-test',
  serviceVersion: '0.0.0-test',
  nodeEnv: 'test',
} as never;

describe('Ledger (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let moduleRef: TestingModule;
  let service: PostTransferService;
  let reconciliation: LedgerReconciliationJob;

  // Held as named functions rather than reached through the service, so
  // assertions reference a value instead of an unbound method.
  /**
   * Spies on the real metrics, rather than a stub standing in for them.
   *
   * A partial stub only holds the properties someone remembered to put
   * in it, so the first write to a metric added later reads a property
   * that is not there. Spying leaves the real registry in place: the
   * assertions below still see every call, and a metric this suite has
   * never heard of still behaves.
   */
  let trialBalanceSet: MockInstance<MetricsService['trialBalance']['set']>;
  let driftSet: MockInstance<MetricsService['reconciliationDrift']['set']>;
  let healedInc: MockInstance<MetricsService['reconciliationHealed']['inc']>;

  const ALICE = randomUUID();
  const BOB = randomUUID();
  const MERCHANT = randomUUID();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('payhub')
      .withUsername('payhub')
      .withPassword('payhub')
      .start();

    dataSource = createDataSource({
      config: {
        url: container.getConnectionUri(),
        schema: 'ledger',
        poolMax: 10,
        poolMin: 1,
        ssl: false,
        logging: false,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 5_000,
        runMigrations: false,
      },
      schema: 'ledger',
      entities: [WalletEntity, JournalEntryEntity, PostingEntity],
      migrations: [
        InitLedgerSchema1740000000000,
        DropRedundantWalletIndex1740000000004,
        JournalEntriesAppendOnly1740000000005,
      ],
      applicationName: 'payhub-ledger-test',
    });

    await dataSource.initialize();
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS ledger');
    await dataSource.runMigrations({ transaction: 'each' });

    moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } })],
      providers: [
        PostTransferService,
        TransferPlanner,
        LedgerReconciliationJob,
        { provide: AdvisoryLockService, useValue: { withSessionLock: (_n: string, work: () => unknown) => work() } },
        { provide: workerConfig.KEY, useValue: { reconciliationCron: '*/5 * * * *' } },
        { provide: DataSource, useValue: dataSource },
        {
          provide: TransactionManager,
          inject: [DataSource, ClsService],
          useFactory: (ds: DataSource, cls: ClsService) => new TransactionManager(ds, cls),
        },
        { provide: WALLET_REPOSITORY, useClass: TypeOrmWalletRepository },
        { provide: JOURNAL_REPOSITORY, useClass: TypeOrmJournalRepository },
        { provide: OutboxPublisher, useValue: { publish: vi.fn().mockResolvedValue('id') } },
        {
          provide: appConfig.KEY,
          useValue: TEST_APP_CONFIG,
        },
        MetricsService,
      ],
    }).compile();

    const metrics = moduleRef.get(MetricsService);
    trialBalanceSet = vi.spyOn(metrics.trialBalance, 'set');
    driftSet = vi.spyOn(metrics.reconciliationDrift, 'set');
    healedInc = vi.spyOn(metrics.reconciliationHealed, 'inc');

    TransactionalContext.bind(moduleRef.get(TransactionManager));
    service = moduleRef.get(PostTransferService);
    reconciliation = moduleRef.get(LedgerReconciliationJob);
  }, 180_000);

  afterAll(async () => {
    TransactionalContext.reset();
    await moduleRef?.close();
    await dataSource?.destroy();
    await container?.stop();
  });

  beforeEach(async () => {
    // Truncate rather than drop: the append-only trigger forbids DELETE on
    // postings, which is itself worth proving (see the test below).
    await dataSource.query('TRUNCATE ledger.postings, ledger.journal_entries, ledger.wallets CASCADE');
  });

  const deposit = (userId: string, major: string, fee = '0.00') => ({
    transferId: randomUUID(),
    paymentId: randomUUID(),
    userId,
    counterpartyUserId: null,
    merchantId: MERCHANT,
    operation: 'deposit' as const,
    amount: Money.fromMajor(major, 'USD').toJSON(),
    fee: Money.fromMajor(fee, 'USD').toJSON(),
    provider: 'card',
    description: `deposit ${major}`,
  });

  const withdraw = (userId: string, major: string) => ({
    ...deposit(userId, major),
    operation: 'withdrawal' as const,
    description: `withdraw ${major}`,
  });

  async function balanceOf(userId: string): Promise<string> {
    const rows = (await dataSource.query(
      'SELECT available_minor::text AS available FROM ledger.wallets WHERE user_id = $1',
      [userId],
    )) as Array<{ available: string }>;
    return rows[0]?.available ?? '0';
  }

  it('posts a deposit and opens the wallet on demand', async () => {
    const outcome = await service.execute(deposit(ALICE, '100.00', '3.20'));

    expect(outcome.status).toBe('posted');
    expect(await balanceOf(ALICE)).toBe('9680');
  });

  /**
   * The double-spend test.
   *
   * Ten concurrent withdrawals of 20.00 against a balance of 100.00 must
   * settle exactly five. Without the row lock, every transaction reads
   * "100.00 available", all ten pass the check, and the wallet ends up
   * negative — the bug this whole design exists to prevent.
   */
  it('serialises concurrent withdrawals and never overdraws', async () => {
    await service.execute(deposit(ALICE, '100.00'));

    const attempts = Array.from({ length: 10 }, () => service.execute(withdraw(ALICE, '20.00')));
    const outcomes = await Promise.all(attempts);

    const posted = outcomes.filter((outcome) => outcome.status === 'posted');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(posted).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((outcome) => 'reason' in outcome && outcome.reason === 'insufficient_funds')).toBe(true);
    expect(await balanceOf(ALICE)).toBe('0');
  }, 60_000);

  /** Two transfers in opposite directions are the textbook deadlock. */
  it('does not deadlock when two transfers cross', async () => {
    await service.execute(deposit(ALICE, '100.00'));
    await service.execute(deposit(BOB, '100.00'));

    const aToB = {
      ...deposit(ALICE, '10.00'),
      operation: 'transfer' as const,
      counterpartyUserId: BOB,
    };
    const bToA = {
      ...deposit(BOB, '10.00'),
      operation: 'transfer' as const,
      counterpartyUserId: ALICE,
    };

    const outcomes = await Promise.all([service.execute(aToB), service.execute(bToA)]);

    expect(outcomes.every((outcome) => outcome.status === 'posted')).toBe(true);
    expect(await balanceOf(ALICE)).toBe('10000');
    expect(await balanceOf(BOB)).toBe('10000');
  }, 60_000);

  it('treats a replayed command as a no-op', async () => {
    const command = deposit(ALICE, '50.00');

    const first = await service.execute(command);
    const second = await service.execute(command);

    expect(first.status).toBe('posted');
    expect(second.status).toBe('duplicate');
    expect(await balanceOf(ALICE)).toBe('5000');
  });

  /**
   * The integrity check reconciliation relies on: in a correct double-entry
   * ledger the signed sum of every posting is exactly zero.
   */
  it('keeps the trial balance at zero', async () => {
    await service.execute(deposit(ALICE, '100.00', '2.90'));
    await service.execute(deposit(BOB, '55.55', '1.61'));
    await service.execute(withdraw(ALICE, '20.00'));

    const rows = (await dataSource.query(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END), 0)::text AS total
       FROM ledger.postings`,
    )) as Array<{ total: string }>;

    expect(rows[0]?.total).toBe('0');
  });

  it('rejects a movement on a frozen wallet without touching the journal', async () => {
    await service.execute(deposit(ALICE, '100.00'));
    await dataSource.query(`UPDATE ledger.wallets SET status = 'frozen' WHERE user_id = $1`, [ALICE]);

    const outcome = await service.execute(withdraw(ALICE, '10.00'));

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'wallet_frozen' });
    expect(await balanceOf(ALICE)).toBe('10000');
  });

  /** Enforced by a trigger, so a bug in application code cannot rewrite history. */
  it('refuses to update or delete a posting', async () => {
    await service.execute(deposit(ALICE, '10.00'));

    await expect(
      dataSource.query('UPDATE ledger.postings SET amount_minor = 1'),
    ).rejects.toThrow(/append-only/);

    await expect(dataSource.query('DELETE FROM ledger.postings')).rejects.toThrow(/append-only/);
  });

  /** Enforced by a CHECK constraint, independently of the aggregate. */
  it('refuses a negative balance at the database level', async () => {
    await service.execute(deposit(ALICE, '10.00'));

    await expect(
      dataSource.query('UPDATE ledger.wallets SET available_minor = -1 WHERE user_id = $1', [
        ALICE,
      ]),
    ).rejects.toThrow(/ck_wallets_no_overdraft/);
  });

  /**
   * An audit trail that can be edited is not an audit trail.
   *
   * The postings were already append-only, and the foreign key is
   * `ON DELETE RESTRICT`, so no entry carrying postings could be removed.
   * The entry row itself stayed writable though — and the entry is what
   * records *why* the money moved. The amounts were immutable while the
   * narrative explaining them was not.
   */
  describe('append-only guarantees', () => {
    /** A trigger that fires per row needs a row to fire on. */
    async function postedEntryId(): Promise<string> {
      await service.execute(deposit(ALICE, '100.00'));
      const [entry] = (await dataSource.query(
        'SELECT id FROM ledger.journal_entries LIMIT 1',
      )) as Array<{ id: string }>;
      return entry!.id;
    }

    it('refuses to rewrite a journal entry', async () => {
      const entryId = await postedEntryId();

      await expect(
        dataSource.query('UPDATE ledger.journal_entries SET description = $1 WHERE id = $2', [
          'tampered',
          entryId,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it('refuses to delete a journal entry', async () => {
      const entryId = await postedEntryId();

      await expect(
        dataSource.query('DELETE FROM ledger.journal_entries WHERE id = $1', [entryId]),
      ).rejects.toThrow(/append-only/);
    });

    it('refuses to rewrite a posting', async () => {
      await postedEntryId();

      await expect(
        dataSource.query('UPDATE ledger.postings SET amount_minor = amount_minor + 1'),
      ).rejects.toThrow(/append-only/);
    });
  });

  /**
   * The trial balance is the cheapest integrity check the platform has
   * and the only one that catches a posting written outside the
   * aggregate. Its coverage must not depend on which accounts happen to
   * have a wallet row.
   */
  describe('reconciliation coverage', () => {
    /** An unbalanced posting in a currency that has no wallet at all. */
    async function chfPosting(): Promise<void> {
      const entryId = randomUUID();
      await dataSource.query(
        `INSERT INTO ledger.journal_entries (id, payment_id, user_id, purpose, description, posted_at)
         VALUES ($1, $2, $3, 'capture', 'house only', now())`,
        [entryId, randomUUID(), ALICE],
      );
      await dataSource.query(
        `INSERT INTO ledger.postings
           (entry_id, account, account_kind, owner_id, currency, direction, amount_minor, posted_at)
         VALUES ($1, 'house:fees:CHF', 'house_fees', NULL, 'CHF', 'debit', 500, now())`,
        [entryId],
      );
    }

    /** Postings land on `house_fees` and `external` too, which have none. */
    it('checks a currency that has postings but no wallet', async () => {
      await dataSource.query('TRUNCATE ledger.postings, ledger.journal_entries, ledger.wallets CASCADE');

      const entryId = randomUUID();
      await dataSource.query(
        `INSERT INTO ledger.journal_entries (id, payment_id, user_id, purpose, description, posted_at)
         VALUES ($1, $2, $3, 'capture', 'house only', now())`,
        [entryId, randomUUID(), ALICE],
      );
      for (const [account, kind, direction] of [
        ['house:fees:CHF', 'house_fees', 'debit'],
        ['external:card:CHF', 'external', 'credit'],
      ] as const) {
        await dataSource.query(
          `INSERT INTO ledger.postings
             (entry_id, account, account_kind, owner_id, currency, direction, amount_minor, posted_at)
           VALUES ($1, $2, $3, NULL, 'CHF', $4, 500, now())`,
          [entryId, account, kind, direction],
        );
      }

      const report = await reconciliation.reconcile('CHF');

      expect(report.trialBalanceMinor).toBe('0');
      expect(report.checkedWallets).toBe(0);
    });

    /**
     * Regression: currencies came from `ledger.wallets`, so this currency
     * was never reconciled at all — the sweep reported nothing and looked
     * exactly like a sweep with nothing wrong.
     */
    it('discovers that currency rather than skipping it', async () => {
      await dataSource.query('TRUNCATE ledger.postings, ledger.journal_entries, ledger.wallets CASCADE');
      await service.execute(deposit(ALICE, '10.00'));
      await chfPosting();
      trialBalanceSet.mockClear();

      await reconciliation.scheduled();

      // An unbalanced CHF posting exists, so a sweep that looked at CHF
      // at all must have set a non-zero trial balance for it.
      const currencies = trialBalanceSet.mock.calls.map(
        // `set` is overloaded (value, or labels then value); the labelled
        // form is the one this job uses.
        ([labels]) => (labels as unknown as { currency: string }).currency,
      );

      expect(currencies).toContain('CHF');
    });

    /**
     * The repair half of the job, which nothing exercised.
     *
     * The projection is a cache of the journal: `ledger.wallets` is
     * derived, the postings are the record. So a divergence is fixable
     * without moving money — rewrite the cache from the source. The
     * counter that says how often this happens was written by the job
     * and asserted by nobody, which is how a repair path rots.
     */
    it('rewrites a projection that has drifted from the journal', async () => {
      await dataSource.query('TRUNCATE ledger.postings, ledger.journal_entries, ledger.wallets CASCADE');
      await service.execute(deposit(ALICE, '10.00'));

      const [before] = await dataSource.query(
        'SELECT available_minor::text AS available FROM ledger.wallets WHERE user_id = $1',
        [ALICE],
      );
      await dataSource.query(
        'UPDATE ledger.wallets SET available_minor = available_minor + 777 WHERE user_id = $1',
        [ALICE],
      );
      healedInc.mockClear();

      await reconciliation.scheduled();

      const [after] = await dataSource.query(
        'SELECT available_minor::text AS available FROM ledger.wallets WHERE user_id = $1',
        [ALICE],
      );

      expect(after.available).toBe(before.available);
      expect(healedInc).toHaveBeenCalledWith({ currency: 'USD' }, 1);
    });

    /** Audit mode: report the divergence, touch nothing. */
    it('leaves the projection alone when healing is off', async () => {
      await dataSource.query('TRUNCATE ledger.postings, ledger.journal_entries, ledger.wallets CASCADE');
      await service.execute(deposit(ALICE, '10.00'));
      await dataSource.query(
        'UPDATE ledger.wallets SET available_minor = available_minor + 777 WHERE user_id = $1',
        [ALICE],
      );

      const report = await reconciliation.reconcile('USD', false);

      const [row] = await dataSource.query(
        'SELECT available_minor::text AS available FROM ledger.wallets WHERE user_id = $1',
        [ALICE],
      );

      expect(report.driftingWallets).toHaveLength(1);
      expect(report.healed).toBe(0);
      expect(row.available).toBe('1777');
    });

    /**
     * These are alarms. Losing the rest of them because the first one
     * failed to render is the opposite of what the job is for — and that
     * is exactly what happened: formatting an unregistered currency threw
     * out of `report`, aborting the loop over the remaining currencies.
     */
    it('keeps reporting the other currencies when one fails', async () => {
      await dataSource.query('TRUNCATE ledger.postings, ledger.journal_entries, ledger.wallets CASCADE');
      await service.execute(deposit(ALICE, '10.00'));
      await chfPosting();

      trialBalanceSet.mockClear();
      // Currencies are reported in order, so this lands on CHF and USD
      // must survive it.
      driftSet.mockImplementationOnce(() => {
        throw new Error('metrics backend unavailable');
      });

      await expect(reconciliation.scheduled()).resolves.toBeUndefined();

      const reported = trialBalanceSet.mock.calls.map(
        // `set` is overloaded (value, or labels then value); the labelled
        // form is the one this job uses.
        ([labels]) => (labels as unknown as { currency: string }).currency,
      );
      expect(reported).toEqual(['USD']);
    });
  });
});
