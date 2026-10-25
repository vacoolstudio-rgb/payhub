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

/**
 * Personal data, which is not a secret and still does not belong in a
 * log verbatim.
 *
 * Knowing someone's address grants nothing, so erasing it outright
 * would cost debuggability for no gain. It is still personal data, and
 * logs are routinely shipped somewhere with wider access than the
 * database. The identity context had already settled this with
 * `Email.masked()`; the logger had not, and a registration wrote the
 * new user's address and display name out in full.
 */
describe('personal data in logs', () => {
  const capture = (object: Record<string, unknown>): string => {
    const lines: string[] = [];
    const logger = pino(
      {
        redact: { paths: PINO_REDACT_PATHS, censor: '[redacted]' },
        formatters: { log: (o: Record<string, unknown>) => redact(o) },
      },
      { write: (line: string) => void lines.push(line) },
    );
    (logger as pino.Logger).info(object, 'x');
    return lines.join('\n');
  };

  it('masks an address rather than printing it', () => {
    const line = capture({ email: 'probe@payhub.dev' });

    expect(line).not.toContain('probe@payhub.dev');
    expect(line).toContain('p***@payhub.dev');
  });

  it('keeps the domain, which is the part worth reading', () => {
    expect(capture({ email: 'someone@merchant.example' })).toContain('@merchant.example');
  });

  it('masks a display name', () => {
    expect(capture({ displayName: 'Probe Person' })).not.toContain('Probe Person');
  });

  it('masks an address nested anywhere', () => {
    expect(capture({ req: { body: { user: { email: 'deep@payhub.dev' } } } })).not.toContain(
      'deep@payhub.dev',
    );
  });

  /** A user id is not personal data and is the thing you search by. */
  it('leaves identifiers intact', () => {
    const line = capture({ userId: '176e78bb-de52-411f-a2a2-3f9209ef127c', email: 'a@b.c' });

    expect(line).toContain('176e78bb-de52-411f-a2a2-3f9209ef127c');
  });

  /** Masked, not erased — the distinction from a credential. */
  it('does not treat it as a secret', () => {
    expect(capture({ email: 'probe@payhub.dev' })).not.toContain('[redacted]');
  });
});
