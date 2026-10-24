export const LLM_PROVIDER = Symbol.for('payhub:LlmProvider');

/**
 * A block of a message.
 *
 * A turn stops being a string the moment the model can call a tool: the
 * reply may be prose, a request to run something, or both, and the next
 * turn has to carry the results back in the same order they were asked
 * for. Keeping that shape in the port means the loop is written once
 * against an interface rather than against one vendor's wire format.
 */
export type LlmContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      readonly content: string;
      readonly isError?: boolean;
    };

export interface LlmMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly LlmContentBlock[];
}

/**
 * What the model is allowed to ask for.
 *
 * The schema is the contract and the guard: an argument outside it never
 * reaches a handler, so the handler is written for valid input only.
 */
export interface LlmToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface LlmCompletion {
  readonly text: string;
  /** Every block the model returned, in order — `text` is these flattened. */
  readonly content: readonly LlmContentBlock[];
  readonly usage: LlmUsage;
  readonly model: string;
  /** `tool_use` means the model is waiting for results before it answers. */
  readonly stopReason: string | null;
}

export type LlmStreamChunk =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'done';
      readonly usage: LlmUsage;
      readonly stopReason: string | null;
      /**
       * Every block of the completed turn. Carried so a streaming caller
       * can see a `tool_use` it has to satisfy before the model will say
       * anything else — without it, a stream that ends in a tool request
       * looks identical to one that ends in an answer.
       */
      readonly content?: readonly LlmContentBlock[];
    }
  | { readonly type: 'error'; readonly message: string; readonly retryable: boolean };

export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly maxOutputTokens?: number;
  /**
   * Marks the prefix that should be cached. The platform-wide system prompt
   * and the user's financial context are stable across a conversation, so
   * caching them turns a 4k-token prefix into a ~0.1x-cost read on every
   * follow-up question.
   */
  readonly cacheSystemPrompt?: boolean;
  /** Omit entirely to forbid tool use for this request. */
  readonly tools?: readonly LlmToolDefinition[];
  readonly signal?: AbortSignal;
}

export interface LlmProvider {
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmCompletion>;
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk>;
  /** Exact token count from the provider — never an estimate from a tokenizer guess. */
  countTokens(request: Pick<LlmRequest, 'system' | 'messages'>): Promise<number>;
}
