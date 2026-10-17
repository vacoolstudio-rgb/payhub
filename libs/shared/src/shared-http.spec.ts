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

  /** A cycle must not hang the logger; the depth cap is the guard. */
  it('stops at the depth limit instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { password: 'x' };
    cyclic['self'] = cyclic;

    expect(() => redact(cyclic)).not.toThrow();
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
