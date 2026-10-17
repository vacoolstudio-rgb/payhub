import type { ValueTransformer } from 'typeorm';
import { Money } from '@payhub/kernel';

/**
 * Postgres `bigint` arrives as a string from node-postgres (it cannot fit in
 * a JS number). We keep it as `bigint` in the domain, never as `number`.
 */
export const bigintTransformer: ValueTransformer = {
  to: (value: bigint | null): string | null => (value === null || value === undefined ? null : value.toString()),
  from: (value: string | null): bigint | null => (value === null || value === undefined ? null : BigInt(value)),
};

/** `numeric`/`bigint` column that round-trips a plain integer string. */
export const minorUnitsTransformer: ValueTransformer = {
  to: (value: bigint | number | string | null): string | null =>
    value === null || value === undefined ? null : value.toString(),
  from: (value: string | null): bigint => (value === null || value === undefined ? 0n : BigInt(value)),
};

/**
 * Money is persisted as two columns (`*_amount` bigint + `*_currency` char),
 * never as a float. This transformer is for the single-column JSON variant
 * used in append-only audit payloads where schema flexibility wins.
 */
export const moneyJsonTransformer: ValueTransformer = {
  to: (value: Money | null): unknown => (value ? value.toJSON() : null),
  from: (value: { amount: string; currency: string } | null): Money | null =>
    value ? Money.fromMinor(value.amount, value.currency) : null,
};

/** `timestamptz` → always a real `Date`, never a string. */
export const timestampTransformer: ValueTransformer = {
  to: (value: Date | null) => value,
  from: (value: Date | string | null): Date | null =>
    value === null || value === undefined ? null : value instanceof Date ? value : new Date(value),
};
