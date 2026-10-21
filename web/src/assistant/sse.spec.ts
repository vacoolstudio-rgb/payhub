import { describe, expect, it } from 'vitest';
import { parsePayload, scanFrames } from './sse';

/**
 * Frame parsing for the assistant's token stream.
 *
 * Everything here is about a boundary the protocol does not control: TCP
 * decides where a chunk ends, so a frame arrives in two pieces whenever
 * it feels like it, and a parser that assumes otherwise loses tokens in
 * production and never in development.
 */
describe('scanFrames', () => {
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  it('reads a complete frame', () => {
    const { frames, rest } = scanFrames(frame('token', { text: 'hi' }));

    expect(frames).toEqual([{ event: 'token', data: '{"text":"hi"}' }]);
    expect(rest).toBe('');
  });

  it('reads several frames out of one chunk', () => {
    const { frames } = scanFrames(frame('token', { text: 'a' }) + frame('token', { text: 'b' }));

    expect(frames.map((f) => parsePayload(f.data)?.text)).toEqual(['a', 'b']);
  });

  /** The case that only shows up under real network conditions. */
  it('holds back a frame that is split across chunks', () => {
    const whole = frame('token', { text: 'hello' });
    const cut = Math.floor(whole.length / 2);

    const first = scanFrames(whole.slice(0, cut));
    expect(first.frames).toHaveLength(0);

    const second = scanFrames(first.rest + whole.slice(cut));
    expect(parsePayload(second.frames[0]!.data)?.text).toBe('hello');
  });

  it('reassembles a frame split across three chunks', () => {
    const whole = frame('token', { text: 'abc' });
    let rest = '';
    const collected: string[] = [];

    for (const chunk of [whole.slice(0, 5), whole.slice(5, 11), whole.slice(11)]) {
      const scanned = scanFrames(rest + chunk);
      rest = scanned.rest;
      collected.push(...scanned.frames.map((f) => f.data));
    }

    expect(collected).toEqual(['{"text":"abc"}']);
  });

  /** Per the SSE spec, a frame without an `event:` line is a `message`. */
  it('defaults the event name', () => {
    const { frames } = scanFrames('data: {"text":"x"}\n\n');

    expect(frames[0]?.event).toBe('message');
  });

  it('joins multi-line data', () => {
    const { frames } = scanFrames('event: token\ndata: line one\ndata: line two\n\n');

    expect(frames[0]?.data).toBe('line one\nline two');
  });

  /** Keep-alive comments carry nothing to act on. */
  it('drops a frame with no data line', () => {
    const { frames } = scanFrames(': keep-alive\n\n');

    expect(frames).toHaveLength(0);
  });

  it('keeps the order the server sent', () => {
    const chunk = ['a', 'b', 'c'].map((text) => frame('token', { text })).join('');

    expect(scanFrames(chunk).frames.map((f) => parsePayload(f.data)?.text)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('parsePayload', () => {
  it('reads a well-formed payload', () => {
    expect(parsePayload('{"text":"hi"}')).toEqual({ text: 'hi' });
  });

  /**
   * A malformed payload must cost one token, not the answer. `JSON.parse`
   * used to run unguarded inside the read loop, so a single truncated
   * frame rejected out of the stream and surfaced as a failure.
   */
  it('returns null instead of throwing on a broken payload', () => {
    expect(parsePayload('{"text":"unterminated')).toBeNull();
    expect(parsePayload('')).toBeNull();
  });
});
