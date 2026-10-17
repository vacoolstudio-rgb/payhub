import { describe, expect, it } from 'vitest';
import { Money } from '@payhub/kernel';
import { FeePolicy } from './fee-policy.vo.js';

const usd = (major: string) => Money.fromMajor(major, 'USD');

describe('FeePolicy', () => {
  it('applies percentage plus fixed, the familiar card shape', () => {
    const policy = FeePolicy.default(); // 2.90 % + 0.30
    expect(policy.calculate(usd('100.00')).toMajorString()).toBe('3.20');
    expect(policy.calculate(usd('10.00')).toMajorString()).toBe('0.59');
  });

  it('rounds half to even so neither side is systematically favoured', () => {
    const policy = FeePolicy.create({ basisPoints: 50 }).unwrap(); // 0.50 %
    // 0.5 % of 1.50 = 0.0075 → 0.01 (nearest even hundredth is 0.008 → 0.01)
    expect(policy.calculate(usd('1.50')).amount).toBe(1n);
    // 0.5 % of 0.50 = 0.0025 → 0.00
    expect(policy.calculate(usd('0.50')).amount).toBe(0n);
  });

  it('honours the minimum and the cap', () => {
    const policy = FeePolicy.create({
      basisPoints: 100,
      minimumMinor: 50n,
      maximumMinor: 500n,
    }).unwrap();

    expect(policy.calculate(usd('1.00')).toMajorString()).toBe('0.50');
    expect(policy.calculate(usd('1000.00')).toMajorString()).toBe('5.00');
  });

  it('never charges more than the amount itself', () => {
    const policy = FeePolicy.create({ basisPoints: 10_000, fixedMinor: 1_000n }).unwrap();
    expect(policy.calculate(usd('1.00')).toMajorString()).toBe('1.00');
  });

  it('rejects nonsensical configurations', () => {
    expect(FeePolicy.create({ basisPoints: -1 }).isErr()).toBe(true);
    expect(FeePolicy.create({ basisPoints: 10_001 }).isErr()).toBe(true);
    expect(FeePolicy.create({ basisPoints: 1.5 }).isErr()).toBe(true);
    expect(
      FeePolicy.create({ basisPoints: 100, minimumMinor: 500n, maximumMinor: 100n }).isErr(),
    ).toBe(true);
  });

  it('works for a zero-decimal currency', () => {
    const policy = FeePolicy.create({ basisPoints: 290, fixedMinor: 30n }).unwrap();
    expect(policy.calculate(Money.fromMajor('1000', 'JPY')).toMajorString()).toBe('59');
  });
});
