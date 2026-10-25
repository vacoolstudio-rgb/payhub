import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantTool } from '../domain/assistant-tool.port.js';
import type { LlmCompletion, LlmContentBlock, LlmProvider } from '../domain/llm.port.js';
import { AgentLoopService } from './agent-loop.service.js';

const NO_USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

const text = (value: string): LlmCompletion => ({
  text: value,
  content: [{ type: 'text', text: value }],
  usage: NO_USAGE,
  model: 'test-model',
  stopReason: 'end_turn',
});

const asks = (name: string, input: Record<string, unknown> = {}, id = `call-${name}`): LlmCompletion => ({
  text: '',
  content: [{ type: 'tool_use', id, name, input }],
  usage: NO_USAGE,
  model: 'test-model',
  stopReason: 'tool_use',
});

/**
 * The loop, and every bound on it.
 *
 * Handing a model a query tool turns a question into something that can
 * drive work, so the interesting tests are not "does it answer" but
 * "what can a question make it do". Each case below is a way a run could
 * cost more than it should, or reach further than it should.
 */
describe('AgentLoopService', () => {
  let llm: { complete: ReturnType<typeof vi.fn>; countTokens: ReturnType<typeof vi.fn>; stream: ReturnType<typeof vi.fn>; model: string };
  let loop: AgentLoopService;
  let run: ReturnType<typeof vi.fn>;
  let tool: AssistantTool;

  const execute = (overrides: Partial<Parameters<AgentLoopService['run']>[0]> = {}) =>
    loop.run({
      system: 'system',
      messages: [{ role: 'user', content: 'how much did I spend?' }],
      tools: [tool],
      context: { userId: 'user-1' },
      authorize: async () => undefined,
      ...overrides,
    });

  beforeEach(() => {
    run = vi.fn<(input: unknown, context: { userId: string }) => Promise<string>>()
      .mockResolvedValue('totals: 12.00 USD');
    tool = {
      definition: { name: 'get_payment_totals', description: 'totals', inputSchema: {} },
      run: run as AssistantTool['run'],
    };
    llm = {
      model: 'test-model',
      complete: vi.fn(),
      stream: vi.fn(),
      countTokens: vi.fn().mockResolvedValue(100),
    };
    loop = new AgentLoopService(llm as unknown as LlmProvider);
  });

  it('answers without calling anything when the model does not ask', async () => {
    llm.complete.mockResolvedValue(text('Your balance is 10.00 USD.'));

    const result = await execute();

    expect(result.answer).toBe('Your balance is 10.00 USD.');
    expect(run).not.toHaveBeenCalled();
    expect(result.iterations).toBe(1);
  });

  it('runs what the model asked for and feeds the result back', async () => {
    llm.complete
      .mockResolvedValueOnce(asks('get_payment_totals', { from: '2026-03-01', to: '2026-04-01' }))
      .mockResolvedValueOnce(text('You spent 12.00 USD in March.'));

    const result = await execute();

    expect(run).toHaveBeenCalledWith(
      { from: '2026-03-01', to: '2026-04-01' },
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(result.answer).toBe('You spent 12.00 USD in March.');
    expect(result.toolCalls).toEqual(['get_payment_totals']);
  });

  /**
   * The property the whole design rests on: the model picks the window,
   * never the account. It cannot pass a user id because no tool takes
   * one, and the context it does get is built from the principal.
   */
  it('passes the caller from the context, not from the model', async () => {
    llm.complete
      .mockResolvedValueOnce(asks('get_payment_totals', { userId: 'someone-else' }))
      .mockResolvedValueOnce(text('done'));

    await execute();

    expect(run.mock.calls[0]?.[1]).toMatchObject({ userId: 'user-1' });
  });

  describe('bounds', () => {
    it('stops asking after the iteration cap and answers from what it has', async () => {
      llm.complete.mockResolvedValue(asks('get_payment_totals', { from: '2026-01-01' }));
      llm.complete.mockResolvedValueOnce(asks('get_payment_totals', { from: '2026-01-01' }));

      const result = await execute();

      expect(result.iterations).toBeLessThanOrEqual(5);
      expect(llm.complete.mock.calls.length).toBeLessThanOrEqual(5);
    });

    it('offers no tools on the final request, so the model has to answer', async () => {
      llm.complete.mockResolvedValue(asks('get_payment_totals', { from: '2026-01-01' }));

      await execute();

      const last = llm.complete.mock.calls.at(-1)?.[0] as { tools?: unknown };
      expect(last.tools).toBeUndefined();
    });

    it('caps the number of tool executions across the whole run', async () => {
      let n = 0;
      llm.complete.mockImplementation(async () => {
        n += 1;
        return asks('get_payment_totals', { from: `2026-01-0${n}` }, `call-${n}`);
      });

      const result = await execute();

      expect(result.toolCalls.length).toBeLessThanOrEqual(6);
    });

    /** Models retry. A retry should not cost a second query. */
    it('answers an identical repeated call from the first result', async () => {
      llm.complete
        .mockResolvedValueOnce(asks('get_payment_totals', { from: '2026-03-01', to: '2026-04-01' }, 'a'))
        .mockResolvedValueOnce(asks('get_payment_totals', { to: '2026-04-01', from: '2026-03-01' }, 'b'))
        .mockResolvedValueOnce(text('done'));

      await execute();

      expect(run).toHaveBeenCalledTimes(1);
    });

    it('truncates a result before it becomes input', async () => {
      run.mockResolvedValue('x'.repeat(10_000));
      llm.complete
        .mockResolvedValueOnce(asks('get_payment_totals'))
        .mockResolvedValueOnce(text('done'));

      await execute();

      const second = llm.complete.mock.calls[1]?.[0] as { messages: Array<{ content: LlmContentBlock[] }> };
      const result = second.messages.at(-1)?.content[0];
      expect(result?.type).toBe('tool_result');
      expect(result?.type === 'tool_result' && result.content.length).toBeLessThan(4_200);
    });

    it('authorises the budget before every billed request, not just the first', async () => {
      const authorize = vi.fn().mockResolvedValue(undefined);
      llm.complete
        .mockResolvedValueOnce(asks('get_payment_totals'))
        .mockResolvedValueOnce(text('done'));

      await execute({ authorize });

      expect(authorize).toHaveBeenCalledTimes(2);
    });

    it('stops the run when the budget refuses mid-way', async () => {
      const authorize = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('budget exhausted'));
      llm.complete.mockResolvedValueOnce(asks('get_payment_totals'));

      await expect(execute({ authorize })).rejects.toThrow('budget exhausted');
    });
  });

  describe('failures', () => {
    it('reports a failing lookup to the model instead of failing the request', async () => {
      run.mockRejectedValue(new Error('the window may not exceed 366 days'));
      llm.complete
        .mockResolvedValueOnce(asks('get_payment_totals', { from: '1999-01-01', to: '2026-01-01' }))
        .mockResolvedValueOnce(text('That range is too wide — try a single year.'));

      const result = await execute();

      expect(result.answer).toContain('too wide');
      const second = llm.complete.mock.calls[1]?.[0] as { messages: Array<{ content: LlmContentBlock[] }> };
      const block = second.messages.at(-1)?.content[0];
      expect(block?.type === 'tool_result' && block.isError).toBe(true);
    });

    it('tells the model when it asks for a tool that does not exist', async () => {
      llm.complete
        .mockResolvedValueOnce(asks('transfer_money', { to: 'attacker' }))
        .mockResolvedValueOnce(text('I cannot move money.'));

      const result = await execute();

      expect(run).not.toHaveBeenCalled();
      expect(result.answer).toBe('I cannot move money.');
    });
  });
});

