import type { LlmToolDefinition } from './llm.port.js';

export interface ToolContext {
  /**
   * Taken from the authenticated principal, never from the model.
   *
   * This is the property the whole design rests on. The model chooses
   * *what* to ask for — a period, a status — and never *whose* data: no
   * tool accepts a user id, so there is no argument an injected
   * instruction could set to read someone else's account. Confining the
   * blast radius of a prompt injection to "it fetched a different date
   * range" is what makes handing an LLM a query tool defensible at all.
   */
  readonly userId: string;
  readonly signal?: AbortSignal | undefined;
}

export interface AssistantTool {
  readonly definition: LlmToolDefinition;
  /** Returns the text the model will see. Throwing is reported to it. */
  run(input: unknown, context: ToolContext): Promise<string>;
}

export const ASSISTANT_TOOLS = Symbol.for('payhub:AssistantTools');
