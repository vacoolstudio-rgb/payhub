import { Money, RoundingMode, ValidationError, ValueObject, type Result, err, ok } from '@payhub/kernel';

interface FeePolicyProps {
  /** Percentage expressed in basis points: 250 = 2.50 %. */
  readonly basisPoints: number;
  /** Flat component in minor units, applied on top of the percentage. */
  readonly fixedMinor: bigint;
  readonly minimumMinor: bigint;
  readonly maximumMinor: bigint | null;
}

/**
 * Merchant pricing.
 *
 * Basis points rather than a float percentage: `0.029` cannot be represented
 * exactly in binary floating point, and a payments platform that computes
 * fees with floats will eventually be off by a cent in a way nobody can
 * reproduce. Integers all the way down.
 */
export class FeePolicy extends ValueObject<FeePolicyProps> {
  private constructor(props: FeePolicyProps) {
    super(props);
  }

  static create(input: {
    basisPoints: number;
    fixedMinor?: bigint;
    minimumMinor?: bigint;
    maximumMinor?: bigint | null;
  }): Result<FeePolicy, ValidationError> {
    if (!Number.isInteger(input.basisPoints) || input.basisPoints < 0 || input.basisPoints > 10_000) {
      return err(
        new ValidationError(
          'basisPoints must be an integer between 0 and 10000',
          { basisPoints: input.basisPoints },
          'INVALID_FEE_POLICY',
        ),
      );
    }

    const minimum = input.minimumMinor ?? 0n;
    const maximum = input.maximumMinor ?? null;

    if (maximum !== null && maximum < minimum) {
      return err(
        new ValidationError('Fee maximum is below the minimum', {}, 'INVALID_FEE_POLICY'),
      );
    }

    return ok(
      new FeePolicy({
        basisPoints: input.basisPoints,
        fixedMinor: input.fixedMinor ?? 0n,
        minimumMinor: minimum,
        maximumMinor: maximum,
      }),
    );
  }

  static default(): FeePolicy {
    // 2.9 % + 30 minor units — the familiar card-processing shape.
    return new FeePolicy({
      basisPoints: 290,
      fixedMinor: 30n,
      minimumMinor: 0n,
      maximumMinor: null,
    });
  }

  /**
   * `HalfEven` (banker's rounding) so that, across millions of transactions,
   * rounding does not systematically favour the platform over the merchant.
   */
  calculate(amount: Money): Money {
    const percentage = amount.percentage(this.props.basisPoints, RoundingMode.HalfEven);
    const fixed = Money.fromMinor(this.props.fixedMinor, amount.currency);
    let fee = percentage.add(fixed);

    const minimum = Money.fromMinor(this.props.minimumMinor, amount.currency);
    if (fee.lessThan(minimum)) {
      fee = minimum;
    }

    if (this.props.maximumMinor !== null) {
      const maximum = Money.fromMinor(this.props.maximumMinor, amount.currency);
      if (fee.greaterThan(maximum)) {
        fee = maximum;
      }
    }

    // A fee can never exceed the amount it is charged on.
    return fee.greaterThan(amount) ? amount : fee;
  }

  get basisPoints(): number {
    return this.props.basisPoints;
  }

  get fixedMinor(): bigint {
    return this.props.fixedMinor;
  }

  get minimumMinor(): bigint {
    return this.props.minimumMinor;
  }

  get maximumMinor(): bigint | null {
    return this.props.maximumMinor;
  }
}