/**
 * The streamed loop, and the way a stream really ends.
 *
 * A reader closing the tab is the common case, not an exotic one: the
 * abort signal fires and the provider's iterator stops without a
 * `done` chunk. The loop used to carry on from there — appending an
 * assistant message with an empty content list, which the API rejects,
 * and then spending another billed call on a question nobody was
 * waiting for. Possibly several, since this is a loop.
 */
describe('AgentLoopService.stream', () => {
  const NO_USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

  const build = (turns: Array<Array<Record<string, unknown>>>) => {
    const calls: Array<Record<string, unknown>> = [];
    let turn = 0;

    const llm = {
      model: 'test-model',
      countTokens: vi.fn().mockResolvedValue(10),
      complete: vi.fn(),
      stream: vi.fn((request: Record<string, unknown>) => {
        calls.push(request);
        const chunks = turns[turn] ?? [];
        turn += 1;
        return (async function* emit() {
          for (const chunk of chunks) {
            yield chunk;
          }
        })();
      }),
    };

    const tool: AssistantTool = {
      definition: { name: 'get_payment_totals', description: 'totals', inputSchema: {} },
      run: async () => 'totals: 12.00 USD',
    };

    const loop = new AgentLoopService(llm as unknown as LlmProvider);

    const drain = async () => {
      const seen: Array<Record<string, unknown>> = [];
      for await (const chunk of loop.stream({
        system: 'system',
        messages: [{ role: 'user', content: 'how much?' }],
        tools: [tool],
        context: { userId: 'user-1' },
        authorize: async () => undefined,
        onUsage: async () => undefined,
      })) {
        seen.push(chunk as unknown as Record<string, unknown>);
      }
      return seen;
    };

    return { drain, calls, llm };
  };

  it('passes text through and ends on done', async () => {
    const probe = build([
      [
        { type: 'text', text: 'Your balance is 10.00.' },
        { type: 'done', usage: NO_USAGE, stopReason: 'end_turn', content: [] },
      ],
    ]);

    const seen = await probe.drain();

    expect(seen.map((c) => c['type'])).toEqual(['text', 'done']);
  });

  it('stops when the stream ends without a done chunk', async () => {
    const probe = build([[{ type: 'text', text: 'partial' }]]);

    const seen = await probe.drain();

    expect(seen.map((c) => c['type'])).toEqual(['text']);
  });

  /** The cost of not stopping: another billed request for nobody. */
  it('does not start another turn after an aborted stream', async () => {
    const probe = build([[{ type: 'text', text: 'partial' }], []]);

    await probe.drain();

    expect(probe.llm.stream).toHaveBeenCalledTimes(1);
  });

  it('runs a tool and continues into a second turn', async () => {
    const probe = build([
      [
        {
          type: 'done',
          usage: NO_USAGE,
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'a', name: 'get_payment_totals', input: {} }],
        },
      ],
      [
        { type: 'text', text: 'You spent 12.00.' },
        { type: 'done', usage: NO_USAGE, stopReason: 'end_turn', content: [] },
      ],
    ]);

    const seen = await probe.drain();

    expect(probe.llm.stream).toHaveBeenCalledTimes(2);
    expect(seen.map((c) => c['type'])).toEqual(['text', 'done']);
  });

  it('emits done exactly once across a multi-turn run', async () => {
    const probe = build([
      [
        {
          type: 'done',
          usage: NO_USAGE,
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'a', name: 'get_payment_totals', input: {} }],
        },
      ],
      [{ type: 'done', usage: NO_USAGE, stopReason: 'end_turn', content: [] }],
    ]);

    const seen = await probe.drain();

    expect(seen.filter((c) => c['type'] === 'done')).toHaveLength(1);
  });
});
