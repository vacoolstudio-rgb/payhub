import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { DataSource, type EntityManager, type QueryRunner } from 'typeorm';
import { ConcurrencyError } from '@payhub/kernel';
import { backoffDelay } from '@payhub/shared';
import {
  TRANSACTION_OBSERVER,
  type TransactionObserver,
} from './transaction-observer.port.js';
import { setTimeout as delay } from 'node:timers/promises';

export type IsolationLevel =
  | 'READ UNCOMMITTED'
  | 'READ COMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE';

export type Propagation =
  /** Join the ambient transaction, or start one when there is none. */
  | 'REQUIRED'
  /** Always open a brand new transaction on a separate connection. */
  | 'REQUIRES_NEW'
  /** Fail loudly if there is no ambient transaction. */
  | 'MANDATORY'
  /** Run outside of any transaction. */
  | 'NOT_SUPPORTED';

export interface TransactionOptions {
  readonly isolation?: IsolationLevel;
  readonly propagation?: Propagation;
  /** Retries on serialization failure / deadlock. 0 disables retrying. */
  readonly retries?: number;
  readonly readOnly?: boolean;
}

const CLS_ENTITY_MANAGER = 'payhub:entity-manager';
const CLS_AFTER_COMMIT = 'payhub:after-commit';

/** SQLSTATEs that mean "nothing is wrong with your query, just run it again". */
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

/**
 * Unit of Work.
 *
 * The active `EntityManager` lives in AsyncLocalStorage, so repositories pick
 * it up implicitly: no `manager` parameter threaded through every method, and
 * no accidental write outside the transaction because somebody forgot to pass
 * it down.
 */
@Injectable()
export class TransactionManager {
  private readonly logger = new Logger(TransactionManager.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly cls: ClsService,
    @Optional()
    @Inject(TRANSACTION_OBSERVER)
    private readonly observer?: TransactionObserver,
  ) {}

  /** The manager repositories must use: ambient transaction, else the pool. */
  get manager(): EntityManager {
    return this.cls.get<EntityManager | undefined>(CLS_ENTITY_MANAGER) ?? this.dataSource.manager;
  }

  isInTransaction(): boolean {
    return this.cls.isActive() && this.cls.get(CLS_ENTITY_MANAGER) !== undefined;
  }

  /**
   * Defers a side effect until the transaction has actually committed.
   *
   * This is what makes cache invalidation correct. Busting a key *inside*
   * the transaction opens a window where a concurrent reader misses, reads
   * the pre-commit row and repopulates the cache with the old value — the
   * write lands and the cache is stale with no further event coming to fix
   * it. The same reasoning applies to anything the outside world can
   * observe: a push notification for a payment that then rolls back is
   * worse than one that arrives a millisecond later.
   *
   * Outside a transaction the effect runs immediately, so callers do not
   * have to know which case they are in. Registered effects are dropped on
   * rollback, and on a retry the previous attempt's effects go with it.
   */
  afterCommit(effect: () => Promise<void> | void): void {
    const pending = this.cls.isActive()
      ? this.cls.get<Array<() => Promise<void> | void> | undefined>(CLS_AFTER_COMMIT)
      : undefined;

    if (!pending) {
      void this.settle([effect]);
      return;
    }

    pending.push(effect);
  }

  async run<T>(work: (manager: EntityManager) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const {
      isolation = 'READ COMMITTED',
      propagation = 'REQUIRED',
      retries = isolation === 'SERIALIZABLE' || isolation === 'REPEATABLE READ' ? 3 : 0,
      readOnly = false,
    } = options;

    const ambient = this.cls.isActive()
      ? this.cls.get<EntityManager | undefined>(CLS_ENTITY_MANAGER)
      : undefined;

    switch (propagation) {
      case 'NOT_SUPPORTED':
        return work(this.dataSource.manager);

      case 'MANDATORY':
        if (!ambient) {
          throw new Error('Propagation MANDATORY requires an active transaction');
        }
        return work(ambient);

      case 'REQUIRED':
        if (ambient) {
          // Nested call joins the outer transaction: one commit, one rollback.
          return work(ambient);
        }
        break;

      case 'REQUIRES_NEW':
        break;
    }

    return this.runWithRetries(work, { isolation, retries, readOnly });
  }

  private async runWithRetries<T>(
    work: (manager: EntityManager) => Promise<T>,
    options: { isolation: IsolationLevel; retries: number; readOnly: boolean },
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      const runner = this.dataSource.createQueryRunner();

      try {
        return await this.executeOnce(runner, work, options);
      } catch (error) {
        lastError = error;

        if (attempt < options.retries && isRetryableTransactionError(error)) {
          const waitMs = backoffDelay(attempt, 10, 200);
          this.logger.warn(
            `Transaction conflict (${sqlStateOf(error)}), retry ${attempt + 1}/${options.retries} in ${waitMs}ms`,
          );
          await delay(waitMs);
          continue;
        }

        throw error;
      } finally {
        await runner.release();
      }
    }

    throw lastError;
  }

  /**
   * Timed, because transaction duration is what explains the two
   * failures that actually hurt: a long transaction holds a connection
   * the pool needs, and it parks an `ALTER TABLE` behind it with every
   * subsequent query queued behind that.
   */
  private async executeOnce<T>(
    runner: QueryRunner,
    work: (manager: EntityManager) => Promise<T>,
    options: { isolation: IsolationLevel; readOnly: boolean },
  ): Promise<T> {
    const startedAt = process.hrtime.bigint();
    const elapsed = (): number => Number(process.hrtime.bigint() - startedAt) / 1e9;
    await runner.connect();
    await runner.startTransaction(options.isolation);

    if (options.readOnly) {
      await runner.query('SET TRANSACTION READ ONLY');
    }

    try {
      const effects: Array<() => Promise<void> | void> = [];

      const result = await this.cls.run({ ifNested: 'inherit' }, async () => {
        this.cls.set(CLS_ENTITY_MANAGER, runner.manager);
        this.cls.set(CLS_AFTER_COMMIT, effects);
        return work(runner.manager);
      });

      await runner.commitTransaction();
      this.observer?.record(options.isolation, 'commit', elapsed());

      // After the commit, and deliberately not awaited inside it: a slow
      // Redis must not hold a Postgres connection open.
      await this.settle(effects);
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      this.observer?.record(options.isolation, 'rollback', elapsed());
      throw error;
    }
  }

  /** An after-commit effect can no longer undo anything, so it cannot fail. */
  private async settle(effects: ReadonlyArray<() => Promise<void> | void>): Promise<void> {
    for (const effect of effects) {
      try {
        await effect();
      } catch (error) {
        this.logger.error(
          `After-commit effect failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

export function isRetryableTransactionError(error: unknown): boolean {
  const state = sqlStateOf(error);
  return (state !== undefined && RETRYABLE_SQLSTATES.has(state)) || error instanceof ConcurrencyError;
}

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as { code?: string; driverError?: { code?: string } };
  return candidate.driverError?.code ?? candidate.code;
}
