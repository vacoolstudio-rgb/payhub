import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { PINO_REDACT_PATHS, redact } from '@payhub/shared';

/**
 * What actually reaches the log.
 *
 * Against the real logger rather than the helper, because the helper
 * was never the question: `redact()` was correct for the cases it was
 * tested on and called by nothing, while the configuration that *is*
 * used leaked. pino's `*` matches exactly one level, so `*.password`
 * covers `user.password` and nothing else — measured on this very
 * configuration, a top-level `password`, one two levels down, and a
 * nested request body carrying a password alongside an `ph_live_` key
 * all went out in plain text.
 *
 * Testing the composition is the only thing that would have caught it.
 */
describe('what the logger writes', () => {
  const capture = (
    log: (logger: pino.Logger) => void,
    withFormatter = true,
  ): string => {
    const lines: string[] = [];
    const logger = pino(
      {
        redact: { paths: PINO_REDACT_PATHS, censor: '[redacted]' },
        ...(withFormatter
          ? { formatters: { log: (object: Record<string, unknown>) => redact(object) } }
          : {}),
      },
      { write: (line: string) => void lines.push(line) },
    );

    log(logger as pino.Logger);
    return lines.join('\n');
  };

  const SECRET = 'hunter2';
  const KEY = 'ph_live_abcdefghijklmnop';

  it('masks a secret at the top level', () => {
    expect(capture((l) => l.info({ password: SECRET }, 'x'))).not.toContain(SECRET);
  });

  it('masks a secret on the documented request path', () => {
    expect(capture((l) => l.info({ req: { body: { password: SECRET } }}, 'x'))).not.toContain(
      SECRET,
    );
  });

  it('masks a secret two levels down', () => {
    expect(capture((l) => l.info({ a: { b: { password: SECRET } } }, 'x'))).not.toContain(SECRET);
  });

  it('masks an api key nested inside a request body', () => {
    const line = capture((l) =>
      l.info({ req: { body: { nested: { password: SECRET, apiKey: KEY } } } }, 'x'),
    );

    expect(line).not.toContain(SECRET);
    expect(line).not.toContain(KEY);
  });

  it('leaves ordinary fields alone', () => {
    const line = capture((l) => l.info({ merchantId: 'm-1', amount: '10.00' }, 'x'));

    expect(line).toContain('m-1');
    expect(line).toContain('10.00');
  });

  it('still writes the message', () => {
    expect(capture((l) => l.info({ password: SECRET }, 'payment captured'))).toContain(
      'payment captured',
    );
  });

  /**
   * The gap, stated as a test: without the recursive pass the path list
   * alone lets three of these through. If someone removes the
   * formatter believing `redact.paths` covers it, this says otherwise.
   */
  it('is not covered by the path list alone', () => {
    const withoutFormatter = capture((l) => l.info({ a: { b: { password: SECRET } } }, 'x'), false);

    expect(withoutFormatter).toContain(SECRET);
  });
});
