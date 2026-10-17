/**
 * Railway-oriented `Result`.
 *
 * Expected, domain-level failures are values, not exceptions: a service that
 * can fail for business reasons returns `Result<T, DomainError>` so the type
 * system forces the caller to handle it. Exceptions stay reserved for
 * genuinely exceptional conditions (bugs, infrastructure outages).
 */

export type Result<T, E = Error> = Ok<T, E> | Err<T, E>;

export class Ok<T, E> {
  readonly _tag = 'Ok' as const;

  constructor(readonly value: T) {}

  isOk(): this is Ok<T, E> {
    return true;
  }

  isErr(): this is Err<T, E> {
    return false;
  }

  unwrap(): T {
    return this.value;
  }

  unwrapOr(_fallback: T): T {
    return this.value;
  }

  unwrapErr(): E {
    throw new TypeError('Called unwrapErr() on an Ok value');
  }

  map<U>(fn: (value: T) => U): Result<U, E> {
    return new Ok(fn(this.value));
  }

  mapErr<F>(_fn: (error: E) => F): Result<T, F> {
    return new Ok(this.value);
  }

  andThen<U>(fn: (value: T) => Result<U, E>): Result<U, E> {
    return fn(this.value);
  }

  async andThenAsync<U>(
    fn: (value: T) => Promise<Result<U, E>>,
  ): Promise<Result<U, E>> {
    return fn(this.value);
  }

  tap(fn: (value: T) => void): Result<T, E> {
    fn(this.value);
    return this;
  }

  match<U>(handlers: { ok: (value: T) => U; err: (error: E) => U }): U {
    return handlers.ok(this.value);
  }
}

export class Err<T, E> {
  readonly _tag = 'Err' as const;

  constructor(readonly error: E) {}

  isOk(): this is Ok<T, E> {
    return false;
  }

  isErr(): this is Err<T, E> {
    return true;
  }

  unwrap(): T {
    throw this.error instanceof Error
      ? this.error
      : new Error(`Called unwrap() on an Err value: ${String(this.error)}`);
  }

  unwrapOr(fallback: T): T {
    return fallback;
  }

  unwrapErr(): E {
    return this.error;
  }

  map<U>(_fn: (value: T) => U): Result<U, E> {
    return new Err(this.error);
  }

  mapErr<F>(fn: (error: E) => F): Result<T, F> {
    return new Err(fn(this.error));
  }

  andThen<U>(_fn: (value: T) => Result<U, E>): Result<U, E> {
    return new Err(this.error);
  }

  async andThenAsync<U>(
    _fn: (value: T) => Promise<Result<U, E>>,
  ): Promise<Result<U, E>> {
    return new Err(this.error);
  }

  tap(_fn: (value: T) => void): Result<T, E> {
    return this;
  }

  match<U>(handlers: { ok: (value: T) => U; err: (error: E) => U }): U {
    return handlers.err(this.error);
  }
}

export const ok = <T, E = never>(value: T): Result<T, E> => new Ok(value);
export const err = <E, T = never>(error: E): Result<T, E> => new Err(error);
export const okVoid = <E = never>(): Result<void, E> => new Ok(undefined);

/** Collects a list of results into a result of a list, short-circuiting on the first error. */
export function combine<T, E>(results: Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];

  for (const result of results) {
    if (result.isErr()) {
      return err(result.error);
    }
    values.push(result.value);
  }

  return ok(values);
}

/** Wraps a throwing thunk so infrastructure exceptions become typed failures. */
export function fromThrowable<T, E>(
  fn: () => T,
  onThrow: (error: unknown) => E,
): Result<T, E> {
  try {
    return ok(fn());
  } catch (error) {
    return err(onThrow(error));
  }
}

export async function fromPromise<T, E>(
  promise: Promise<T>,
  onReject: (error: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await promise);
  } catch (error) {
    return err(onReject(error));
  }
}
