import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  InboxRepository,
  OutboxRepository,
  ProcessedMessageEntity,
  OutboxMessageEntity,
  TransactionManager,
  createDataSource,
} from '@payhub/persistence';
import { InitLedgerSchema1740000000000 } from '../apps/ledger/src/infrastructure/migrations/1740000000000-InitLedgerSchema.js';

/**
 * Outbox and inbox against a real Postgres.
 *
 * The behaviour under test is entirely about what the database does under
 * concurrency — `FOR UPDATE SKIP LOCKED`, lease expiry, `ON CONFLICT DO
 * NOTHING` — none of which a fake can reproduce.
 */
describe('Outbox & inbox (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let moduleRef: TestingModule;
  let outbox: OutboxRepository;
  let inbox: InboxRepository;
  let transactions: TransactionManager;

  /** What the observer port was told, in order. */
  const recorded: Array<{ isolation: string; outcome: string; seconds: number }> = [];

  const append = (overrides: Partial<Parameters<OutboxRepository['append']>[0]> = {}) =>
    outbox.append({
      topic: 'payhub.payments.events.v1',
      eventType: 'payment.captured.v1',
      aggregateType: 'Payment',
      aggregateId: randomUUID(),
      payload: { amount: '10000' },
      ...overrides,
    });

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
        poolMax: 15,
        poolMin: 1,
        ssl: false,
        logging: false,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 5_000,
        runMigrations: false,
      },
      schema: 'ledger',
      entities: [OutboxMessageEntity, ProcessedMessageEntity],
      migrations: [InitLedgerSchema1740000000000],
      applicationName: 'payhub-outbox-test',
    });

    await dataSource.initialize();
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS ledger');
    await dataSource.runMigrations({ transaction: 'each' });

    moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } })],
      providers: [
        { provide: DataSource, useValue: dataSource },
        {
          provide: TransactionManager,
          inject: [DataSource, ClsService],
          useFactory: (ds: DataSource, cls: ClsService) =>
            new TransactionManager(ds, cls, {
              record: (isolation, outcome, seconds) =>
                void recorded.push({ isolation, outcome, seconds }),
            }),
        },
        OutboxRepository,
        InboxRepository,
      ],
    }).compile();

    outbox = moduleRef.get(OutboxRepository);
    inbox = moduleRef.get(InboxRepository);
    transactions = moduleRef.get(TransactionManager);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await dataSource?.destroy();
    await container?.stop();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE ledger.outbox_messages, ledger.processed_messages');
  });

  describe('append', () => {
    it('stores a message with the columns the relay reads', async () => {
      const id = await append({ aggregateId: 'agg-1' });

      const [row] = (await dataSource.query(
        'SELECT * FROM ledger.outbox_messages WHERE id = $1',
        [id],
      )) as Array<Record<string, unknown>>;

      expect(row).toMatchObject({
        status: 'pending',
        attempts: 0,
        event_type: 'payment.captured.v1',
        aggregate_type: 'Payment',
        // Defaults to the aggregate id, which is what keeps one payment's
        // events on one partition and therefore in order.
        partition_key: 'agg-1',
      });
    });

    it('inserts a batch in one statement', async () => {
      const ids = await outbox.appendMany([
        { topic: 't', eventType: 'a', aggregateType: 'P', aggregateId: '1', payload: {} },
        { topic: 't', eventType: 'b', aggregateType: 'P', aggregateId: '2', payload: {} },
        { topic: 't', eventType: 'c', aggregateType: 'P', aggregateId: '3', payload: {} },
      ]);

      expect(ids).toHaveLength(3);
      expect(await outbox.countByStatus()).toEqual({ pending: 3 });
    });

    it('accepts an explicit message id, so the event id and the message id match', async () => {
      const messageId = randomUUID();

      expect(await append({ messageId })).toBe(messageId);
    });
  });

  describe('claimBatch', () => {
    /**
     * Regression, found as an intermittent failure in this very suite:
     * two appended rows produced one claimable row, about one run in
     * three.
     *
     * `append` stamped `available_at` with `new Date()` — the
     * application's clock — while the relay selects
     * `WHERE available_at <= now()`, which is the *database's*. Two
     * clocks, one comparison. A writer running a few milliseconds ahead
     * publishes events the relay cannot see until real time catches up,
     * and with several pods each has its own offset. Here the host and
     * the Postgres container disagreed by just enough.
     *
     * The clock is moved far enough forward that no amount of ordinary
     * skew could explain a pass.
     */
    it('stamps availability with the database clock, not the caller\'s', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.now() + 5 * 60_000));

      try {
        await append();
      } finally {
        vi.useRealTimers();
      }

      expect(await outbox.claimBatch(10)).toHaveLength(1);
    });

    it('stamps a batch the same way', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.now() + 5 * 60_000));

      try {
        await outbox.appendMany([
          { topic: 't', eventType: 'a', aggregateType: 'P', aggregateId: '1', payload: {} },
          { topic: 't', eventType: 'b', aggregateType: 'P', aggregateId: '2', payload: {} },
        ]);
      } finally {
        vi.useRealTimers();
      }

      expect(await outbox.claimBatch(10)).toHaveLength(2);
    });

    it('claims pending rows and marks them publishing', async () => {
      await append();
      await append();

      const batch = await outbox.claimBatch(10);

      expect(batch).toHaveLength(2);
      // The row shape the relay depends on must survive the raw query.
      expect(batch[0]).toMatchObject({ eventType: expect.any(String), topic: expect.any(String) });
      expect(batch.every((row) => typeof row.id === 'string')).toBe(true);
      expect(await outbox.countByStatus()).toEqual({ publishing: 2 });
    });

    it('respects the batch size', async () => {
      for (let i = 0; i < 5; i += 1) {
        await append();
      }

      expect(await outbox.claimBatch(2)).toHaveLength(2);
    });

    /**
     * `SKIP LOCKED` is what lets N relay replicas drain one table with no
     * coordination: each row goes to exactly one worker, and nobody blocks.
     */
    it('hands each row to exactly one concurrent claimer', async () => {
      for (let i = 0; i < 30; i += 1) {
        await append();
      }

      const batches = await Promise.all([
        outbox.claimBatch(10),
        outbox.claimBatch(10),
        outbox.claimBatch(10),
      ]);

      const claimed = batches.flat().map((row) => row.id);

      expect(claimed).toHaveLength(30);
      expect(new Set(claimed).size).toBe(30);
    });

    /**
     * Regression: a relay that crashes between claiming and acking used to
     * strand its rows in `publishing` forever, because the next poll only
     * looked at `pending`. The lease turns the table into a proper
     * visibility-timeout queue.
     */
    it('reclaims rows whose lease expired', async () => {
      await append();

      const first = await outbox.claimBatch(10, 50);
      expect(first).toHaveLength(1);

      // Nothing is reclaimable while the lease is live.
      expect(await outbox.claimBatch(10, 50)).toHaveLength(0);

      await new Promise((resolve) => setTimeout(resolve, 120));

      const reclaimed = await outbox.claimBatch(10, 50);
      expect(reclaimed.map((row) => row.id)).toEqual(first.map((row) => row.id));
      expect(reclaimed[0]?.attempts).toBe(2);
    });

    it('ignores rows scheduled in the future', async () => {
      const id = await append();
      await dataSource.query(
        `UPDATE ledger.outbox_messages SET available_at = now() + interval '1 hour' WHERE id = $1`,
        [id],
      );

      expect(await outbox.claimBatch(10)).toHaveLength(0);
    });

    it('claims the oldest rows first', async () => {
      const older = await append();
      await dataSource.query(
        `UPDATE ledger.outbox_messages SET available_at = now() - interval '1 hour' WHERE id = $1`,
        [older],
      );
      await append();

      expect((await outbox.claimBatch(1))[0]?.id).toBe(older);
    });
  });

  describe('acking', () => {
    it('marks a batch published', async () => {
      const ids = [await append(), await append()];
      await outbox.claimBatch(10);

      await outbox.markPublished(ids);

      expect(await outbox.countByStatus()).toEqual({ published: 2 });
    });

    it('markPublished on an empty list is a no-op', async () => {
      await expect(outbox.markPublished([])).resolves.toBeUndefined();
    });

    it('reschedules a failure with backoff and records why', async () => {
      const id = await append();
      await outbox.claimBatch(10);

      await outbox.markFailed(id, 'broker unreachable', 60_000, 5);

      const [row] = (await dataSource.query(
        'SELECT status, last_error, available_at > now() AS deferred FROM ledger.outbox_messages WHERE id = $1',
        [id],
      )) as Array<{ status: string; last_error: string; deferred: boolean }>;

      expect(row).toMatchObject({ status: 'pending', deferred: true });
      expect(row?.last_error).toContain('broker unreachable');
    });

    /** A poison message must stop consuming relay capacity eventually. */
    it('buries a row once the attempts are exhausted', async () => {
      const id = await append();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await outbox.claimBatch(10, 0);
      }

      await outbox.markFailed(id, 'still broken', 0, 3);

      expect(await outbox.countByStatus()).toEqual({ dead: 1 });
      // And a dead row is never claimed again.
      expect(await outbox.claimBatch(10)).toHaveLength(0);
    });

    it('truncates an enormous error instead of storing it whole', async () => {
      const id = await append();
      await outbox.claimBatch(10);

      await outbox.markFailed(id, 'x'.repeat(10_000), 1_000, 5);

      const [row] = (await dataSource.query(
        'SELECT last_error FROM ledger.outbox_messages WHERE id = $1',
        [id],
      )) as Array<{ last_error: string }>;

      expect(row!.last_error.length).toBeLessThanOrEqual(2_000);
    });
  });

  describe('retention', () => {
    it('purges published rows past the cutoff and keeps the rest', async () => {
      const old = await append();
      const recent = await append();
      await outbox.markPublished([old, recent]);
      await dataSource.query(
        `UPDATE ledger.outbox_messages SET published_at = now() - interval '30 days' WHERE id = $1`,
        [old],
      );

      const removed = await outbox.purgePublishedBefore(new Date(Date.now() - 7 * 86_400_000));

      expect(removed).toBe(1);
      expect(await outbox.countByStatus()).toEqual({ published: 1 });
    });

    it('never purges a pending row, however old', async () => {
      const id = await append();
      await dataSource.query(
        `UPDATE ledger.outbox_messages SET created_at = now() - interval '365 days' WHERE id = $1`,
        [id],
      );

      expect(await outbox.purgePublishedBefore(new Date())).toBe(0);
    });
  });

  describe('inbox deduplication', () => {
    const claim = (messageId: string, group = 'payhub-ledger') =>
      inbox.tryClaim({ messageId, consumerGroup: group, eventType: 'payment.captured.v1' });

    /** At-least-once delivery becomes effectively-once here. */
    it('claims a message once per consumer group', async () => {
      const messageId = randomUUID();

      expect(await claim(messageId)).toBe(true);
      expect(await claim(messageId)).toBe(false);
    });

    it('lets a different consumer group process the same message', async () => {
      const messageId = randomUUID();

      expect(await claim(messageId, 'payhub-ledger')).toBe(true);
      expect(await claim(messageId, 'payhub-worker')).toBe(true);
    });

    /** `ON CONFLICT DO NOTHING` makes the check and the claim one statement. */
    it('admits exactly one of many concurrent claims', async () => {
      const messageId = randomUUID();

      const outcomes = await Promise.all(Array.from({ length: 15 }, () => claim(messageId)));

      expect(outcomes.filter(Boolean)).toHaveLength(1);
    });

    it('stores the outcome so a replay can answer without redoing the work', async () => {
      const messageId = randomUUID();
      await claim(messageId);

      await inbox.recordResult(messageId, 'payhub-ledger', { transferId: 'tr-1' });

      const [row] = (await dataSource.query(
        'SELECT result FROM ledger.processed_messages WHERE message_id = $1',
        [messageId],
      )) as Array<{ result: Record<string, unknown> }>;

      expect(row?.result).toEqual({ transferId: 'tr-1' });
    });

    it('purges entries older than the broker could possibly redeliver', async () => {
      const messageId = randomUUID();
      await claim(messageId);
      await dataSource.query(
        `UPDATE ledger.processed_messages SET processed_at = now() - interval '30 days'`,
      );

      expect(await inbox.purgeBefore(new Date(Date.now() - 14 * 86_400_000))).toBe(1);
    });
  });

  /**
   * Cache invalidation, webhooks and push notifications all have the same
   * requirement: happen once the write is durable, and not at all if it
   * is not.
   */
  /**
   * Transaction duration is what explains the two failures that
   * actually hurt — a long transaction holding a connection the pool
   * needs, and an ALTER TABLE parked behind it with every later query
   * queued behind that. The histogram existed and nothing wrote to it.
   */
  describe('duration reporting', () => {
    it('reports a committed transaction', async () => {
      await transactions.run(async () => append());

      expect(recorded.at(-1)).toMatchObject({ outcome: 'commit', isolation: 'READ COMMITTED' });
      expect(recorded.at(-1)!.seconds).toBeGreaterThan(0);
    });

    it('reports a rolled back one too, which is the slow case worth seeing', async () => {
      await expect(
        transactions.run(async () => {
          await append();
          throw new Error('no');
        }),
      ).rejects.toThrow();

      expect(recorded.at(-1)).toMatchObject({ outcome: 'rollback' });
    });

    it('labels the isolation level it actually ran at', async () => {
      await transactions.run(async () => append(), { isolation: 'REPEATABLE READ' });

      expect(recorded.at(-1)).toMatchObject({ isolation: 'REPEATABLE READ' });
    });
  });

  describe('after-commit effects', () => {
    const rowCount = async (): Promise<number> => {
      const [row] = (await dataSource.query(
        'SELECT count(*)::int AS n FROM ledger.outbox_messages',
      )) as Array<{ n: number }>;
      return row!.n;
    };

    /**
     * The reason this exists. Invalidating a cache *inside* the
     * transaction lets a concurrent reader miss, read the pre-commit row
     * and repopulate the cache with the old value — the write lands and
     * the cache stays stale with no further event coming to fix it.
     */
    it('runs the effect only after the row is visible to everybody else', async () => {
      let visibleWhenEffectRan = -1;

      await transactions.run(async () => {
        await append();
        transactions.afterCommit(async () => {
          // A fresh connection from the pool: it can only see committed data.
          visibleWhenEffectRan = await rowCount();
        });

        // Not yet — the transaction is still open.
        expect(visibleWhenEffectRan).toBe(-1);
      });

      expect(visibleWhenEffectRan).toBe(1);
    });

    it('drops the effect when the transaction rolls back', async () => {
      let ran = false;

      await expect(
        transactions.run(async () => {
          await append();
          transactions.afterCommit(() => {
            ran = true;
          });
          throw new Error('business rule said no');
        }),
      ).rejects.toThrow('business rule said no');

      expect(ran).toBe(false);
      expect(await rowCount()).toBe(0);
    });

    it('runs several effects in the order they were registered', async () => {
      const order: number[] = [];

      await transactions.run(async () => {
        transactions.afterCommit(() => void order.push(1));
        transactions.afterCommit(() => void order.push(2));
        transactions.afterCommit(() => void order.push(3));
      });

      expect(order).toEqual([1, 2, 3]);
    });

    /**
     * The write is already durable; a Redis blip must not turn a
     * successful payment into a failed request.
     */
    it('does not fail the transaction when an effect throws', async () => {
      const after: string[] = [];

      await expect(
        transactions.run(async () => {
          await append();
          transactions.afterCommit(() => {
            throw new Error('redis unreachable');
          });
          transactions.afterCommit(() => void after.push('still ran'));
        }),
      ).resolves.toBeUndefined();

      expect(after).toEqual(['still ran']);
      expect(await rowCount()).toBe(1);
    });

    /** Callers should not have to know whether they are in one. */
    it('runs immediately when there is no transaction', async () => {
      let ran = false;

      transactions.afterCommit(() => {
        ran = true;
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(ran).toBe(true);
    });

    /** A nested REQUIRED call joins the outer unit of work, and so do its effects. */
    it('defers a nested call to the outermost commit', async () => {
      let ranBeforeOuterFinished = false;
      let ran = false;

      await transactions.run(async () => {
        await transactions.run(async () => {
          transactions.afterCommit(() => {
            ran = true;
          });
        });
        ranBeforeOuterFinished = ran;
      });

      expect(ranBeforeOuterFinished).toBe(false);
      expect(ran).toBe(true);
    });
  });
});
