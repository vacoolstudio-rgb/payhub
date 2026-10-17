import { beforeEach, describe, expect, it } from 'vitest';
import { Money } from '@payhub/kernel';
import { Wallet, WalletId } from './wallet.aggregate.js';

const USER = '11111111-1111-4111-8111-111111111111';
const usd = (major: string) => Money.fromMajor(major, 'USD');

describe('Wallet', () => {
  let wallet: Wallet;

  beforeEach(() => {
    wallet = Wallet.open({ id: WalletId.create(), userId: USER, currency: 'USD' });
    wallet.credit(usd('100.00'));
    wallet.pullDomainEvents();
  });

  it('starts empty and active', () => {
    const fresh = Wallet.open({ id: WalletId.create(), userId: USER, currency: 'USD' });
    expect(fresh.available.isZero()).toBe(true);
    expect(fresh.status).toBe('active');
    expect(fresh.pullDomainEvents().map((event) => event.eventName)).toEqual([
      'ledger.wallet_opened.v1',
    ]);
  });

  /** The invariant a payments platform exists to protect. */
  it('cannot be debited below zero', () => {
    const result = wallet.debit(usd('100.01'));

    expect(result.isErr()).toBe(true);
    expect(result.unwrapErr().code).toBe('INSUFFICIENT_FUNDS');
    expect(wallet.available.toMajorString()).toBe('100.00');
  });

  it('allows a debit of exactly the available balance', () => {
    expect(wallet.debit(usd('100.00')).isOk()).toBe(true);
    expect(wallet.available.isZero()).toBe(true);
  });

  describe('hold / capture / release', () => {
    it('moves money to pending without changing the total', () => {
      wallet.hold(usd('30.00'));

      expect(wallet.available.toMajorString()).toBe('70.00');
      expect(wallet.pending.toMajorString()).toBe('30.00');
      expect(wallet.total.toMajorString()).toBe('100.00');
    });

    it('capture removes the held amount for good', () => {
      wallet.hold(usd('30.00'));
      wallet.capture(usd('30.00'));

      expect(wallet.total.toMajorString()).toBe('70.00');
      expect(wallet.pending.isZero()).toBe(true);
    });

    it('release gives the held amount back', () => {
      wallet.hold(usd('30.00'));
      wallet.release(usd('30.00'));

      expect(wallet.available.toMajorString()).toBe('100.00');
      expect(wallet.pending.isZero()).toBe(true);
    });

    it('cannot hold more than is available', () => {
      expect(wallet.hold(usd('200.00')).unwrapErr().code).toBe('INSUFFICIENT_FUNDS');
    });

    it('cannot capture more than is held', () => {
      wallet.hold(usd('10.00'));
      expect(wallet.capture(usd('20.00')).unwrapErr().code).toBe('INSUFFICIENT_FUNDS');
    });

    /** Double-spend: the same hold must not be captured twice. */
    it('rejects a second capture of the same hold', () => {
      wallet.hold(usd('40.00'));
      expect(wallet.capture(usd('40.00')).isOk()).toBe(true);
      expect(wallet.capture(usd('40.00')).isErr()).toBe(true);
    });
  });

  describe('frozen and closed wallets', () => {
    it('blocks every movement while frozen', () => {
      wallet.freeze('compliance review');

      expect(wallet.debit(usd('1.00')).unwrapErr().code).toBe('WALLET_FROZEN');
      expect(wallet.credit(usd('1.00')).unwrapErr().code).toBe('WALLET_FROZEN');
      expect(wallet.hold(usd('1.00')).unwrapErr().code).toBe('WALLET_FROZEN');
    });

    it('resumes after unfreezing', () => {
      wallet.freeze('review');
      wallet.unfreeze();
      expect(wallet.credit(usd('1.00')).isOk()).toBe(true);
    });

    it('refuses to close a wallet that still holds money', () => {
      expect(wallet.close().isErr()).toBe(true);
      wallet.debit(usd('100.00'));
      expect(wallet.close().isOk()).toBe(true);
    });
  });

  describe('applyPosting', () => {
    it('mirrors the semantic operations', () => {
      expect(wallet.applyPosting('available', 'debit', usd('25.00')).isOk()).toBe(true);
      expect(wallet.applyPosting('pending', 'credit', usd('25.00')).isOk()).toBe(true);

      expect(wallet.available.toMajorString()).toBe('75.00');
      expect(wallet.pending.toMajorString()).toBe('25.00');
    });

    it('refuses to drive a bucket negative', () => {
      expect(wallet.applyPosting('pending', 'debit', usd('1.00')).isErr()).toBe(true);
    });
  });

  it('emits a balance-changed event for every movement', () => {
    wallet.credit(usd('5.00'));
    wallet.debit(usd('2.00'));

    const events = wallet.pullDomainEvents();
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.eventName === 'ledger.wallet_balance_changed.v1')).toBe(
      true,
    );
    // Pulling drains the buffer, so a second publish cannot duplicate them.
    expect(wallet.pullDomainEvents()).toHaveLength(0);
  });

  it('throws on a currency the wallet does not hold — a programming error, not a domain one', () => {
    expect(() => wallet.credit(Money.fromMajor('1.00', 'EUR'))).toThrow();
  });
});
