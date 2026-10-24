import { describe, expect, it } from 'vitest';
import { Currency } from './currency.js';
import { CurrencyMismatchError, Money, RoundingMode, divideWithRounding } from './money.js';

describe('Money', () => {
  describe('construction', () => {
    it('parses a decimal string into exact minor units', () => {
      expect(Money.fromMajor('19.99', 'USD').amount).toBe(1999n);
      expect(Money.fromMajor('0.01', 'USD').amount).toBe(1n);
      expect(Money.fromMajor('1000000', 'USD').amount).toBe(100_000_000n);
    });

    it('respects the currency exponent', () => {
      expect(Money.fromMajor('100', 'JPY').amount).toBe(100n);
      expect(Money.fromMajor('0.00000001', 'BTC').amount).toBe(1n);
    });

    it('rejects more precision than the currency has', () => {
      const result = Money.parseMajor('1.999', 'USD');
      expect(result.isErr()).toBe(true);
      expect(result.unwrapErr().code).toBe('AMOUNT_PRECISION_EXCEEDED');
    });

    it('rejects values that are not decimal numbers', () => {
      for (const input of ['abc', '1.2.3', '', '1e5', '--1']) {
        expect(Money.parseMajor(input, 'USD').isErr()).toBe(true);
      }
    });

    /**
     * The reason the whole class exists: 0.1 + 0.2 !== 0.3 in IEEE-754, but
     * it must be exactly 0.30 here.
     */
    it('does not lose precision the way floats do', () => {
      const sum = Money.fromMajor('0.1', 'USD').add(Money.fromMajor('0.2', 'USD'));
      expect(sum.toMajorString()).toBe('0.30');
      expect(0.1 + 0.2).not.toBe(0.3);
    });

    it('handles amounts beyond Number.MAX_SAFE_INTEGER', () => {
      const huge = Money.fromMinor('90071992547409910', 'USD');
      expect(huge.add(Money.fromMinor(1n, 'USD')).amount).toBe(90_071_992_547_409_911n);
    });
  });

  describe('arithmetic', () => {
    it('refuses to mix currencies', () => {
      expect(() => Money.fromMajor('1', 'USD').add(Money.fromMajor('1', 'EUR'))).toThrow(
        CurrencyMismatchError,
      );
    });

    it('is immutable', () => {
      const original = Money.fromMajor('10.00', 'USD');
      original.add(Money.fromMajor('5.00', 'USD'));
      expect(original.toMajorString()).toBe('10.00');
    });

    it('computes a percentage in basis points with banker’s rounding', () => {
      // 2.90 % of 10.05 = 0.29145 → 0.29
      expect(Money.fromMajor('10.05', 'USD').percentage(290).toMajorString()).toBe('0.29');
      // Exactly .5 rounds to the nearest even minor unit.
      expect(Money.fromMinor(5n, 'USD').multiplyRatio(1n, 2n).amount).toBe(2n);
      expect(Money.fromMinor(7n, 'USD').multiplyRatio(1n, 2n).amount).toBe(4n);
    });
  });

  describe('allocate', () => {
    it('never loses a minor unit', () => {
      const parts = Money.fromMajor('0.05', 'USD').allocate([3, 7]);
      expect(parts.map((part) => part.toMajorString())).toEqual(['0.02', '0.03']);
      expect(Money.sum(parts).toMajorString()).toBe('0.05');
    });

    it('splits an indivisible amount without creating or destroying money', () => {
      const parts = Money.fromMajor('100.00', 'USD').split(3);
      expect(parts.map((part) => part.amount)).toEqual([3334n, 3333n, 3333n]);
      expect(Money.sum(parts).toMajorString()).toBe('100.00');
    });

    /**
     * Largest remainder (Hamilton): the leftover unit goes to the share
     * with the biggest discarded fraction, not to whoever happens to be
     * first in the array. Handing it to index 0 also sums correctly, but
     * biases every split in the same direction.
     */
    it('gives the leftover unit to the largest remainder, not the first share', () => {
      // 0.05 by [5, 1]: shares are 4 + 0 with remainders 1/6 and 5/6.
      expect(Money.fromMajor('0.05', 'USD').allocate([5, 1]).map((p) => p.toMajorString())).toEqual([
        '0.04',
        '0.01',
      ]);

      // Mirrored weights mirror the result — the order of the array does
      // not decide who wins.
      expect(Money.fromMajor('0.05', 'USD').allocate([1, 5]).map((p) => p.toMajorString())).toEqual([
        '0.01',
        '0.04',
      ]);
    });

    it('breaks exact ties by position, so the result is deterministic', () => {
      expect(Money.fromMajor('0.03', 'USD').allocate([1, 1]).map((p) => p.amount)).toEqual([2n, 1n]);
    });

    it('conserves the total for any weights', () => {
      const weightSets = [[1, 1, 1], [7, 3], [5, 1], [1, 2, 3, 4], [10, 10, 1]];

      for (const weights of weightSets) {
        for (const major of ['0.01', '0.05', '1.00', '99.99']) {
          const amount = Money.fromMajor(major, 'USD');
          const parts = amount.allocate(weights);

          expect(Money.sum(parts).amount, `${major} / [${weights.join(', ')}]`).toBe(amount.amount);
          expect(parts).toHaveLength(weights.length);
        }
      }
    });

    it('gives a zero weight nothing', () => {
      expect(Money.fromMajor('1.00', 'USD').allocate([1, 0]).map((p) => p.amount)).toEqual([
        100n,
        0n,
      ]);
    });

    it('rejects weights that cannot define a split', () => {
      expect(() => Money.fromMajor('1.00', 'USD').allocate([])).toThrow();
      expect(() => Money.fromMajor('1.00', 'USD').allocate([0, 0])).toThrow();
      expect(() => Money.fromMajor('1.00', 'USD').allocate([-1, 2])).toThrow();
    });

    it('keeps the sign on negative amounts', () => {
      const parts = Money.fromMajor('-0.05', 'USD').allocate([1, 1]);
      expect(Money.sum(parts).toMajorString()).toBe('-0.05');
      expect(parts.every((part) => part.isNegative())).toBe(true);
    });
  });

  describe('serialisation', () => {
    it('round-trips through JSON without precision loss', () => {
      const original = Money.fromMinor('123456789012345678', 'USD');
      const restored = Money.fromJSON(JSON.parse(JSON.stringify(original)));
      expect(restored.amount).toBe(original.amount);
    });

    it('formats zero-decimal currencies correctly', () => {
      expect(Money.fromMinor(1500n, 'JPY').toMajorString()).toBe('1500');
      expect(Money.fromMinor(-250n, 'USD').toMajorString()).toBe('-2.50');
    });
  });
});

