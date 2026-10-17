import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { TransactionManager, createDataSource } from '@payhub/persistence';
import { Money } from '@payhub/kernel';
import {
  Payment,
  PaymentDirection,
  PaymentId,
} from '../apps/api/src/modules/payment/domain/payment.aggregate.js';
import { PaymentEntity } from '../apps/api/src/modules/payment/infrastructure/persistence/entities/payment.entity.js';
import { TypeOrmPaymentRepository } from '../apps/api/src/modules/payment/infrastructure/persistence/repositories/typeorm-payment.repository.js';
import { apiMigrations } from '../apps/api/src/database/migrations/index.js';

const MERCHANT = '44444444-4444-4444-8444-444444444444';
const ME = '11111111-1111-4111-8111-111111111111';
const SOMEONE_ELSE = '22222222-2222-4222-8222-222222222222';

/**
 * Keyset pagination over a listing assembled from two index-ordered
 * branches.
 *
 * A user's payments are the ones they originated *plus* the transfers
 * where they are the counterparty. That used to be one query with an `OR`
 * across two columns, which no index can serve: Postgres scanned the whole
 * table and sorted it. It is now two branches merged in memory, and the
 * risk moved with it — a merge that disagrees with the branch ordering, or
 * a cursor that describes the wrong boundary, drops or repeats rows in a
 * way only a real query over interleaved data exposes.
 */
