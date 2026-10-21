import Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic.provider.js';

/**
 * The retry loop, and the budget it has to respect.
 *
 * `maxRetries` on its own multiplies the per-attempt timeout: four
 * attempts at the SDK's own timeout, plus backoff, ran for minutes of
 * billed provider work behind a caller the global request budget had
 * already abandoned. Retries need to know when the answer stops being
 * wanted.
 */
describe('AnthropicProvider: retry budget', () => {
  const config = (overrides: Record<string, unknown> = {}) =>
    ({
      apiKey: 'sk-test',
      model: 'claude-test',
      maxOutputTokens: 256,
      maxRetries: 3,
      requestTimeoutMs: 1_000,
      ...overrides,
    }) as never;

  /** Reaches the private loop without going near the network. */
  const retryWith = (provider: AnthropicProvider, operation: () => Promise<unknown>) =>
    (
      provider as unknown as {
        withRetries: (op: () => Promise<unknown>) => Promise<unknown>;
      }
    ).withRetries(operation);

  /**
   * A real SDK error: `classify` narrows on the SDK's error classes, so a
   * plain object with a `status` reaches the catch-all and is treated as
   * non-retryable — which would make these tests pass for the wrong
   * reason.
   */
  const retryableFailure = () =>
    new Anthropic.APIError(529, { error: { message: 'overloaded' } }, 'overloaded', undefined);

  beforeEach(() => {
    vi.useRealTimers();
  });

  it('returns the first successful attempt without retrying', async () => {
    const provider = new AnthropicProvider(config());
    const operation = vi.fn().mockResolvedValue('answer');

    await expect(retryWith(provider, operation)).resolves.toBe('answer');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure', async () => {
    const provider = new AnthropicProvider(config({ maxRetries: 2, requestTimeoutMs: 10_000 }));
    const operation = vi
      .fn()
      .mockRejectedValueOnce(retryableFailure())
      .mockResolvedValue('answer');

    await expect(retryWith(provider, operation)).resolves.toBe('answer');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  /**
   * The regression. With a budget smaller than the first backoff, the
   * loop used to keep going for `maxRetries` regardless — each attempt
   * billed, none of them wanted.
   */
  it('stops retrying once the budget is spent', async () => {
    // Backoff starts at 500ms, so a 50ms budget is gone before attempt two.
    const provider = new AnthropicProvider(config({ maxRetries: 5, requestTimeoutMs: 50 }));
    const operation = vi.fn().mockRejectedValue(retryableFailure());

    await expect(retryWith(provider, operation)).rejects.toThrow();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('still honours maxRetries when the budget is generous', async () => {
    const provider = new AnthropicProvider(config({ maxRetries: 2, requestTimeoutMs: 60_000 }));
    const operation = vi.fn().mockRejectedValue(retryableFailure());

    await expect(retryWith(provider, operation)).rejects.toThrow();
    expect(operation).toHaveBeenCalledTimes(3);
  });

  /** A deterministic failure is not worth a second call at any budget. */
  it('does not retry a request the provider rejected as invalid', async () => {
    const provider = new AnthropicProvider(config({ requestTimeoutMs: 60_000 }));
    const operation = vi
      .fn()
      .mockRejectedValue(
        new Anthropic.APIError(400, { error: { message: 'bad request' } }, 'bad request', undefined),
      );

    await expect(retryWith(provider, operation)).rejects.toThrow();
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
