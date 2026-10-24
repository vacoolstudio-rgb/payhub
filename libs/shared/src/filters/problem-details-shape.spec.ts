import { HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';
import { fromExposedError, toProblemFromHttpException } from './all-exceptions.filter.js';

/**
 * The error body is a published contract.
 *
 * `type` is the half a client is supposed to branch on, so it has to come
 * from something we control. It used to be minted from the exception's
 * class name whenever the body carried no `error` field, which is how a
 * rate limit went out as `.../errors/throttlerexception`.
 */
describe('problem details from an HttpException', () => {
  it('builds the type from the error code, not the class name', () => {
    const problem = toProblemFromHttpException(new ThrottlerException(), {});

    expect(problem.type).toBe('https://docs.payhub.dev/errors/too-many-requests');
    expect(problem.code).toBe('TOO_MANY_REQUESTS');
  });

  it('does not name our dependencies to the caller', () => {
    const problem = toProblemFromHttpException(new ThrottlerException(), {});

    expect(JSON.stringify(problem)).not.toMatch(/throttler/i);
  });

  it('keeps the readable title Nest supplies', () => {
    const problem = toProblemFromHttpException(
      new HttpException({ message: 'nope', error: 'Not Found' }, HttpStatus.NOT_FOUND),
      {},
    );

    expect(problem).toMatchObject({
      title: 'Not Found',
      type: 'https://docs.payhub.dev/errors/not-found',
      detail: 'nope',
    });
  });

  it('humanizes the code when there is no title to keep', () => {
    const problem = toProblemFromHttpException(
      new HttpException('gone wrong', HttpStatus.UNPROCESSABLE_ENTITY),
      {},
    );

    expect(problem.title).toBe('Unprocessable entity');
  });

  it('still joins a validation message array into one detail', () => {
    const problem = toProblemFromHttpException(
      new HttpException(
        { message: ['amount must be a string', 'reason should not be empty'], error: 'Bad Request' },
        HttpStatus.BAD_REQUEST,
      ),
      {},
    );

    expect(problem.detail).toBe('amount must be a string; reason should not be empty');
    expect(problem.errors).toEqual({
      validation: ['amount must be a string', 'reason should not be empty'],
    });
  });

  it('prefers an explicit code over the one implied by the status', () => {
    const problem = toProblemFromHttpException(
      new HttpException({ message: 'slow down', code: 'QUOTA_EXHAUSTED' }, 429),
      {},
    );

    expect(problem.type).toBe('https://docs.payhub.dev/errors/quota-exhausted');
  });
});

/**
 * Rejections from middleware that already know their own status.
 *
 * body-parser, cors and multer throw `http-errors` instances: a 4xx
 * `status` and `expose: true`, meaning the message is safe to show a
 * client. None of them is an `HttpException`, so they reached the
 * catch-all and went out as 500 with a stack trace in the log. Measured
 * against the running API: a body over the limit answered
 * `500 INTERNAL_ERROR` while the error itself carried 413, which turns
 * a caller's mistake into a page for whoever is on call.
 */
describe('problem details from a middleware rejection', () => {
  const tooLarge = () =>
    Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
    });

  it('answers a payload over the limit with the status the error carries', () => {
    expect(fromExposedError(tooLarge(), {})).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      type: 'https://docs.payhub.dev/errors/payload-too-large',
      detail: 'request entity too large',
    });
  });

  /**
   * `expose` is the condition, not the status alone. An internal error
   * that happens to carry a 4xx has not been marked safe to show, and
   * its message does not belong in a response body.
   */
  it('declines an error that was never marked safe to show', () => {
    const hidden = Object.assign(new Error('postgres credentials rejected'), { status: 403 });

    expect(fromExposedError(hidden, {})).toBeNull();
  });

  it('declines a 5xx, which is not the caller\'s fault to report', () => {
    const upstream = Object.assign(new Error('bad gateway'), { status: 502, expose: true });

    expect(fromExposedError(upstream, {})).toBeNull();
  });

  it('declines anything without a status', () => {
    expect(fromExposedError(new Error('plain'), {})).toBeNull();
    expect(fromExposedError('a string', {})).toBeNull();
    expect(fromExposedError(null, {})).toBeNull();
  });

  it('carries the correlation id through', () => {
    const problem = fromExposedError(tooLarge(), { correlationId: 'abc-123' });

    expect(problem).toMatchObject({ correlationId: 'abc-123' });
  });
});
