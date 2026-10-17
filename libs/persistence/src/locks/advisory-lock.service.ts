import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { TransactionManager } from '../transaction.manager.js';

/**
 * Postgres advisory locks.
 *
 * The honest alternative to Redlock when you already have a database in the
 * transaction: the lock and the data live in the same system, so there is no
 * window where the lock expires while the work is still committing. Kleppmann's
 * critique of Redlock (clock drift + GC pauses breaking mutual exclusion)
 * simply does not apply — `pg_advisory_xact_lock` is released by the same
 * commit that makes the work visible.
 *
 * Trade-off: it holds a connection for the duration of the lock, so it is the
 * right tool for short critical sections (a cron leader election, a per-wallet
 * serialisation point) and the wrong one for minute-long jobs on a small pool.
 */
@Injectable()
export class AdvisoryLockService {
  private readonly logger = new Logger(AdvisoryLockService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly transactions: TransactionManager,
  ) {}

  /** Deterministic 63-bit key derived from a human readable name. */
  static keyOf(name: string): bigint {
    const digest = createHash('sha256').update(name).digest();
    // Clear the top bit so the value always fits in a signed bigint.
    return BigInt(`0x${digest.subarray(0, 8).toString('hex')}`) & 0x7fffffffffffffffn;
  }

  /**
   * Transaction-scoped lock: queues until the lock is free, releases on
   * COMMIT/ROLLBACK. Must be called inside a transaction.
   */
  async acquireTransactionLock(name: string): Promise<void> {
    if (!this.transactions.isInTransaction()) {
      throw new Error(`acquireTransactionLock(${name}) must run inside a transaction`);
    }
    await this.transactions.manager.query('SELECT pg_advisory_xact_lock($1)', [
      AdvisoryLockService.keyOf(name).toString(),
    ]);
  }

  /** Non-blocking variant: returns false immediately when somebody holds it. */
  async tryAcquireTransactionLock(name: string): Promise<boolean> {
    if (!this.transactions.isInTransaction()) {
      throw new Error(`tryAcquireTransactionLock(${name}) must run inside a transaction`);
    }
    const rows = await this.transactions.manager.query<Array<{ locked: boolean }>>(
      'SELECT pg_try_advisory_xact_lock($1) AS locked',
      [AdvisoryLockService.keyOf(name).toString()],
    );
    return rows[0]?.locked === true;
  }

  /**
   * Session-scoped lock used for leader election across instances. Runs the
   * callback only if this instance won; always releases, even on throw.
   */
  async withSessionLock<T>(name: string, work: () => Promise<T>): Promise<T | null> {
    const key = AdvisoryLockService.keyOf(name).toString();
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    try {
      const rows = (await runner.query('SELECT pg_try_advisory_lock($1) AS locked', [
        key,
      ])) as Array<{ locked: boolean }>;

      if (rows[0]?.locked !== true) {
        this.logger.debug(`Advisory lock "${name}" is held elsewhere — skipping`);
        return null;
      }

      try {
        return await work();
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [key]);
      }
    } finally {
      await runner.release();
    }
  }
}
