import { Inject, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { setTimeout as delay } from 'node:timers/promises';
import { type LlmConfig, llmConfig } from '@payhub/config';
import { DependencyFailureError, RateLimitedError } from '@payhub/kernel';
import { backoffDelay } from '@payhub/shared';
import type {
  LlmCompletion,
  LlmProvider,
  LlmRequest,
  LlmStreamChunk,
  LlmUsage,
} from '../domain/llm.port.js';

/**
 * Anthropic adapter.
 *
 * Everything provider-specific lives here: the SDK, the model id, the retry
 * policy for 429/5xx, and the translation of usage into our own types. The
 * application layer talks to `LlmProvider` and would not notice a swap.
 */
@Injectable()
export class AnthropicProvider implements LlmProvider {
  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly client: Anthropic;

  constructor(@Inject(llmConfig.KEY) private readonly config: LlmConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey ?? '',
      // The SDK's own retry is disabled: we need to honour `retry-after`
      // against our *own* budget accounting and surface the wait to the
      // caller, which the built-in retry cannot do.
      maxRetries: 0,
      timeout: config.requestTimeoutMs,
    });
  }

  get model(): string {
    return this.config.model;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    return this.withRetries(async () => {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
        // Adaptive thinking: the model decides how much reasoning a question
        // deserves. A balance lookup gets none, "why did my payment fail?"
        // gets some.
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        system: request.cacheSystemPrompt
          ? [
              {
                type: 'text',
                text: request.system,
                cache_control: { type: 'ephemeral' },
              },
            ]
          : request.system,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        text,
        usage: toUsage(response.usage),
        model: response.model,
        stopReason: response.stop_reason,
      };
    });
  }

  /**
   * Streaming is the default for anything a human waits on: it keeps the
   * connection alive past proxy idle timeouts and gets the first token in
   * front of the user in a few hundred milliseconds instead of twenty
   * seconds.
   */
  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    let attempt = 0;

    while (attempt <= this.config.maxRetries) {
      try {
        const stream = this.client.messages.stream(
          {
            model: this.config.model,
            max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'low' },
            system: request.cacheSystemPrompt
              ? [
                  {
                    type: 'text',
                    text: request.system,
                    cache_control: { type: 'ephemeral' },
                  },
                ]
              : request.system,
            messages: request.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          },
          request.signal ? { signal: request.signal } : {},
        );

        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta' &&
            event.delta.text
          ) {
            yield { type: 'text', text: event.delta.text };
          }
        }

        const final = await stream.finalMessage();
        yield { type: 'done', usage: toUsage(final.usage), stopReason: final.stop_reason };
        return;
      } catch (error) {
        const classified = this.classify(error);

        if (!classified.retryable || attempt === this.config.maxRetries) {
          yield { type: 'error', message: classified.message, retryable: classified.retryable };
          return;
        }

        const waitMs = classified.retryAfterMs ?? backoffDelay(attempt, 500, 20_000);
        this.logger.warn(`LLM stream retry ${attempt + 1} in ${waitMs}ms: ${classified.message}`);
        await delay(waitMs);
        attempt += 1;
      }
    }
  }

  async countTokens(request: Pick<LlmRequest, 'system' | 'messages'>): Promise<number> {
    // The provider's own counter, not a local tokenizer guess: budgets that
    // are enforced on an estimate drift from what is actually billed.
    const response = await this.client.messages.countTokens({
      model: this.config.model,
      system: request.system,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    });

    return response.input_tokens;
  }

  private async withRetries<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const classified = this.classify(error);

        if (!classified.retryable || attempt === this.config.maxRetries) {
          throw classified.retryAfterMs !== undefined
            ? new RateLimitedError(classified.message, classified.retryAfterMs)
            : new DependencyFailureError('anthropic', classified.message, {
                cause: error,
                retryable: classified.retryable,
              });
        }

        const waitMs = classified.retryAfterMs ?? backoffDelay(attempt, 500, 20_000);
        this.logger.warn(`LLM retry ${attempt + 1} in ${waitMs}ms: ${classified.message}`);
        await delay(waitMs);
      }
    }

    throw lastError;
  }

  /**
   * 429 handling.
   *
   * The provider tells us exactly how long to wait in `retry-after`;
   * guessing with pure exponential backoff either wastes capacity or hammers
   * a limit that has not reset. 5xx and connection errors get jittered
   * backoff; 4xx other than 429 are permanent and must not be retried.
   */
  private classify(error: unknown): {
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  } {
    if (error instanceof Anthropic.RateLimitError) {
      const header = error.headers?.get?.('retry-after');
      const seconds = header ? Number(header) : Number.NaN;

      return {
        message: 'LLM provider rate limit reached',
        retryable: true,
        retryAfterMs: Number.isFinite(seconds) ? seconds * 1_000 : 5_000,
      };
    }

    if (error instanceof Anthropic.APIConnectionError) {
      return { message: 'Could not reach the LLM provider', retryable: true };
    }

    if (error instanceof Anthropic.APIError) {
      return {
        message: `LLM provider returned ${error.status ?? 'an error'}`,
        retryable: (error.status ?? 500) >= 500,
      };
    }

    if (error instanceof Error && error.name === 'AbortError') {
      return { message: 'Request cancelled', retryable: false };
    }

    return {
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}

function toUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}
