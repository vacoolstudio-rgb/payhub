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
    vi.restoreAllMocks();
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
   * The regression. With a budget smaller than the next backoff, the
   * loop used to keep going for `maxRetries` regardless — each attempt
   * billed, none of them wanted.
   *
   * The backoff is full jitter, uniform in [0, 500) on the first
   * attempt, so this needs a fixed draw: written against the nominal
   * 500ms the test passed alone and failed in a full run, which is the
   * worst way for a test to be wrong.
   */
  it('stops retrying once the budget is spent', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // ~495ms, past a 50ms budget
    const provider = new AnthropicProvider(config({ maxRetries: 5, requestTimeoutMs: 50 }));
    const operation = vi.fn().mockRejectedValue(retryableFailure());

    await expect(retryWith(provider, operation)).rejects.toThrow();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  /** The same budget still allows a retry the backoff happens to fit. */
  it('retries when the backoff lands inside the budget', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // no wait at all
    const provider = new AnthropicProvider(config({ maxRetries: 1, requestTimeoutMs: 50 }));
    const operation = vi.fn().mockRejectedValue(retryableFailure());

    await expect(retryWith(provider, operation)).rejects.toThrow();
    expect(operation).toHaveBeenCalledTimes(2);
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

  /**
   * Token counting is a provider call like any other.
   *
   * It was the one that went out raw, with no classification and no
   * retry — tolerable when it ran once per question, and not once the
   * agent loop began running it before every iteration. Measured
   * against the real API with a deliberately invalid key: the endpoint
   * answered 500 INTERNAL_ERROR with an SDK stack trace, where the same
   * credentials through `complete` produce a 503 naming the dependency.
   */
  describe('counting tokens', () => {
    const countWith = (provider: AnthropicProvider, impl: () => Promise<unknown>) => {
      (provider as unknown as { client: { messages: { countTokens: unknown } } }).client = {
        messages: { countTokens: impl },
      } as never;
      return provider.countTokens({ system: 'system', messages: [] });
    };

    it('reports a provider failure as a dependency failure, not an unhandled error', async () => {
      const provider = new AnthropicProvider(config({ maxRetries: 0 }));

      await expect(
        countWith(provider, async () => {
          throw new Anthropic.APIError(
            401,
            { error: { message: 'invalid x-api-key' } },
            'invalid x-api-key',
            undefined,
          );
        }),
      ).rejects.toMatchObject({ code: 'ANTHROPIC_UNAVAILABLE' });
    });

    it('retries a transient failure the way a completion would', async () => {
      const provider = new AnthropicProvider(config({ maxRetries: 2 }));
      let attempts = 0;

      const count = await countWith(provider, async () => {
        attempts += 1;
        if (attempts === 1) {
          throw retryableFailure();
        }
        return { input_tokens: 42 };
      });

      expect(count).toBe(42);
      expect(attempts).toBe(2);
    });

    it('returns the provider count on the first success', async () => {
      const provider = new AnthropicProvider(config());

      await expect(countWith(provider, async () => ({ input_tokens: 128 }))).resolves.toBe(128);
    });
  });
});
