/**
 * Server-Sent Events frame parsing, kept apart from the hook that uses it.
 *
 * The network decides where a chunk ends, not the protocol: a frame
 * routinely arrives split down the middle, and the half-frame has to be
 * carried into the next read rather than parsed as if it were whole. That
 * is the part worth testing, and it was buried inside a `for(;;)` loop
 * around a `ReadableStream` — reachable only by mocking a stream reader,
 * which tests the mock more than the parser.
 */

export interface SseFrame {
  /** `event:` line, or `message` when the server omits one, per the spec. */
  readonly event: string;
  /** Concatenated `data:` lines, newline-joined. */
  readonly data: string;
}

export interface SseScanResult {
  readonly frames: SseFrame[];
  /** The trailing partial frame, to be prepended to the next chunk. */
  readonly rest: string;
}

/**
 * Splits whatever has arrived so far into complete frames plus a remainder.
 *
 * Frames with no `data:` line are dropped: the spec allows comment-only
 * frames (`: keep-alive`), which carry nothing for a caller to act on.
 */
export function scanFrames(buffer: string): SseScanResult {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: SseFrame[] = [];

  for (const part of parts) {
    const event = /^event:\s*(.+)$/m.exec(part)?.[1]?.trim() ?? 'message';
    const data = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');

    if (data) {
      frames.push({ event, data });
    }
  }

  return { frames, rest };
}

/**
 * Parses a frame's payload, returning null rather than throwing.
 *
 * A malformed frame should cost one dropped token, not the whole answer:
 * `JSON.parse` on a truncated payload used to reject out of the read loop
 * and surface as a failed stream.
 */
export function parsePayload(data: string): { text?: string; message?: string } | null {
  try {
    return JSON.parse(data) as { text?: string; message?: string };
  } catch {
    return null;
  }
}
