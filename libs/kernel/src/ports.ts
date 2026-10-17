import { randomUUID } from 'node:crypto';

/**
 * Ambient dependencies are ports, not globals. Injecting `Clock` instead of
 * calling `Date.now()` makes expiry, backoff and reconciliation windows
 * testable without fake timers leaking across suites.
 */
export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const CLOCK = Symbol.for('payhub:Clock');

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowMs(): number {
    return Date.now();
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  nowMs(): number {
    return this.current.getTime();
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(date: Date): void {
    this.current = date;
  }
}

export interface IdGenerator {
  uuid(): string;
}

export const ID_GENERATOR = Symbol.for('payhub:IdGenerator');

export class UuidGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }
}

/** Deterministic generator for tests: ids are `prefix-1`, `prefix-2`, … */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = '00000000-0000-4000-8000') {}

  uuid(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter.toString().padStart(12, '0')}`;
  }
}
