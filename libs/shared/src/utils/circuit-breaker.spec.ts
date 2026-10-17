import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyFailureError } from '@payhub/kernel';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  let clock: number;
  const now = () => clock;

  const make = (overrides: Partial<CircuitBreakerOptions> = {}) =>
    new CircuitBreaker({
      name: 'psp',
      windowSize: 10,
      failureRateThreshold: 0.5,
      minimumCalls: 4,
      resetTimeoutMs: 1_000,
      successThreshold: 2,
      now,
      ...overrides,
    });

  const fail = () => Promise.reject(new Error('boom'));
  const succeed = () => Promise.resolve('ok');

  async function run(breaker: CircuitBreaker, operation: () => Promise<unknown>): Promise<boolean> {
    try {
      await breaker.execute(operation);
      return true;
    } catch {
      return false;
    }
  }

  beforeEach(() => {
    clock = 0;
  });

  it('passes calls through while healthy', async () => {
    const breaker = make();

    await expect(breaker.execute(succeed)).resolves.toBe('ok');
    expect(breaker.currentState).toBe('closed');
  });

  it('does not trip before the minimum number of calls', async () => {
    const breaker = make();

    // 3 failures out of 3 is a 100 % rate, but it is not yet a trend.
    await run(breaker, fail);
    await run(breaker, fail);
    await run(breaker, fail);

    expect(breaker.currentState).toBe('closed');
  });

  /**
   * The regression this implementation exists for: a dependency that fails
   * every other call never produces a run of consecutive failures, so a
   * consecutive-failure breaker stays closed forever while half the
   * traffic burns.
   */
  it('trips on a sustained failure rate even with no consecutive failures', async () => {
    const breaker = make();

    const outcomes: boolean[] = [];
    for (let i = 0; i < 8; i += 1) {
      outcomes.push(await run(breaker, i % 2 === 0 ? fail : succeed));
    }

    expect(breaker.currentState).toBe('open');
    // It trips the moment the rate crosses the threshold with enough
    // samples — here on the fifth call (3 failures of 5) — and every call
    // after that is rejected without reaching the dependency.
    expect(breaker.snapshot()).toMatchObject({ samples: 5, failureRate: 0.6 });
    expect(outcomes.slice(5)).toEqual([false, false, false]);
  });

  it('fails fast while open, without calling the dependency', async () => {
    const breaker = make();
    for (let i = 0; i < 4; i += 1) {
      await run(breaker, fail);
    }
    expect(breaker.currentState).toBe('open');

    const operation = vi.fn(succeed);
    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(DependencyFailureError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('lets a single probe through after the reset timeout', async () => {
    const breaker = make();
    for (let i = 0; i < 4; i += 1) {
      await run(breaker, fail);
    }

    clock += 1_000;

    // The first call is admitted as a probe…
    const probe = breaker.execute(succeed);
    // …and a concurrent second one is not, so a burst cannot flood a
    // dependency that has only just come back.
    await expect(breaker.execute(succeed)).rejects.toBeInstanceOf(DependencyFailureError);
    await probe;

    expect(breaker.currentState).toBe('half-open');
  });

  it('closes again after enough successful probes', async () => {
    const breaker = make();
    for (let i = 0; i < 4; i += 1) {
      await run(breaker, fail);
    }
    clock += 1_000;

    await breaker.execute(succeed);
    await breaker.execute(succeed);

    expect(breaker.currentState).toBe('closed');
    expect(breaker.snapshot().samples).toBe(0);
  });

  it('re-opens immediately when the probe fails', async () => {
    const breaker = make();
    for (let i = 0; i < 4; i += 1) {
      await run(breaker, fail);
    }
    clock += 1_000;

    await run(breaker, fail);

    expect(breaker.currentState).toBe('open');
  });

  it('forgets old outcomes as the window slides', async () => {
    const breaker = make({ windowSize: 4, minimumCalls: 4, failureRateThreshold: 0.75 });

    await run(breaker, fail);
    await run(breaker, fail);
    await run(breaker, succeed);
    await run(breaker, succeed);
    expect(breaker.currentState).toBe('closed');

    // Two more successes push both failures out of the window entirely.
    await run(breaker, succeed);
    await run(breaker, succeed);

    expect(breaker.snapshot()).toMatchObject({ failureRate: 0, samples: 4 });
  });

  it('propagates the original error, not a wrapper', async () => {
    const breaker = make();
    const original = new Error('acquirer said no');

    await expect(breaker.execute(() => Promise.reject(original))).rejects.toBe(original);
  });
});
