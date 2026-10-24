import { Inject, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { setTimeout as delay } from 'node:timers/promises';
import { type LlmConfig, llmConfig } from '@payhub/config';
import { DependencyFailureError, RateLimitedError } from '@payhub/kernel';
import { backoffDelay } from '@payhub/shared';
import type {
  LlmCompletion,
  LlmContentBlock,
  LlmMessage,
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
        messages: request.messages.map(toWireMessage),
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
              })),
            }
          : {}),
      });

      const content = response.content.flatMap(toPortBlock);
      const text = content
        .filter((block): block is Extract<LlmContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        text,
        content,
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
            messages: request.messages.map(toWireMessage),
            ...(request.tools && request.tools.length > 0
              ? {
                  tools: request.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
                  })),
                }
              : {}),
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
        yield {
          type: 'done',
          usage: toUsage(final.usage),
          stopReason: final.stop_reason,
          content: final.content.flatMap(toPortBlock),
        };
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

  /**
   * Through the same retry and classification as everything else.
   *
   * This was the one call that went to the provider raw, which did not
   * matter much when it ran once per question and matters now that the
   * agent loop runs it before every iteration. Measured with a
   * deliberately invalid key: the request came back 500 INTERNAL_ERROR
   * with an SDK stack trace, where `complete` on the same credentials
   * would have produced a 503 naming the dependency. A provider blip
   * while counting tokens is the same kind of event as one while
   * generating, and deserves the same answer.
   */
  async countTokens(request: Pick<LlmRequest, 'system' | 'messages'>): Promise<number> {
    return this.withRetries(() => this.countTokensOnce(request));
  }

  private async countTokensOnce(
    request: Pick<LlmRequest, 'system' | 'messages'>,
  ): Promise<number> {
    // The provider's own counter, not a local tokenizer guess: budgets that
    // are enforced on an estimate drift from what is actually billed.
    const response = await this.client.messages.countTokens({
      model: this.config.model,
      system: request.system,
      messages: request.messages.map(toWireMessage),
    });

    return response.input_tokens;
  }

  /**
   * Retries bounded by a deadline, not just by a count.
   *
   * `maxRetries` alone multiplies the per-attempt timeout: four attempts
   * at a 60-second SDK timeout, plus backoff, is over four minutes of
   * provider work — every second of it billed — behind a caller the
   * global 30-second request budget gave up on long before. The retry
   * loop has to know when the answer stops being wanted.
   *
   * The budget covers the whole operation, so an attempt that would
   * start past it is not started at all.
   */
  private async withRetries<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    const deadline = Date.now() + this.config.requestTimeoutMs;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const classified = this.classify(error);

        const waitMs = classified.retryAfterMs ?? backoffDelay(attempt, 500, 20_000);
        const outOfTime = Date.now() + waitMs >= deadline;

        if (!classified.retryable || attempt === this.config.maxRetries || outOfTime) {
          if (outOfTime && classified.retryable) {
            this.logger.warn(
              `LLM budget of ${this.config.requestTimeoutMs}ms spent after ${attempt + 1} attempt(s); not retrying`,
            );
          }
          throw classified.retryAfterMs !== undefined
            ? new RateLimitedError(classified.message, classified.retryAfterMs)
            : new DependencyFailureError('anthropic', classified.message, {
                cause: error,
                retryable: classified.retryable,
              });
        }

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

/**
 * Port blocks to the wire, and back.
 *
 * The two shapes are close enough to tempt a cast and different enough
 * that a cast would be wrong: Anthropic nests a tool result's content as
 * blocks and names the fields in snake case. Translating in the adapter
 * is what lets the agent loop be written against the port.
 */
function toWireMessage(message: LlmMessage): Anthropic.MessageParam {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content };
  }

  return {
    role: message.role,
    content: message.content.map((block): Anthropic.ContentBlockParam => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            ...(block.isError ? { is_error: true } : {}),
          };
      }
    }),
  };
}

function toPortBlock(block: Anthropic.ContentBlock): LlmContentBlock[] {
  if (block.type === 'text') {
    return [{ type: 'text', text: block.text }];
  }
  if (block.type === 'tool_use') {
    return [
      {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      },
    ];
  }
  // Thinking blocks and anything the SDK adds later are not part of the
  // contract the loop reads; dropping them is deliberate, not an omission.
  return [];
}
