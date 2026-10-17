import { beforeEach, describe, expect, it } from 'vitest';
import { Money } from '@payhub/kernel';
import type { PostingLine } from './journal-entry.aggregate.js';
import { TransferPlanner } from './transfer-planner.service.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const usd = (major: string) => Money.fromMajor(major, 'USD');

/** Every plan the planner produces must balance; this is the shared assertion. */
function expectBalanced(lines: PostingLine[]): void {
  const debits = lines
    .filter((line) => line.direction === 'debit')
    .reduce((sum, line) => sum.add(line.amount), Money.zero('USD'));
  const credits = lines
    .filter((line) => line.direction === 'credit')
    .reduce((sum, line) => sum.add(line.amount), Money.zero('USD'));

  expect(debits.toMajorString()).toBe(credits.toMajorString());
}

describe('TransferPlanner', () => {
  let planner: TransferPlanner;

  beforeEach(() => {
    planner = new TransferPlanner();
  });

  it('plans a deposit: provider debited, user and house credited', () => {
    const lines = planner
      .planDeposit({ userId: ALICE, amount: usd('100.00'), fee: usd('3.20'), provider: 'card' })
      .unwrap();

    expectBalanced(lines);
    expect(lines.map((line) => `${line.direction} ${line.account.toString()} ${line.amount.toMajorString()}`)).toEqual([
      'debit external:card:USD 100.00',
      `credit user:${ALICE}:available:USD 96.80`,
      'credit house:fees:USD 3.20',
    ]);
  });

  it('plans a withdrawal: user debited for amount plus fee', () => {
    const lines = planner
      .planWithdrawal({ userId: ALICE, amount: usd('50.00'), fee: usd('1.00'), provider: 'sepa' })
      .unwrap();

    expectBalanced(lines);
    expect(lines[0]?.amount.toMajorString()).toBe('51.00');
  });

  it('plans an internal transfer without touching an external account', () => {
    const lines = planner
      .planTransfer({ fromUserId: ALICE, toUserId: BOB, amount: usd('20.00'), fee: usd('0.50') })
      .unwrap();

    expectBalanced(lines);
    expect(lines.some((line) => line.account.kind === 'external')).toBe(false);
  });

  it('refuses a transfer to the same user', () => {
    const result = planner.planTransfer({
      fromUserId: ALICE,
      toUserId: ALICE,
      amount: usd('1.00'),
      fee: Money.zero('USD'),
    });

    expect(result.unwrapErr().code).toBe('SELF_TRANSFER');
  });

  it('refuses a deposit whose fee swallows the amount', () => {
    const result = planner.planDeposit({
      userId: ALICE,
      amount: usd('1.00'),
      fee: usd('1.00'),
      provider: 'card',
    });

    expect(result.unwrapErr().code).toBe('FEE_EXCEEDS_AMOUNT');
  });

  it('refuses to mix currencies in one operation', () => {
    const result = planner.planDeposit({
      userId: ALICE,
      amount: usd('10.00'),
      fee: Money.fromMajor('1.00', 'EUR'),
      provider: 'card',
    });

    expect(result.unwrapErr().code).toBe('CURRENCY_MISMATCH');
  });

  it('hold and release are exact mirrors of each other', () => {
    const hold = planner.planHold(ALICE, usd('10.00'));
    const release = planner.planRelease(ALICE, usd('10.00'));

    expectBalanced(hold);
    expectBalanced(release);
    expect(hold[0]?.account.toString()).toBe(release[1]?.account.toString());
    expect(hold[0]?.direction).not.toBe(release[1]?.direction);
  });
});
