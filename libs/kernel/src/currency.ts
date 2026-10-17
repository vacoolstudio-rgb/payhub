import { ValidationError } from './errors.js';
import { type Result, err, ok } from './result.js';
import { ValueObject } from './value-object.js';

interface CurrencyProps {
  readonly code: string;
  /** Number of decimal digits in the minor unit: 2 for USD, 0 for JPY, 8 for BTC. */
  readonly exponent: number;
  readonly name: string;
}

/**
 * Currencies are a closed set on purpose. An unknown currency code is a
 * configuration error, not something the ledger should silently accept, since
 * the exponent decides how many minor units a major unit holds.
 */
const REGISTRY: ReadonlyArray<CurrencyProps> = [
  { code: 'USD', exponent: 2, name: 'US Dollar' },
  { code: 'EUR', exponent: 2, name: 'Euro' },
  { code: 'GBP', exponent: 2, name: 'Pound Sterling' },
  { code: 'PLN', exponent: 2, name: 'Polish Zloty' },
  { code: 'JPY', exponent: 0, name: 'Japanese Yen' },
  { code: 'BHD', exponent: 3, name: 'Bahraini Dinar' },
  { code: 'USDT', exponent: 6, name: 'Tether' },
  { code: 'BTC', exponent: 8, name: 'Bitcoin' },
];

export class Currency extends ValueObject<CurrencyProps> {
  private static readonly cache = new Map<string, Currency>(
    REGISTRY.map((props) => [props.code, new Currency(props)]),
  );

  private constructor(props: CurrencyProps) {
    super(props);
  }

  static of(code: string): Currency {
    const currency = Currency.cache.get(code.toUpperCase());
    if (!currency) {
      throw new ValidationError(`Unsupported currency: ${code}`, { code }, 'UNSUPPORTED_CURRENCY');
    }
    return currency;
  }

  static parse(code: unknown): Result<Currency, ValidationError> {
    if (typeof code !== 'string') {
      return err(new ValidationError('Currency must be a string', { code }, 'UNSUPPORTED_CURRENCY'));
    }
    const currency = Currency.cache.get(code.toUpperCase());
    return currency
      ? ok(currency)
      : err(new ValidationError(`Unsupported currency: ${code}`, { code }, 'UNSUPPORTED_CURRENCY'));
  }

  static all(): Currency[] {
    return [...Currency.cache.values()];
  }

  get code(): string {
    return this.props.code;
  }

  get exponent(): number {
    return this.props.exponent;
  }

  get name(): string {
    return this.props.name;
  }

  /** 10 ** exponent — how many minor units make one major unit. */
  get scale(): bigint {
    return 10n ** BigInt(this.props.exponent);
  }

  override toString(): string {
    return this.props.code;
  }
}
