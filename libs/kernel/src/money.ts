import { Currency } from './currency.js';
import { ValidationError } from './errors.js';
import { type Result, err, ok } from './result.js';
import { ValueObject } from './value-object.js';

/**
 * Rounding policies. `HALF_EVEN` (banker's rounding) is the default for fee
 * calculations because it does not systematically favour either party over a
 * large number of operations.
 */
export const RoundingMode = {
  Up: 'UP',
  Down: 'DOWN',
  Ceil: 'CEIL',
  Floor: 'FLOOR',
  HalfUp: 'HALF_UP',
  HalfDown: 'HALF_DOWN',
  HalfEven: 'HALF_EVEN',
} as const;

export type RoundingMode = (typeof RoundingMode)[keyof typeof RoundingMode];

interface MoneyProps {
  /** Amount in minor units. Stored as bigint: floats cannot represent money. */
  readonly amount: bigint;
  readonly currency: string;
}

export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

export class Money extends ValueObject<MoneyProps> {
  readonly currency: Currency;

  private constructor(amount: bigint, currency: Currency) {
    super({ amount, currency: currency.code });
    this.currency = currency;
  }

  // --- construction -------------------------------------------------------

  /** Trusted construction from minor units. Throws on programmer error. */
  static fromMinor(amount: bigint | number | string, currency: Currency | string): Money {
    const resolved = typeof currency === 'string' ? Currency.of(currency) : currency;
    return new Money(toBigInt(amount), resolved);
  }

  /** `Money.fromMajor('10.50', 'USD')` → 1050 minor units. */
  static fromMajor(amount: string | number, currency: Currency | string): Money {
    const result = Money.parseMajor(amount, currency);
    if (result.isErr()) {
      throw result.error;
    }
    return result.value;
  }

  static zero(currency: Currency | string): Money {
    return new Money(0n, typeof currency === 'string' ? Currency.of(currency) : currency);
  }

  /** Untrusted construction: decimal string from an HTTP body. */
  static parseMajor(
    amount: string | number,
    currency: Currency | string,
  ): Result<Money, ValidationError> {
    const currencyResult =
      typeof currency === 'string' ? Currency.parse(currency) : ok<Currency>(currency);
    if (currencyResult.isErr()) {
      return err(currencyResult.error);
    }
    const resolved = currencyResult.value;

    const raw = typeof amount === 'number' ? amount.toString() : amount.trim();
    const match = /^(-)?(\d+)(?:[.,](\d+))?$/.exec(raw);
    if (!match) {
      return err(
        new ValidationError('Amount must be a decimal number', { amount }, 'INVALID_AMOUNT'),
      );
    }

    const [, sign, integerPart = '0', fractionPart = ''] = match;
    if (fractionPart.length > resolved.exponent) {
      return err(
        new ValidationError(
          `${resolved.code} supports at most ${resolved.exponent} decimal places`,
          { amount, currency: resolved.code },
          'AMOUNT_PRECISION_EXCEEDED',
        ),
      );
    }

    const padded = fractionPart.padEnd(resolved.exponent, '0');
    const minor = BigInt(`${integerPart}${padded}`);

    return ok(new Money(sign === '-' ? -minor : minor, resolved));
  }

  static fromJSON(json: MoneyJson): Money {
    return Money.fromMinor(json.amount, json.currency);
  }

  // --- accessors ----------------------------------------------------------

  /** Amount in minor units (cents, satoshi, …). */
  get amount(): bigint {
    return this.props.amount;
  }

  get currencyCode(): string {
    return this.props.currency;
  }

  isZero(): boolean {
    return this.props.amount === 0n;
  }

  isPositive(): boolean {
    return this.props.amount > 0n;
  }

  isNegative(): boolean {
    return this.props.amount < 0n;
  }

