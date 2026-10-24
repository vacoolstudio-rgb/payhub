import { HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';
import { toProblemFromHttpException } from './all-exceptions.filter.js';

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
