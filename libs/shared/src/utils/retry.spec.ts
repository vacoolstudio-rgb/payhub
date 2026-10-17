import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, retry } from './retry.js';

describe('backoffDelay', () => {
  it('stays within the exponential envelope', () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const ceiling = Math.min(5_000, 100 * 2 ** attempt);

      for (let sample = 0; sample < 50; sample += 1) {
        const delay = backoffDelay(attempt, 100, 5_000);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(Math.max(1, ceiling));
      }
    }
  });

  /**
   * Full jitter: the whole interval is randomised, so clients that failed
   * together do not retry together. Deterministic backoff would have them
   * stampede the recovering dependency in lockstep.
   */
  it('actually varies', () => {
    const samples = new Set(Array.from({ length: 50 }, () => backoffDelay(5, 100, 60_000)));

    expect(samples.size).toBeGreaterThan(10);
  });
});

describe('retry', () => {
  it('returns the first success without waiting', async () => {
    const operation = vi.fn().mockResolvedValue('ok');

    await expect(retry(operation, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 })).resolves.toBe(
      'ok',
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries up to the limit and then rethrows the last error', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('down'));

    await expect(
      retry(operation, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 }),
    ).rejects.toThrow('down');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('passes the attempt number through', async () => {
    const seen: number[] = [];

    await retry(
      async (attempt) => {
        seen.push(attempt);
        if (attempt < 2) {
          throw new Error('again');
        }
        return 'ok';
      },
      { attempts: 5, baseDelayMs: 1, maxDelayMs: 2 },
    );

    expect(seen).toEqual([0, 1, 2]);
  });

  /** A deterministic failure must not be retried — it will fail identically. */
  it('stops immediately when the error is not retryable', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('invalid card'));

    await expect(
      retry(operation, {
        attempts: 5,
        baseDelayMs: 1,
        maxDelayMs: 2,
        isRetryable: () => false,
      }),
    ).rejects.toThrow('invalid card');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('reports each retry so the delay is observable', async () => {
    const onRetry = vi.fn();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValue('ok');

    await retry(operation, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[1]).toBe(1);
  });

  it('aborts between attempts when the signal fires', async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error('down'));
    });

    await expect(
      retry(operation, {
        attempts: 5,
        baseDelayMs: 50,
        maxDelayMs: 50,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
