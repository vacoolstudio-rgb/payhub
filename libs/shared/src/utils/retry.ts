import { setTimeout as delay } from 'node:timers/promises';

export interface RetryOptions {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Decides whether a given failure is worth another attempt. */
  readonly isRetryable?: (error: unknown) => boolean;
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  readonly signal?: AbortSignal;
}

/**
 * Exponential backoff with **full jitter**.
 *
 * Deterministic backoff synchronises every client that failed at the same
 * moment and they stampede the recovering dependency together. Randomising
 * the whole interval (`random(0, base * 2^n)`) spreads the retries out and is
 * what AWS recommends after measuring the alternatives.
 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exponential);
}

export async function retry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs, isRetryable = () => true, onRetry, signal } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal?.throwIfAborted();

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      const isLast = attempt === attempts - 1;
      if (isLast || !isRetryable(error)) {
        throw error;
      }

      const waitMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      onRetry?.(error, attempt + 1, waitMs);
      await delay(waitMs, undefined, { signal });
    }
  }

  throw lastError;
}
