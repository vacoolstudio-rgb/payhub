export const LLM_PROVIDER = Symbol.for('payhub:LlmProvider');

export interface LlmMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface LlmCompletion {
  readonly text: string;
  readonly usage: LlmUsage;
  readonly model: string;
  readonly stopReason: string | null;
}

export type LlmStreamChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'done'; readonly usage: LlmUsage; readonly stopReason: string | null }
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
  readonly signal?: AbortSignal;
}

export interface LlmProvider {
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmCompletion>;
  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk>;
  /** Exact token count from the provider — never an estimate from a tokenizer guess. */
  countTokens(request: Pick<LlmRequest, 'system' | 'messages'>): Promise<number>;
}
