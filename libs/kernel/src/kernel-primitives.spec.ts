import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DependencyFailureError,
  ErrorKind,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from './errors.js';
import { type Brand, isUuid, uuidBrand } from './identifiers.js';
import { FixedClock, SequentialIdGenerator, SystemClock } from './ports.js';
import { PredicateSpecification, Specification } from './specification.js';
import { ValueObject } from './value-object.js';

describe('DomainError taxonomy', () => {
  it('derives a stable machine-readable code from the resource', () => {
    const error = new NotFoundError('JournalEntry', 'abc');

    expect(error.code).toBe('JOURNAL_ENTRY_NOT_FOUND');
    expect(error.kind).toBe(ErrorKind.NotFound);
    expect(error.details).toMatchObject({ resource: 'JournalEntry', identifier: 'abc' });
  });

  it('serialises without leaking a stack', () => {
    const json = new ConflictError('taken', 'EMAIL_TAKEN', { email: 'a@b.c' }).toJSON();

    expect(json).toEqual({
      code: 'EMAIL_TAKEN',
      kind: ErrorKind.Conflict,
      message: 'taken',
      details: { email: 'a@b.c' },
    });
    expect(Object.keys(json)).not.toContain('stack');
  });

  /** Details are copied and frozen so a caller cannot mutate a thrown error. */
  it('freezes its details', () => {
    const details = { attempt: 1 };
    const error = new ValidationError('bad', details);

    details.attempt = 99;

    expect(error.details['attempt']).toBe(1);
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it('keeps the error name in sync with the subclass', () => {
    expect(new ValidationError('x').name).toBe('ValidationError');
    expect(new RateLimitedError('x', 1_000).name).toBe('RateLimitedError');
  });

  it('marks dependency failures as retryable by default', () => {
    expect(new DependencyFailureError('kafka', 'down').retryable).toBe(true);
    expect(new DependencyFailureError('psp', 'declined', { retryable: false }).retryable).toBe(
      false,
    );
    expect(new DependencyFailureError('ledger-service', 'x').code).toBe('LEDGER_SERVICE_UNAVAILABLE');
  });

  it('carries the retry hint on a rate limit', () => {
    expect(new RateLimitedError('slow down', 2_500).details['retryAfterMs']).toBe(2_500);
  });
});

describe('branded identifiers', () => {
  type OrderId = Brand<string, 'OrderId'>;
  const OrderId = uuidBrand<OrderId>('OrderId');

  it('creates and validates UUIDs', () => {
    const created = OrderId.create();

    expect(isUuid(created)).toBe(true);
    expect(OrderId.parse(created).unwrap()).toBe(created);
  });

  it('rejects anything that is not a UUID', () => {
    for (const input of ['', 'abc', 123, null, '00000000-0000-0000-0000-000000000000']) {
      expect(OrderId.parse(input).isErr()).toBe(true);
    }
  });

  it('names the identifier in the failure, so the message is actionable', () => {
    expect(OrderId.parse('nope').unwrapErr().message).toContain('OrderId');
  });
});

describe('ValueObject', () => {
  class Point extends ValueObject<{ x: number; y: number }> {
    constructor(x: number, y: number) {
      super({ x, y });
    }
  }
  class Vector extends ValueObject<{ x: number; y: number }> {
    constructor(x: number, y: number) {
      super({ x, y });
    }
  }

  it('compares by value, not identity', () => {
    expect(new Point(1, 2).equals(new Point(1, 2))).toBe(true);
    expect(new Point(1, 2).equals(new Point(2, 1))).toBe(false);
  });

  it('is not equal to a different class with the same shape', () => {
    expect(new Point(1, 2).equals(new Vector(1, 2))).toBe(false);
  });

  it('is not equal to null or undefined', () => {
    expect(new Point(1, 2).equals(null)).toBe(false);
    expect(new Point(1, 2).equals(undefined)).toBe(false);
  });

  /** Equality must not depend on the order keys happened to be written in. */
  it('ignores key order', () => {
    class Loose extends ValueObject<Record<string, unknown>> {
      constructor(props: Record<string, unknown>) {
        super(props);
      }
    }

    expect(new Loose({ b: 1, a: 2 }).equals(new Loose({ a: 2, b: 1 }))).toBe(true);
  });

  it('freezes its props', () => {
    const point = new Point(1, 2);

    expect(Object.isFrozen(point.toJSON())).toBe(true);
  });
});

describe('Specification', () => {
  const positive = new PredicateSpecification<number>((n) => n > 0);
  const even = new PredicateSpecification<number>((n) => n % 2 === 0);

  it('composes with and / or / not', () => {
    expect(positive.and(even).isSatisfiedBy(4)).toBe(true);
    expect(positive.and(even).isSatisfiedBy(3)).toBe(false);
    expect(positive.or(even).isSatisfiedBy(-2)).toBe(true);
    expect(positive.not().isSatisfiedBy(-1)).toBe(true);
  });

  it('nests arbitrarily deep', () => {
    const rule: Specification<number> = positive.and(even.not()).or(
      new PredicateSpecification<number>((n) => n === 0),
    );

    expect(rule.isSatisfiedBy(3)).toBe(true);
    expect(rule.isSatisfiedBy(4)).toBe(false);
    expect(rule.isSatisfiedBy(0)).toBe(true);
  });
});

describe('ambient ports', () => {
  it('FixedClock makes time an input instead of a global', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));

    expect(clock.nowMs()).toBe(Date.parse('2026-01-01T00:00:00Z'));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('SystemClock agrees with itself', () => {
    const clock = new SystemClock();

    expect(Math.abs(clock.nowMs() - clock.now().getTime())).toBeLessThan(50);
  });

  it('SequentialIdGenerator is deterministic', () => {
    const generator = new SequentialIdGenerator();

    expect(generator.uuid()).not.toBe(generator.uuid());
    expect(new SequentialIdGenerator().uuid()).toBe(new SequentialIdGenerator().uuid());
  });
});
