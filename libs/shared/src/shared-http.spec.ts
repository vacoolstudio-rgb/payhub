import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DependencyFailureError,
  ErrorKind,
  ForbiddenError,
  InvalidStateError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from '@payhub/kernel';
import { problemFromDomainError, statusForKind } from './http/problem-details.js';
import { PINO_REDACT_PATHS, REDACTED, redact } from './utils/redact.js';

describe('problem details', () => {
  it('maps every error kind to a status a client can act on', () => {
    expect(statusForKind(ErrorKind.Validation)).toBe(422);
    expect(statusForKind(ErrorKind.NotFound)).toBe(404);
    expect(statusForKind(ErrorKind.Conflict)).toBe(409);
    expect(statusForKind(ErrorKind.Forbidden)).toBe(403);
    expect(statusForKind(ErrorKind.Unauthorized)).toBe(401);
    expect(statusForKind(ErrorKind.PreconditionFailed)).toBe(412);
    expect(statusForKind(ErrorKind.RateLimited)).toBe(429);
    expect(statusForKind(ErrorKind.Unavailable)).toBe(503);
    expect(statusForKind(ErrorKind.Internal)).toBe(500);
  });

  it('renders RFC 9457 fields, including the correlation id', () => {
    const problem = problemFromDomainError(new NotFoundError('Payment', 'abc'), {
      instance: '/api/v1/payments/abc',
      correlationId: 'corr-1',
    });

    expect(problem).toMatchObject({
      status: 404,
      code: 'PAYMENT_NOT_FOUND',
      title: 'Payment not found',
      type: 'https://docs.payhub.dev/errors/payment-not-found',
      instance: '/api/v1/payments/abc',
      correlationId: 'corr-1',
    });
    expect(Date.parse(problem.timestamp)).not.toBeNaN();
  });

  it('carries structured details so a client can branch without parsing prose', () => {
    const problem = problemFromDomainError(
      new ConflictError('reused', 'IDEMPOTENCY_KEY_REUSED', { key: 'k-1' }),
      {},
    );

    expect(problem.errors).toEqual({ key: 'k-1' });
  });

  it('omits the details key entirely when there are none', () => {
    expect(problemFromDomainError(new ForbiddenError(), {})).not.toHaveProperty('errors');
  });

  it('gives each error class a distinct, stable code', () => {
    const codes = [
      new ValidationError('x').code,
      new UnauthorizedError().code,
      new ForbiddenError().code,
      new InvalidStateError('x', 'WALLET_FROZEN').code,
      new RateLimitedError().code,
      new DependencyFailureError('psp', 'x').code,
    ];

    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => /^[A-Z0-9_]+$/.test(code))).toBe(true);
  });
});

describe('redact', () => {
  it('masks sensitive keys at any depth', () => {
    const masked = redact({
      email: 'a@b.c',
      password: 'hunter2',
      nested: { apiKey: 'ph_live_x', token: 't' },
      list: [{ secret: 's' }],
    });

    expect(masked).toEqual({
      email: 'a@b.c',
      password: REDACTED,
      nested: { apiKey: REDACTED, token: REDACTED },
      list: [{ secret: REDACTED }],
    });
  });

  it('matches key names case-insensitively', () => {
    expect(redact({ Authorization: 'Bearer x', PASSWORD: 'y' })).toEqual({
      Authorization: REDACTED,
      PASSWORD: REDACTED,
    });
  });

  it('leaves primitives and null alone', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
  });

  /**
   * The depth cap, and what it used to cost.
   *
   * This test asserted only that a cyclic structure did not throw — an
   * assertion an implementation that redacted nothing at all would
   * also satisfy. Under it, the guard returned the subtree it refused
   * to walk, verbatim: a password and an `ph_live_` key seven levels
   * down went to the log in plain text while the same keys one level
   * down were masked. A redaction test that cannot tell redaction from
   * its absence is how that survived.
   */
  describe('the depth cap', () => {
    const nest = (levels: number, leaf: Record<string, unknown>): Record<string, unknown> =>
      levels === 0 ? leaf : { down: nest(levels - 1, leaf) };

    it('does not hang on a cycle', () => {
      const cyclic: Record<string, unknown> = { password: 'x' };
      cyclic['self'] = cyclic;

      expect(() => redact(cyclic)).not.toThrow();
    });

    it('still redacts what it can reach in a cycle', () => {
      const cyclic: Record<string, unknown> = { password: 'hunter2' };
      cyclic['self'] = cyclic;

      expect((redact(cyclic) as Record<string, unknown>)['password']).toBe('[redacted]');
    });

    it('drops the subtree it refuses to walk rather than passing it through', () => {
      const deep = nest(8, { password: 'hunter2', apiKey: 'ph_live_xyz' });

      expect(JSON.stringify(redact(deep))).not.toContain('hunter2');
      expect(JSON.stringify(redact(deep))).not.toContain('ph_live_xyz');
    });

    it('marks the truncation instead of silently emptying it', () => {
      const deep = nest(8, { password: 'hunter2' });

      expect(JSON.stringify(redact(deep))).toContain('[truncated]');
    });

    it('leaves a structure inside the cap fully redacted', () => {
      const shallow = nest(2, { password: 'hunter2', keep: 'visible' });
      const output = JSON.stringify(redact(shallow));

      expect(output).toContain('[redacted]');
      expect(output).toContain('visible');
      expect(output).not.toContain('hunter2');
      expect(output).not.toContain('[truncated]');
    });
  });

  it('declares the pino paths that cover the headers tokens travel in', () => {
    expect(PINO_REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
      ]),
    );
  });
});
