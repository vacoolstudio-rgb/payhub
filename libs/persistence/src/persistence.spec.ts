import { describe, expect, it } from 'vitest';
import { ConcurrencyError } from '@payhub/kernel';
import { normaliseReturning } from './outbox/outbox.repository.js';
import { SnakeNamingStrategy } from './typeorm/snake-naming.strategy.js';
import { isRetryableTransactionError } from './transaction.manager.js';
import { bigintTransformer, minorUnitsTransformer } from './typeorm/transformers.js';

describe('normaliseReturning', () => {
  /**
   * Regression: TypeORM's Postgres driver returns `rows` for a SELECT but
   * `[rows, rowCount]` for an UPDATE…RETURNING. Reading the second shape as
   * the first yields an array whose first element is an array, so every
   * field reads as `undefined` — silently.
   */
  it('unwraps the [rows, count] shape an UPDATE returns', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];

    expect(normaliseReturning<{ id: string }>([rows, 2])).toEqual(rows);
  });

  it('passes a plain row array through', () => {
    const rows = [{ id: 'a' }];

    expect(normaliseReturning<{ id: string }>(rows)).toEqual(rows);
  });

  it('handles empty and non-array results', () => {
    expect(normaliseReturning([])).toEqual([]);
    expect(normaliseReturning(null)).toEqual([]);
    expect(normaliseReturning(undefined)).toEqual([]);
  });
});

describe('isRetryableTransactionError', () => {
  /** 40001 and 40P01 mean "nothing is wrong with your query, run it again". */
  it('retries serialization failures and deadlocks', () => {
    expect(isRetryableTransactionError({ code: '40001' })).toBe(true);
    expect(isRetryableTransactionError({ driverError: { code: '40P01' } })).toBe(true);
  });

  it('retries an optimistic-lock miss, which is the same race one layer up', () => {
    expect(isRetryableTransactionError(new ConcurrencyError('Wallet', 'id', 3))).toBe(true);
  });

  it('does not retry anything deterministic', () => {
    expect(isRetryableTransactionError({ code: '23505' })).toBe(false);
    expect(isRetryableTransactionError({ code: '23514' })).toBe(false);
    expect(isRetryableTransactionError(new Error('boom'))).toBe(false);
    expect(isRetryableTransactionError(null)).toBe(false);
    expect(isRetryableTransactionError('40001')).toBe(false);
  });
});

describe('SnakeNamingStrategy', () => {
  const strategy = new SnakeNamingStrategy();

  /**
   * The default strategy keeps the property name, so `aggregateType`
   * becomes a column literally called "aggregateType" while the migration
   * creates `aggregate_type`. The mismatch only shows up at runtime.
   */
  it('converts property names to snake_case', () => {
    expect(strategy.columnName('aggregateType', undefined, [])).toBe('aggregate_type');
    expect(strategy.columnName('availableMinor', undefined, [])).toBe('available_minor');
    expect(strategy.columnName('id', undefined, [])).toBe('id');
    expect(strategy.columnName('lastUsedAt', undefined, [])).toBe('last_used_at');
  });

  it('lets an explicit name win', () => {
    expect(strategy.columnName('anything', 'custom_name', [])).toBe('custom_name');
  });

  it('prefixes embedded columns', () => {
    expect(strategy.columnName('amount', undefined, ['totalPrice'])).toBe('total_price_amount');
  });

  it('derives table, join column and relation names', () => {
    expect(strategy.tableName('JournalEntryEntity', undefined)).toBe('journal_entry_entity');
    expect(strategy.tableName('Anything', 'journal_entries')).toBe('journal_entries');
    expect(strategy.joinColumnName('entry', 'id')).toBe('entry_id');
  });

  it('produces deterministic, schema-free constraint names', () => {
    expect(strategy.indexName('ledger.postings', ['account', 'posted_at'])).toBe(
      'ix_postings_account_posted_at',
    );
    expect(strategy.primaryKeyName('wallets', ['id'])).toBe('pk_wallets_id');
    expect(strategy.foreignKeyName('postings', ['entry_id'])).toBe('fk_postings_entry_id');
  });
});

describe('column transformers', () => {
  /** Postgres bigint arrives as a string; it must never become a number. */
  it('round-trips bigint through its string representation', () => {
    expect(bigintTransformer.to(90_071_992_547_409_931n)).toBe('90071992547409931');
    expect(bigintTransformer.from('90071992547409931')).toBe(90_071_992_547_409_931n);
    expect(bigintTransformer.to(null)).toBeNull();
    expect(bigintTransformer.from(null)).toBeNull();
  });

  it('treats a missing minor-unit column as zero, not null', () => {
    expect(minorUnitsTransformer.from(null)).toBe(0n);
    expect(minorUnitsTransformer.from('-250')).toBe(-250n);
    expect(minorUnitsTransformer.to(1234n)).toBe('1234');
  });

  it('survives values beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = '9007199254740993';

    expect(minorUnitsTransformer.from(huge).toString()).toBe(huge);
    expect(Number(huge).toString()).not.toBe(huge);
  });
});
