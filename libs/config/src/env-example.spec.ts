import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from './env.js';

/**
 * `.env.example` has to satisfy the schema it documents.
 *
 * It is the first thing anybody runs — copy it, start the service — and
 * nothing checked it. A cross-field rule added to the schema broke it
 * silently: the example kept an `LLM_REQUEST_TIMEOUT_MS` the new rule
 * rejects, so a fresh clone would have failed to boot with a validation
 * error pointing at a file the newcomer never edited.
 *
 * Catching the value is worth little; catching the drift is the point.
 */
describe('.env.example', () => {
  const parse = (): Record<string, string> => {
    const text = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
    const env: Record<string, string> = {};

    for (const line of text.split('\n')) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        env[match[1]] = match[2] ?? '';
      }
    }

    return env;
  };

  beforeEach(() => resetEnvCache());

  it('is a configuration the application will actually start with', () => {
    expect(() => loadEnv(parse())).not.toThrow();
  });

  /**
   * A key documented in the example but unknown to the schema is a
   * leftover; one the schema requires but the example omits leaves a
   * newcomer guessing. Neither is caught by the parse above, since the
   * schema ignores unknown keys and fills defaults.
   */
  it('documents no key the schema does not know', () => {
    const documented = Object.keys(parse());
    const known = new Set(Object.keys(loadEnv(parse())));

    expect(documented.filter((key) => !known.has(key))).toEqual([]);
  });

  it('keeps the LLM budget inside the request budget', () => {
    const env = parse();

    expect(Number(env['LLM_REQUEST_TIMEOUT_MS'])).toBeLessThan(
      Number(env['REQUEST_TIMEOUT_MS']),
    );
  });
});