describe('divideWithRounding', () => {
  const cases: Array<[bigint, bigint, RoundingMode, bigint]> = [
    [5n, 2n, RoundingMode.HalfEven, 2n],
    [7n, 2n, RoundingMode.HalfEven, 4n],
    [5n, 2n, RoundingMode.HalfUp, 3n],
    [5n, 2n, RoundingMode.Down, 2n],
    [5n, 2n, RoundingMode.Up, 3n],
    [-5n, 2n, RoundingMode.Floor, -3n],
    [-5n, 2n, RoundingMode.Ceil, -2n],
    [-5n, 2n, RoundingMode.Down, -2n],
  ];

  it.each(cases)('divides %s/%s with %s → %s', (numerator, denominator, mode, expected) => {
    expect(divideWithRounding(numerator, denominator, mode)).toBe(expected);
  });

  it('rejects division by zero', () => {
    expect(() => divideWithRounding(1n, 0n, RoundingMode.HalfEven)).toThrow();
  });
});

describe('Currency', () => {
  it('rejects unknown codes rather than guessing an exponent', () => {
    expect(Currency.parse('XYZ').isErr()).toBe(true);
    expect(() => Currency.of('XYZ')).toThrow();
  });

  it('is interned, so equality is cheap', () => {
    expect(Currency.of('usd')).toBe(Currency.of('USD'));
  });

  /**
   * The bound exists because the storage has one and `BigInt` does not.
   *
   * Measured before it was added: an amount of 1e30 passed currency
   * parsing, the precision rule, the positivity rule, fee calculation and
   * the whole command handler, and failed in Postgres with "value out of
   * range for type bigint" — delivered to the caller as a 500 for input
   * the caller chose.
   */
  describe('the range a bigint column can hold', () => {
    const MAX = 9_223_372_036_854_775_807n;

    it('accepts the largest storable amount', () => {
      const result = Money.parseMajor('92233720368547758.07', 'USD');

      expect(result.isOk()).toBe(true);
      expect(result.unwrap().amount).toBe(MAX);
    });

    it('refuses one minor unit more, as a value rather than a throw', () => {
      const result = Money.parseMajor('92233720368547758.08', 'USD');

      expect(result.isErr()).toBe(true);
      expect(result.isErr() && result.error).toMatchObject({ code: 'AMOUNT_OUT_OF_RANGE' });
    });

    it('refuses an absurd amount rather than letting the database do it', () => {
      expect(Money.parseMajor('1000000000000000000000000000000.00', 'USD').isErr()).toBe(true);
    });

    it('refuses it on the trusted path too, where there is no Result to return', () => {
      expect(() => Money.fromMinor((MAX + 1n).toString(), 'USD')).toThrow();
    });

    it('still accepts an ordinary amount', () => {
      expect(Money.parseMajor('10.50', 'USD').unwrap().amount).toBe(1050n);
    });
  });
});
