import { describe, expect, it } from 'vitest';
import { Money } from '@payhub/kernel';
import { AccountRef } from './account-ref.vo.js';
import { JournalEntry, type PostingLine, TransferId, TransferPurpose } from './journal-entry.aggregate.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const usd = (major: string) => Money.fromMajor(major, 'USD');

function lines(overrides: Partial<Record<'debit' | 'credit', string>> = {}): PostingLine[] {
  return [
    {
      account: AccountRef.external('acquirer', 'USD'),
      direction: 'debit',
      amount: usd(overrides.debit ?? '100.00'),
    },
    {
      account: AccountRef.userAvailable(USER, 'USD'),
      direction: 'credit',
      amount: usd(overrides.credit ?? '100.00'),
    },
  ];
}

describe('JournalEntry', () => {
  it('accepts a balanced entry', () => {
    const entry = JournalEntry.create({
      id: TransferId.create(),
      purpose: TransferPurpose.Capture,
      description: 'deposit',
      lines: lines(),
    });

    expect(entry.isOk()).toBe(true);
  });

  /** The single most important invariant in the whole system. */
  it('refuses an unbalanced entry', () => {
    const entry = JournalEntry.create({
      id: TransferId.create(),
      purpose: TransferPurpose.Capture,
      description: 'broken',
      lines: lines({ credit: '99.00' }),
    });

    expect(entry.isErr()).toBe(true);
    expect(entry.unwrapErr().code).toBe('UNBALANCED_ENTRY');
  });

  it('balances per currency, not across currencies', () => {
    const entry = JournalEntry.create({
      id: TransferId.create(),
      purpose: TransferPurpose.Capture,
      description: 'mixed',
      lines: [
        { account: AccountRef.external('psp', 'USD'), direction: 'debit', amount: usd('10.00') },
        {
          account: AccountRef.userAvailable(USER, 'USD'),
          direction: 'credit',
          amount: usd('10.00'),
        },
        {
          account: AccountRef.external('psp', 'EUR'),
          direction: 'debit',
          amount: Money.fromMajor('10.00', 'EUR'),
        },
      ],
    });

    expect(entry.isErr()).toBe(true);
  });

  it('rejects a single-sided entry', () => {
    const entry = JournalEntry.create({
      id: TransferId.create(),
      purpose: TransferPurpose.Capture,
      description: 'one line',
      lines: [lines()[0]!],
    });

    expect(entry.unwrapErr().code).toBe('UNBALANCED_ENTRY');
  });

  it('rejects zero and negative postings', () => {
    const zero = JournalEntry.create({
      id: TransferId.create(),
      purpose: TransferPurpose.Capture,
      description: 'zero',
      lines: lines({ debit: '0', credit: '0' }),
    });
    expect(zero.unwrapErr().code).toBe('ZERO_POSTING');

    const negative = JournalEntry.create({
      id: TransferId.create(),
      purpose: TransferPurpose.Capture,
      description: 'negative',
      lines: [
        {
          account: AccountRef.external('psp', 'USD'),
          direction: 'debit',
          amount: usd('100.00').negate(),
        },
        {
          account: AccountRef.userAvailable(USER, 'USD'),
          direction: 'credit',
          amount: usd('100.00').negate(),
        },
      ],
    });
    expect(negative.unwrapErr().code).toBe('NEGATIVE_POSTING');
  });

  it('rejects a posting whose currency does not match its account', () => {
    const entry = JournalEntry.create({
      id: TransferId.create(),
      purpose: TransferPurpose.Capture,
      description: 'mismatch',
      lines: [
        {
          account: AccountRef.external('psp', 'EUR'),
          direction: 'debit',
          amount: usd('10.00'),
        },
        {
          account: AccountRef.userAvailable(USER, 'USD'),
          direction: 'credit',
          amount: usd('10.00'),
        },
      ],
    });

    expect(entry.unwrapErr().code).toBe('CURRENCY_MISMATCH');
  });

  describe('reversal', () => {
    it('produces a mirror entry that nets to zero', () => {
      const original = JournalEntry.create({
        id: TransferId.create(),
        purpose: TransferPurpose.Capture,
        description: 'deposit',
        lines: lines(),
      }).unwrap();

      const reversal = original.reverse(TransferId.create(), 'customer dispute').unwrap();
      const account = AccountRef.userAvailable(USER, 'USD');

      expect(original.netFor(account).add(reversal.netFor(account)).isZero()).toBe(true);
      expect(original.isReversed).toBe(true);
      expect(reversal.reverses).toBe(original.id);
    });
  });

  describe('netFor', () => {
    it('treats a credit to a liability account as an increase', () => {
      const entry = JournalEntry.create({
        id: TransferId.create(),
        purpose: TransferPurpose.Capture,
        description: 'deposit',
        lines: lines(),
      }).unwrap();

      expect(entry.netFor(AccountRef.userAvailable(USER, 'USD')).toMajorString()).toBe('100.00');
      // An asset account grows on the debit side instead.
      expect(entry.netFor(AccountRef.external('acquirer', 'USD')).toMajorString()).toBe('100.00');
      expect(entry.netFor(AccountRef.userAvailable(OTHER, 'USD')).isZero()).toBe(true);
    });
  });
});

describe('AccountRef', () => {
  it('round-trips through its string form', () => {
    const original = AccountRef.userAvailable(USER, 'USD');
    expect(AccountRef.parse(original.toString()).unwrap().equals(original)).toBe(true);
  });

  it('rejects malformed references', () => {
    for (const input of ['user:not-a-uuid:available:USD', 'nope', 'house:unknown:USD', 'user::available:USD']) {
      expect(AccountRef.parse(input).isErr()).toBe(true);
    }
  });
});
