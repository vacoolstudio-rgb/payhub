import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from './errors.js';
import {
  type Result,
  combine,
  err,
  fromPromise,
  fromThrowable,
  ok,
  okVoid,
} from './result.js';

describe('Result', () => {
  it('narrows through isOk / isErr', () => {
    const success = ok<number, Error>(42);
    const failure = err<Error, number>(new Error('nope'));

    expect(success.isOk()).toBe(true);
    expect(success.isErr()).toBe(false);
    expect(failure.isErr()).toBe(true);

    if (success.isOk()) {
      expect(success.value).toBe(42);
    }
    if (failure.isErr()) {
      expect(failure.error.message).toBe('nope');
    }
  });

  it('unwrap throws on Err and returns on Ok', () => {
    expect(ok(1).unwrap()).toBe(1);
    expect(() => err(new ValidationError('bad')).unwrap()).toThrow(ValidationError);
    expect(err<Error, number>(new Error('x')).unwrapOr(7)).toBe(7);
    expect(ok<number, Error>(1).unwrapOr(7)).toBe(1);
  });

  it('unwrapErr is the mirror', () => {
    expect(err<Error, number>(new Error('x')).unwrapErr().message).toBe('x');
    expect(() => ok(1).unwrapErr()).toThrow(TypeError);
  });

  describe('composition', () => {
    it('map only touches the success branch', () => {
      const onValue = vi.fn((value: number) => value * 2);

      expect(ok<number, Error>(2).map(onValue).unwrap()).toBe(4);
      expect(err<Error, number>(new Error('x')).map(onValue).isErr()).toBe(true);
      expect(onValue).toHaveBeenCalledTimes(1);
    });

    it('mapErr only touches the failure branch', () => {
      const mapped = err<Error, number>(new Error('raw')).mapErr(
        (error) => new ValidationError(error.message),
      );

      expect(mapped.unwrapErr()).toBeInstanceOf(ValidationError);
      expect(ok<number, Error>(1).mapErr(() => new Error('never')).unwrap()).toBe(1);
    });

    /** The point of the type: a failure short-circuits the rest of the chain. */
    it('andThen short-circuits on the first error', () => {
      const second = vi.fn(() => ok(2));

      const result = err<Error, number>(new Error('first')).andThen(second);

      expect(result.isErr()).toBe(true);
      expect(second).not.toHaveBeenCalled();
    });

    it('match forces both branches to be handled', () => {
      const render = (result: Result<number, Error>) =>
        result.match({ ok: (value) => `ok:${value}`, err: (error) => `err:${error.message}` });

      expect(render(ok(1))).toBe('ok:1');
      expect(render(err(new Error('boom')))).toBe('err:boom');
    });

    it('tap observes without changing the value', () => {
      const seen: number[] = [];
      const result = ok<number, Error>(5).tap((value) => seen.push(value));

      expect(seen).toEqual([5]);
      expect(result.unwrap()).toBe(5);
    });
  });

  describe('combine', () => {
    it('collects every success', () => {
      expect(combine([ok(1), ok(2), ok(3)]).unwrap()).toEqual([1, 2, 3]);
      expect(combine<number, Error>([]).unwrap()).toEqual([]);
    });

    it('returns the first failure and stops', () => {
      const results: Result<number, Error>[] = [
        ok(1),
        err(new Error('second')),
        err(new Error('third')),
      ];

      expect(combine(results).unwrapErr()).toMatchObject({ message: 'second' });
    });
  });

  describe('interop with throwing code', () => {
    it('fromThrowable converts an exception into a typed failure', () => {
      const result = fromThrowable(
        () => JSON.parse('{ broken'),
        (error) => new ValidationError((error as Error).message),
      );

      expect(result.isErr()).toBe(true);
      expect(result.unwrapErr()).toBeInstanceOf(ValidationError);
    });

    it('fromPromise converts a rejection', async () => {
      const rejected = await fromPromise(Promise.reject(new Error('down')), (error) => error);
      const resolved = await fromPromise(Promise.resolve('fine'), (error) => error);

      expect(rejected.isErr()).toBe(true);
      expect(resolved.unwrap()).toBe('fine');
    });
  });

  it('okVoid carries no value', () => {
    expect(okVoid().isOk()).toBe(true);
    expect(okVoid().unwrap()).toBeUndefined();
  });
});
