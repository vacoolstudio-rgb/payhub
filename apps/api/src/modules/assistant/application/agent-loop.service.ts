import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  LLM_PROVIDER,
  type LlmContentBlock,
  type LlmMessage,
  type LlmProvider,
  type LlmStreamChunk,
  type LlmToolDefinition,
  type LlmUsage,
} from '../domain/llm.port.js';
import type { AssistantTool, ToolContext } from '../domain/assistant-tool.port.js';

/**
 * How many times the model may come back asking for more.
 *
 * Every iteration is a full billed request whose input grows by the
 * previous results, so cost is superlinear in this number while the
 * usefulness is not: the questions this assistant answers need one
 * lookup, occasionally two. Four is room for a mistake and a retry, and
 * a hard stop long before a loop becomes a way to spend someone's money.
 */
const MAX_ITERATIONS = 4;

/** Tool executions per question, across all iterations. */
const MAX_TOOL_CALLS = 6;

/**
 * Characters of a single tool result the model is shown.
 *
 * The tools already cap their rows, so this is the floor under a tool
 * that changes later: a result is model input, and model input is money
 * and latency on every subsequent turn of the loop.
 */
const MAX_RESULT_CHARS = 4_000;

export interface AgentRun {
  readonly answer: string;
  readonly usage: LlmUsage;
  readonly model: string;
  /** Names in call order — surfaced so an answer can be explained. */
  readonly toolCalls: readonly string[];
  readonly iterations: number;
}

/**
 * The agent loop: ask, run what the model asked for, ask again.
 *
 * The honest description of the previous design is that it guessed. The
 * context block carried balances and the last twenty payments, built on
 * every question whether the question needed them or not, which made
 * "what is my balance?" pay for twenty rows nobody read and "how much
 * did I spend on transport in March?" unanswerable — March was not in
 * the last twenty and no amount of prompting could put it there.
 *
 * Letting the model fetch what it needs is the fix, and it is also the
 * part that has to be held carefully, because the loop is now a thing a
 * question can drive. Every bound here exists for that reason:
 *
 *   - iterations and total tool calls are capped, so no question can
 *     turn into an unbounded sequence of billed requests;
 *   - an identical call repeated within one question is answered from
 *     what it returned the first time, rather than run again — models
 *     retry, and a retry should not cost a second query;
 *   - a tool result is truncated before it becomes input;
 *   - the token budget is authorised before *each* iteration, not once
 *     at the start, so a run that grows past its allowance stops;
 *   - a tool that throws reports the failure to the model as a result
 *     rather than ending the request, which lets it correct an argument
 *     it got wrong — but a failure still counts against the call cap.
 *
 * And the invariant underneath all of it: no tool takes a user id. The
 * model chooses the window, never the account.
 */
@Injectable()
export class AgentLoopService {
  private readonly logger = new Logger(AgentLoopService.name);

  constructor(@Inject(LLM_PROVIDER) private readonly llm: LlmProvider) {}

  async run(input: {
    system: string;
    messages: readonly LlmMessage[];
    tools: readonly AssistantTool[];
    context: ToolContext;
    /** Called before each billed request; throwing stops the run. */
    authorize: (estimatedTokens: number) => Promise<void>;
    maxOutputTokens?: number | undefined;
  }): Promise<AgentRun> {
    const byName = new Map(input.tools.map((tool) => [tool.definition.name, tool]));
    const definitions: LlmToolDefinition[] = input.tools.map((tool) => tool.definition);

    const messages: LlmMessage[] = [...input.messages];
    const executed = new Map<string, string>();
    const called: string[] = [];
    const total: Mutable<LlmUsage> = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    let model = this.llm.model;

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      const estimated = await this.llm.countTokens({ system: input.system, messages });
      await input.authorize(estimated);

      const completion = await this.llm.complete({
        system: input.system,
        messages,
        cacheSystemPrompt: true,
        tools: definitions,
        ...(input.maxOutputTokens !== undefined
          ? { maxOutputTokens: input.maxOutputTokens }
          : {}),
        ...(input.context.signal ? { signal: input.context.signal } : {}),
      });

      model = completion.model;
      add(total, completion.usage);

      const requests = completion.content.filter(isToolUse);

      if (requests.length === 0) {
        return {
          answer: completion.text,
          usage: total,
          model,
          toolCalls: called,
          iterations: iteration,
        };
      }

      messages.push({ role: 'assistant', content: completion.content });

      const results: LlmContentBlock[] = [];
      for (const request of requests) {
        if (called.length >= MAX_TOOL_CALLS) {
          results.push({
            type: 'tool_result',
            toolUseId: request.id,
            content: 'Lookup budget for this question is exhausted. Answer from what you have.',
            isError: true,
          });
          continue;
        }

        called.push(request.name);
        results.push({
          type: 'tool_result',
          toolUseId: request.id,
          ...(await this.execute(byName, request, input.context, executed)),
        });
      }

      messages.push({ role: 'user', content: results });
    }