  // --- arithmetic ---------------------------------------------------------

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.props.amount + other.props.amount, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.props.amount - other.props.amount, this.currency);
  }

  negate(): Money {
    return new Money(-this.props.amount, this.currency);
  }

  abs(): Money {
    return this.props.amount < 0n ? this.negate() : this;
  }

  /** Multiplies by an exact rational `numerator / denominator`. */
  multiplyRatio(
    numerator: bigint | number,
    denominator: bigint | number = 1n,
    mode: RoundingMode = RoundingMode.HalfEven,
  ): Money {
    const num = toBigInt(numerator);
    const den = toBigInt(denominator);
    if (den === 0n) {
      throw new ValidationError('Division by zero', {}, 'DIVISION_BY_ZERO');
    }
    return new Money(divideWithRounding(this.props.amount * num, den, mode), this.currency);
  }

  /** `fee = amount.percentage(250)` → 2.50 %. Basis points keep fees exact. */
  percentage(basisPoints: number, mode: RoundingMode = RoundingMode.HalfEven): Money {
    return this.multiplyRatio(BigInt(Math.trunc(basisPoints)), 10_000n, mode);
  }

  /**
   * Splits the amount across weighted shares without losing a minor unit.
   *
   * Uses the **largest remainder method** (Hamilton's): each share gets
   * `floor(amount × weight / total)`, and the leftover units go to the
   * shares whose discarded fraction was largest, ties broken by position.
   *
   * The naive version — handing the leftovers to the first shares in order
   * — also sums correctly, but it is biased: with weights `[5, 1]` and
   * 0.05 it pays `[0.05, 0.00]`, giving the extra cent to the share that
   * had *least* claim on it (remainder 1/6) instead of the one with 5/6.
   * Over a large number of splits that bias is systematic, and in a fee
   * split it is money moving in one direction for no reason.
   *
   * Remainders are compared as exact integers (`amount × weight mod
   * total`), never as floats.
   */
  allocate(weights: ReadonlyArray<number | bigint>): Money[] {
    if (weights.length === 0) {
      throw new ValidationError('allocate() needs at least one weight', {}, 'INVALID_ALLOCATION');
    }
    const bigWeights = weights.map(toBigInt);
    if (bigWeights.some((weight) => weight < 0n)) {
      throw new ValidationError('allocate() weights must be non-negative', {}, 'INVALID_ALLOCATION');
    }
    const total = bigWeights.reduce((sum, weight) => sum + weight, 0n);
    if (total === 0n) {
      throw new ValidationError('allocate() weights must not sum to zero', {}, 'INVALID_ALLOCATION');
    }

    const sign = this.props.amount < 0n ? -1n : 1n;
    const absolute = this.props.amount * sign;

    const shares = bigWeights.map((weight) => (absolute * weight) / total);
    const remainders = bigWeights.map((weight) => (absolute * weight) % total);

    let leftover = absolute - shares.reduce((sum, share) => sum + share, 0n);

    // At most `weights.length - 1` units are ever left over, so this ranks
    // a handful of entries; the sort is O(n log n) on a tiny n and buys
    // fairness that the O(n) version cannot give.
    const ranked = remainders
      .map((remainder, index) => ({ remainder, index }))
      .sort((a, b) => {
        if (a.remainder === b.remainder) {
          return a.index - b.index;
        }
        return a.remainder > b.remainder ? -1 : 1;
      });

    for (const { index } of ranked) {
      if (leftover <= 0n) {
        break;
      }
      shares[index] = (shares[index] ?? 0n) + 1n;
      leftover -= 1n;
    }

    return shares.map((share) => new Money(share * sign, this.currency));
  }

  /** Even split into `parts` buckets; the remainder goes to the first buckets. */
  split(parts: number): Money[] {
    return this.allocate(Array.from({ length: parts }, () => 1));
  }

  // --- comparison ---------------------------------------------------------

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.props.amount < other.props.amount) return -1;
    if (this.props.amount > other.props.amount) return 1;
    return 0;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) === 1;
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) === -1;
  }

  lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  static sum(items: ReadonlyArray<Money>, currency?: Currency | string): Money {
    if (items.length === 0) {
      if (!currency) {
        throw new ValidationError('Cannot sum an empty list without a currency', {}, 'INVALID_SUM');
      }
      return Money.zero(currency);
    }
    return items.reduce((total, item) => total.add(item));
  }

  // --- serialisation ------------------------------------------------------

  /** Decimal string in major units, e.g. `"-10.50"`. */
  toMajorString(): string {
    const negative = this.props.amount < 0n;
    const absolute = negative ? -this.props.amount : this.props.amount;
    const scale = this.currency.scale;
    const integer = absolute / scale;
    const fraction = absolute % scale;

    const body =
      this.currency.exponent === 0
        ? integer.toString()
        : `${integer}.${fraction.toString().padStart(this.currency.exponent, '0')}`;

    return negative ? `-${body}` : body;
  }

  /** Locale-aware rendering for humans. Never use the result for arithmetic. */
  format(locale = 'en-US'): string {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: this.currency.code,
      minimumFractionDigits: this.currency.exponent,
      maximumFractionDigits: this.currency.exponent,
    }).format(Number(this.toMajorString()));
  }

  override toJSON(): MoneyJson {
    return { amount: this.props.amount.toString(), currency: this.props.currency };
  }

  override toString(): string {
    return `${this.toMajorString()} ${this.currency.code}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.props.currency !== this.props.currency) {
      throw new CurrencyMismatchError(this.props.currency, other.props.currency);
    }
  }
}

export class CurrencyMismatchError extends ValidationError {
  constructor(expected: string, actual: string) {
    super(
      `Currency mismatch: expected ${expected}, received ${actual}`,
      { expected, actual },
      'CURRENCY_MISMATCH',
    );
  }
}

function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new ValidationError('Minor units must be an integer', { value }, 'INVALID_AMOUNT');
    }
    if (!Number.isSafeInteger(value)) {
      throw new ValidationError('Amount exceeds the safe integer range', { value }, 'INVALID_AMOUNT');
    }
    return BigInt(value);
  }
  try {
    return BigInt(value);
  } catch {
    throw new ValidationError('Minor units must be an integer string', { value }, 'INVALID_AMOUNT');
  }
}

/** Integer division with an explicit rounding policy, sign aware. */
export function divideWithRounding(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint {
  if (denominator === 0n) {
    throw new ValidationError('Division by zero', {}, 'DIVISION_BY_ZERO');
  }

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;

  if (remainder === 0n) {
    return negative ? -quotient : quotient;
  }

  const doubled = remainder * 2n;
  let roundAway: boolean;

  switch (mode) {
    case RoundingMode.Down:
      roundAway = false;
      break;
    case RoundingMode.Up:
      roundAway = true;
      break;
    case RoundingMode.Floor:
      roundAway = negative;
      break;
    case RoundingMode.Ceil:
      roundAway = !negative;
      break;
    case RoundingMode.HalfUp:
      roundAway = doubled >= absDenominator;
      break;
    case RoundingMode.HalfDown:
      roundAway = doubled > absDenominator;
      break;
    case RoundingMode.HalfEven:
      roundAway =
        doubled > absDenominator || (doubled === absDenominator && quotient % 2n === 1n);
      break;
  }

  const rounded = roundAway ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}