describe('Payment repository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let moduleRef: TestingModule;
  let payments: TypeOrmPaymentRepository;
  let transactions: TransactionManager;

  /** Interleaves ownership so neither branch can satisfy a page alone. */
  async function seed(count: number): Promise<void> {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);

    const rows = Array.from({ length: count }, (_, index) => {
      const mine = index % 2 === 0;
      return {
        id: randomUUID(),
        merchant_id: MERCHANT,
        user_id: mine ? ME : SOMEONE_ELSE,
        counterparty_user_id: mine ? null : ME,
        direction: mine ? 'deposit' : 'transfer',
        status: 'captured',
        amount_minor: 1_000 + index,
        fee_minor: 0,
        currency: 'USD',
        method: 'card',
        reference: `seed-${index}`,
        expires_at: new Date(base + 86_400_000),
        created_at: new Date(base + index * 60_000),
      };
    });

    for (const row of rows) {
      await dataSource.query(
        `INSERT INTO payhub.payments
           (id, merchant_id, user_id, counterparty_user_id, direction, status,
            amount_minor, fee_minor, currency, method, reference, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        Object.values(row),
      );
    }
  }

  /** Walks every page the way a client would, and reports what it saw. */
  async function pageThrough(limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let guard = 0; guard < 100; guard += 1) {
      const page = await payments.list({ userId: ME, limit, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((payment) => payment.reference));

      if (!page.hasMore || !page.nextCursor) {
        return seen;
      }
      cursor = page.nextCursor;
    }

    throw new Error('pagination did not terminate');
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('payhub')
      .withUsername('payhub')
      .withPassword('payhub')
      .start();

    dataSource = createDataSource({
      config: {
        url: container.getConnectionUri(),
        schema: 'payhub',
        poolMax: 10,
        poolMin: 1,
        ssl: false,
        logging: false,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 5_000,
        runMigrations: false,
      },
      schema: 'payhub',
      entities: [PaymentEntity],
      migrations: apiMigrations,
      applicationName: 'payhub-pagination-test',
    });

    await dataSource.initialize();
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS payhub');
    await dataSource.runMigrations({ transaction: 'each' });

    moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } })],
      providers: [
        { provide: DataSource, useValue: dataSource },
        {
          provide: TransactionManager,
          inject: [DataSource, ClsService],
          useFactory: (ds: DataSource, cls: ClsService) => new TransactionManager(ds, cls),
        },
        TypeOrmPaymentRepository,
      ],
    }).compile();

    payments = moduleRef.get(TypeOrmPaymentRepository);
    transactions = moduleRef.get(TransactionManager);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await dataSource?.destroy();
    await container?.stop();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE payhub.payments, payhub.merchants, payhub.users CASCADE');

    // Payments carry real foreign keys, so the parents have to exist.
    for (const [id, email] of [
      [ME, 'me@payhub.test'],
      [SOMEONE_ELSE, 'them@payhub.test'],
    ] as const) {
      await dataSource.query(
        `INSERT INTO payhub.users (id, email, password_hash, display_name)
         VALUES ($1, $2, 'x', 'Test')`,
        [id, email],
      );
    }

    await dataSource.query(
      `INSERT INTO payhub.merchants (id, owner_user_id, name, status)
       VALUES ($1, $2, 'Test Merchant', 'active')`,
      [MERCHANT, ME],
    );
  });

  /** Newest first, and the reference numbers make that readable. */
  const newestFirst = (count: number) =>
    Array.from({ length: count }, (_, index) => `seed-${count - 1 - index}`);

  it('returns both the payments a user made and those made to them', async () => {
    await seed(6);

    const page = await payments.list({ userId: ME, limit: 10 });

    expect(page.items.map((payment) => payment.reference)).toEqual(newestFirst(6));
  });

  it('excludes payments that involve neither side of this user', async () => {
    await seed(4);
    await dataSource.query(
      `INSERT INTO payhub.payments
         (id, merchant_id, user_id, counterparty_user_id, direction, status,
          amount_minor, fee_minor, currency, method, reference, expires_at, created_at)
       VALUES ($1,$2,$3,NULL,'deposit','captured',500,0,'USD','card','not-mine',now(),now())`,
      [randomUUID(), MERCHANT, SOMEONE_ELSE],
    );

    const page = await payments.list({ userId: ME, limit: 10 });

    expect(page.items.map((payment) => payment.reference)).not.toContain('not-mine');
  });

  /**
   * The property that matters: paging must visit every row exactly once,
   * in the same order a single sorted query would produce — whichever
   * branch each row came from.
   */
  it.each([1, 2, 3, 5, 7])('pages with limit %i without gaps or repeats', async (limit) => {
    await seed(20);

    const seen = await pageThrough(limit);

    expect(seen).toEqual(newestFirst(20));
    expect(new Set(seen).size).toBe(20);
  });

  /**
   * The merge sorts on `(created_at, id)`, so rows sharing a timestamp are
   * the case where a sloppy comparator loses one: the branches would each
   * order ties by id, and a merge that ignored the id would interleave
   * them differently from the cursor's view of the boundary.
   */
  it('keeps paging stable when timestamps collide', async () => {
    const sameInstant = new Date(Date.UTC(2026, 0, 1));
    for (let index = 0; index < 10; index += 1) {
      const mine = index % 2 === 0;
      await dataSource.query(
        `INSERT INTO payhub.payments
           (id, merchant_id, user_id, counterparty_user_id, direction, status,
            amount_minor, fee_minor, currency, method, reference, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,'captured',100,0,'USD','card',$6,$7,$7)`,
        [
          randomUUID(),
          MERCHANT,
          mine ? ME : SOMEONE_ELSE,
          mine ? null : ME,
          mine ? 'deposit' : 'transfer',
          `tie-${index}`,
          sameInstant,
        ],
      );
    }

    const seen = await pageThrough(3);

    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });

  it('applies the other filters to both branches', async () => {
    await seed(10);

    const page = await payments.list({ userId: ME, limit: 50, direction: 'transfer' });

    // Only the counterparty branch produces transfers in this fixture.
    expect(page.items).not.toHaveLength(0);
    expect(page.items.every((payment) => payment.direction === 'transfer')).toBe(true);
  });

  it('reports hasMore honestly at the boundary', async () => {
    await seed(6);

    const exact = await payments.list({ userId: ME, limit: 6 });
    const short = await payments.list({ userId: ME, limit: 5 });

    expect(exact.hasMore).toBe(false);
    expect(short.hasMore).toBe(true);
  });

  /**
   * The two branches are issued with `Promise.all`. Inside a transaction
   * they share one connection, and a Postgres connection runs one
   * statement at a time — the driver queues them. Worth proving rather
   * than assuming, because the failure mode would be a corrupted protocol
   * state, not a clean error.
   */
  it('works inside an ambient transaction, where both branches share a connection', async () => {
    await seed(8);

    const page = await transactions.run(async () => payments.list({ userId: ME, limit: 10 }));

    expect(page.items.map((payment) => payment.reference)).toEqual(newestFirst(8));
  });

  /** The single-branch path must keep working unchanged. */
  it('still lists by merchant without a user filter', async () => {
    await seed(5);

    const page = await payments.list({ merchantId: MERCHANT, limit: 10 });

    expect(page.items).toHaveLength(5);
  });

  /**
   * Every field the lifecycle can change has to survive `save`.
   *
   * `save` is an optimistic-locked `UPDATE` that used to name the columns
   * it wrote. `refund_transfer_id` was added to the aggregate, the
   * entity and the mapper, compiled cleanly, and still never reached the
   * database — because nobody remembered the one list that decides what
   * gets written. The compiler cannot see that omission, so this does.
   */
  describe('save', () => {
    async function captured(): Promise<Payment> {
      const payment = Payment.initiate({
        id: PaymentId.create(),
        merchantId: MERCHANT,
        userId: ME,
        direction: PaymentDirection.Deposit,
        amount: Money.fromMajor('100.00', 'USD'),
        fee: Money.fromMajor('3.20', 'USD'),
        method: 'card',
        reference: 'save-roundtrip',
      }).unwrap();

      payment.authorize('auth_1');
      payment.beginCapture(randomUUID());
      payment.completeCapture(payment.transferId!);
      payment.pullDomainEvents();

      await payments.insert(payment);
      return payment;
    }

    it('persists the refund in flight, so a crash leaves something to retry by', async () => {
      const payment = await captured();
      const transferId = randomUUID();

      payment.beginRefund(Money.fromMajor('40.00', 'USD'), transferId);
      await payments.save(payment);

      const reloaded = await payments.findById(payment.id);

      expect(reloaded?.refundTransferId).toBe(transferId);
      expect(reloaded?.refundAmount?.toMajorString()).toBe('40.00');
    });

    it('clears it again once the refund completes', async () => {
      const payment = await captured();
      payment.beginRefund(Money.fromMajor('40.00', 'USD'), randomUUID());
      await payments.save(payment);

      payment.completeRefund(Money.fromMajor('40.00', 'USD'));
      await payments.save(payment);

      const reloaded = await payments.findById(payment.id);

      expect(reloaded?.refundTransferId).toBeNull();
      expect(reloaded?.refundAmount).toBeNull();
      expect(reloaded?.refundedAmount.toMajorString()).toBe('40.00');
    });

    it('clears it when the refund is cancelled', async () => {
      const payment = await captured();
      payment.beginRefund(Money.fromMajor('40.00', 'USD'), randomUUID());
      await payments.save(payment);

      payment.cancelRefund();
      await payments.save(payment);

      const reloaded = await payments.findById(payment.id);

      expect(reloaded?.status).toBe('captured');
      expect(reloaded?.refundTransferId).toBeNull();
    });
  });
});