    // Out of iterations with the model still asking. Rather than return
    // nothing, make one last request with no tools offered, which forces
    // an answer from what has already been gathered.
    const estimated = await this.llm.countTokens({ system: input.system, messages });
    await input.authorize(estimated);

    const final = await this.llm.complete({
      system: input.system,
      messages,
      cacheSystemPrompt: true,
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
      ...(input.context.signal ? { signal: input.context.signal } : {}),
    });

    add(total, final.usage);

    return {
      answer: final.text,
      usage: total,
      model: final.model,
      toolCalls: called,
      iterations: MAX_ITERATIONS + 1,
    };
  }

  /**
   * The same loop, streamed.
   *
   * A turn that ends in a tool request is not an answer, and before the
   * `done` chunk carried the turn's blocks a streaming caller could not
   * tell the two apart — which is why the streaming path used to skip
   * tools entirely and answer from a pre-built context instead. Two
   * paths with different behaviour is the thing worth avoiding here: the
   * bounds below are the same objects the non-streaming loop uses, not
   * a second copy of them.
   *
   * Text that arrives before a tool request is passed through rather
   * than buffered. Models narrate ("let me check March") and showing
   * that is better than a silent pause.
   */
  async *stream(input: {
    system: string;
    messages: readonly LlmMessage[];
    tools: readonly AssistantTool[];
    context: ToolContext;
    authorize: (estimatedTokens: number) => Promise<void>;
    onUsage: (model: string, usage: LlmUsage) => Promise<void>;
  }): AsyncIterable<LlmStreamChunk> {
    const byName = new Map(input.tools.map((tool) => [tool.definition.name, tool]));
    const definitions = input.tools.map((tool) => tool.definition);
    const messages: LlmMessage[] = [...input.messages];
    const executed = new Map<string, string>();
    const called: string[] = [];

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      const estimated = await this.llm.countTokens({ system: input.system, messages });
      await input.authorize(estimated);

      const last = iteration === MAX_ITERATIONS;
      let pending: Array<Extract<LlmContentBlock, { type: 'tool_use' }>> = [];

      for await (const chunk of this.llm.stream({
        system: input.system,
        messages,
        cacheSystemPrompt: true,
        // The final iteration offers no tools, which forces prose out of
        // a model that would otherwise keep asking.
        ...(last ? {} : { tools: definitions }),
        ...(input.context.signal ? { signal: input.context.signal } : {}),
      })) {
        if (chunk.type === 'done') {
          await input.onUsage(this.llm.model, chunk.usage);
          pending = (chunk.content ?? []).filter(isToolUse);

          if (pending.length === 0) {
            yield chunk;
            return;
          }
          continue;
        }

        if (chunk.type === 'error') {
          yield chunk;
          return;
        }

        yield chunk;
      }

      messages.push({
        role: 'assistant',
        content: pending,
      });

      const results: LlmContentBlock[] = [];
      for (const request of pending) {
        if (called.length >= MAX_TOOL_CALLS) {
          results.push({
            type: 'tool_result',
            toolUseId: request.id,
            content: 'Lookup budget for this question is exhausted. Answer from what you have.',
            isError: true,
          });
          continue;
        }

        called.push(request.name);
        results.push({
          type: 'tool_result',
          toolUseId: request.id,
          ...(await this.execute(byName, request, input.context, executed)),
        });
      }

      messages.push({ role: 'user', content: results });
    }
  }

  private async execute(
    byName: Map<string, AssistantTool>,
    request: Extract<LlmContentBlock, { type: 'tool_use' }>,
    context: ToolContext,
    executed: Map<string, string>,
  ): Promise<{ content: string; isError?: boolean }> {
    const tool = byName.get(request.name);
    if (!tool) {
      return { content: `No tool named "${request.name}".`, isError: true };
    }

    const signature = fingerprint(request.name, request.input);
    const previous = executed.get(signature);
    if (previous !== undefined) {
      return { content: previous };
    }

    try {
      const result = truncate(await tool.run(request.input, context));
      executed.set(signature, result);
      return { content: result };
    } catch (error) {
      // Reported to the model, not thrown: a rejected argument is
      // something it can fix on the next turn, and a failing lookup
      // should degrade the answer rather than the request.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`Tool ${request.name} failed: ${message}`);
      return { content: `That lookup failed: ${message}`, isError: true };
    }
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function isToolUse(
  block: LlmContentBlock,
): block is Extract<LlmContentBlock, { type: 'tool_use' }> {
  return block.type === 'tool_use';
}

function add(total: Mutable<LlmUsage>, usage: LlmUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
}

function truncate(result: string): string {
  return result.length <= MAX_RESULT_CHARS
    ? result
    : `${result.slice(0, MAX_RESULT_CHARS)}\n… truncated; narrow the range to see the rest.`;
}

/** Stable across key order, so `{a,b}` and `{b,a}` are one call. */
function fingerprint(name: string, input: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash('sha256').update(`${name}:${canonical}`).digest('hex');
}
