import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Executable architecture rules.
 *
 * Layering that is only written in a README decays within a quarter: the
 * first time somebody needs a repository inside an aggregate, they import
 * it and nothing complains. These tests fail the build instead, which is
 * the only thing that actually keeps a dependency rule alive.
 */

const ROOT = new URL('..', import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true, recursive: true });

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts') &&
        !entry.name.endsWith('.d.ts'),
    )
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

function importsOf(file: string): string[] {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const specifiers: string[] = [];

  for (const match of source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

function violations(
  files: string[],
  predicate: (file: string) => boolean,
  isForbidden: (specifier: string) => boolean,
): string[] {
  return files
    .filter(predicate)
    .flatMap((file) =>
      importsOf(file)
        .filter(isForbidden)
        .map((specifier) => `${file} → ${specifier}`),
    );
}

const inLayer = (layer: string) => (file: string) => file.split(sep).includes(layer);

describe('architecture', () => {
  /**
   * The dependency rule, Clean Architecture's one non-negotiable: source
   * code dependencies point inwards only. The domain may be imported by
   * everything and may import nothing but itself and the kernel.
   */
  it('keeps infrastructure out of the domain layer', async () => {
    const files = [...(await sourceFiles('apps')), ...(await sourceFiles('libs'))];

    const forbidden = [
      'typeorm',
      '@nestjs/typeorm',
      'ioredis',
      'kafkajs',
      'bullmq',
      '@nestjs/bullmq',
      'express',
      '@nestjs/microservices',
      '@nestjs/graphql',
      '@nestjs/websockets',
      '@anthropic-ai/sdk',
      '@payhub/persistence',
      '@payhub/redis',
      '@payhub/messaging',
      '@payhub/queue',
    ];

    const offenders = violations(files, inLayer('domain'), (specifier) =>
      forbidden.some((banned) => specifier === banned || specifier.startsWith(`${banned}/`)),
    );

    // `@nestjs/common` is deliberately *not* on the list: a domain service
    // carrying `@Injectable()` is a pragmatic concession, and the decorator
    // imposes no framework behaviour on the class.
    expect(offenders).toEqual([]);
  });

  it('never lets the domain reach outwards into infrastructure or presentation', async () => {
    const files = [...(await sourceFiles('apps')), ...(await sourceFiles('libs'))];

    const offenders = violations(
      files,
      inLayer('domain'),
      (specifier) =>
        specifier.includes('/infrastructure/') || specifier.includes('/presentation/'),
    );

    expect(offenders).toEqual([]);
  });

  it('never lets the application layer depend on presentation', async () => {
    const files = await sourceFiles('apps');

    const offenders = violations(files, inLayer('application'), (specifier) =>
      specifier.includes('/presentation/'),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * The kernel is the innermost circle: pure TypeScript, no framework, no
   * other library. If it ever imports Nest, every consumer inherits that
   * dependency and the domain stops being testable with plain `new`.
   */
  it('keeps the kernel free of framework and sibling dependencies', async () => {
    const files = await sourceFiles('libs/kernel');

    const offenders = violations(
      files,
      () => true,
      (specifier) =>
        specifier.startsWith('@nestjs/') ||
        (specifier.startsWith('@payhub/') && specifier !== '@payhub/kernel'),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * Bounded contexts talk through contracts, not through each other's
   * internals. The one allowed exception is the worker reusing the API's
   * entities: they are the same context deployed twice, and the README
   * says so.
   */
  it('keeps services from importing each other, except the documented worker↔api pair', async () => {
    const files = await sourceFiles('apps');

    const offenders = files.flatMap((file) => {
      const owner = file.split(sep)[1];
      const fileDir = join(ROOT, file, '..');

      return importsOf(file)
        .filter((specifier) => specifier.startsWith('.'))
        .map((specifier) => relative(ROOT, resolve(fileDir, specifier)))
        .filter((target) => target.startsWith(`apps${sep}`))
        .map((target) => target.split(sep)[1])
        .filter((target): target is string => Boolean(target) && target !== owner)
        // The worker is the API's background half: same bounded context,
        // same schema, deployed separately for a different workload shape.
        .filter((target) => !(owner === 'worker' && target === 'api'))
        .map((target) => `${file} → apps/${target}`);
    });

    expect(offenders).toEqual([]);
  });

  /** Only the contracts library may be imported by every service. */
  it('routes cross-service communication through @payhub/contracts', async () => {
    const files = await sourceFiles('libs/contracts');

    const offenders = violations(
      files,
      () => true,
      (specifier) => specifier.startsWith('@payhub/') && specifier !== '@payhub/kernel',
    );

    expect(offenders).toEqual([]);
  });
});

/**
 * Source files have to stay readable to the tools that read them.
 *
 * Two modules carried a literal NUL byte: one as the sentinel for a
 * cached absence, one as a domain separator inside a hash. Both choices
 * were right - a NUL cannot appear in JSON, and a separator is what
 * stops ("ab","c") and ("a","bc") hashing alike - and both were spelled
 * as the byte instead of an escape.
 *
 * The string is identical at runtime and the file is not. Git
 * classified those modules as binary, so they had no diffs and no
 * blame; grep skipped them in silence, which is the half that costs
 * real time - searching this repository for `getOrSet` did not list its
 * own definition, and the answer looked like the method did not exist.
 *
 * Nothing about that is visible in an editor, so it needs a test.
 */
describe('source encoding', () => {
  /** Tab, newline and carriage return are the only ones that belong. */
  const FORBIDDEN = (byte: number) => byte < 9 || (byte > 13 && byte < 32);

  it('contains no control characters outside the printable range', async () => {
    const files = [
      ...(await sourceFiles('apps')),
      ...(await sourceFiles('libs')),
      ...(await sourceFiles('test')),
    ];

    const offenders = files.flatMap((file) => {
      const bytes = readFileSync(join(ROOT, file));
      const index = bytes.findIndex(FORBIDDEN);

      if (index === -1) {
        return [];
      }

      const line = bytes.subarray(0, index).toString('utf8').split('\n').length;
      const code = `0x${bytes[index]!.toString(16).padStart(2, '0')}`;
      return [`${file}:${line} contains ${code} - write it as an escape instead`];
    });

    expect(offenders).toEqual([]);
  });
});

/**
 * A setting that nothing reads is a knob that turns nothing.
 *
 * Four of them had accumulated. `HTTP_BODY_LIMIT` was validated,
 * defaulted to 256 kb and ignored, so Express's own 100 kb default did
 * the limiting. `WEBHOOK_CONCURRENCY` and `LLM_CACHE_TTL_SEC` each sat
 * next to a hardcoded constant of the same value, which is the worst
 * case: the knob looks connected because the number matches.
 *
 * `JWT_REFRESH_SECRET` was the one that mattered. Refresh tokens are 32
 * random bytes, stored hashed — nothing signs them — and there was a
 * production rule requiring it to differ from the access secret. An
 * operator rotating it to end every session would have achieved
 * nothing, silently.
 *
 * This is the shape of defect that keeps turning up here: a thing that
 * is declared, documented and wired to nowhere. A test is the only way
 * it stays fixed.
 */
describe('configuration', () => {
  const CONFIG_DIR = 'libs/config/src';

  it('has no environment variable that nothing reads', async () => {
    const schema = readFileSync(join(ROOT, CONFIG_DIR, 'env.schema.ts'), 'utf8');
    const namespaces = readFileSync(join(ROOT, CONFIG_DIR, 'namespaces.ts'), 'utf8');

    const keys = [...schema.matchAll(/^\s{4}([A-Z][A-Z0-9_]+):\s/gm)].map((match) => match[1]!);
    const property = new Map(
      [...namespaces.matchAll(/(\w+):\s*env\.([A-Z][A-Z0-9_]+)/g)].map((match) => [
        match[2]!,
        match[1]!,
      ]),
    );

    // Everything outside the config library itself: a variable being
    // read only by the module that defines it is the case under test.
    const consumers = [
      ...(await sourceFiles('apps')),
      ...(await sourceFiles('libs')),
    ].filter((file) => !file.startsWith(join('libs', 'config', 'src')));

    const corpus = consumers.map((file) => readFileSync(join(ROOT, file), 'utf8')).join('\n');

    const unread = [...new Set(keys)].filter((key) => {
      const prop = property.get(key);
      return !corpus.includes(key) && !(prop && corpus.includes(`.${prop}`));
    });

    expect(unread).toEqual([]);
  });
});

/**
 * Defaults that are written down twice.
 *
 * Two values are read from `process.env` directly rather than through
 * the validated config, and for a good reason: both are needed at
 * import time, before any module graph exists. `KAFKA_TOPIC_PREFIX`
 * builds the topic names in `@payhub/contracts`, and
 * `RECONCILIATION_CRON` is an argument to a decorator.
 *
 * The cost is that each one's default is typed out in two places. That
 * drift is silent in the worst way: change the schema's prefix and
 * producers keep publishing to the old topic names while consumers
 * subscribe to the new ones. Nothing errors — messages simply stop
 * arriving.
 *
 * So the two spellings are pinned together here. A third reader of
 * `process.env` appearing outside the config library is also worth
 * knowing about, which is why this counts them.
 */
/** Source with block and line comments removed, naively but adequately. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('configuration read before the config exists', () => {
  const schema = () => readFileSync(join(ROOT, 'libs/config/src/env.schema.ts'), 'utf8');

  const defaultOf = (key: string): string => {
    const match = new RegExp(`${key}:[^\\n]*?\\.default\\('([^']*)'\\)`).exec(schema());
    if (!match) throw new Error(`no default for ${key} in the schema`);
    return match[1]!;
  };

  it('agrees with the schema on the topic prefix', () => {
    const topics = readFileSync(join(ROOT, 'libs/contracts/src/topics.ts'), 'utf8');
    const inline = /KAFKA_TOPIC_PREFIX'\]\s*\?\?\s*'([^']*)'/.exec(topics);

    expect(inline?.[1]).toBe(defaultOf('KAFKA_TOPIC_PREFIX'));
  });

  it('agrees with the schema on the reconciliation schedule', () => {
    const job = readFileSync(
      join(ROOT, 'apps/ledger/src/application/jobs/reconciliation.job.ts'),
      'utf8',
    );
    const inline = /RECONCILIATION_CRON'\]\s*\?\?\s*'([^']*)'/.exec(job);

    expect(inline?.[1]).toBe(defaultOf('RECONCILIATION_CRON'));
  });

  /**
   * Anything else reaching for `process.env` should go through the
   * validated config instead — the cookie's `secure` flag did, and read
   * `NODE_ENV` separately from the `isProduction` the rest of the
   * service uses.
   */
  it('has no other reader of the raw environment', async () => {
    const files = [...(await sourceFiles('apps')), ...(await sourceFiles('libs'))].filter(
      (file) =>
        !file.startsWith(join('libs', 'config', 'src')) &&
        !file.endsWith(join('src', 'main.ts')),
    );

    // Comments are stripped first: a note explaining why something does
    // *not* read `process.env` would otherwise be counted as a reader,
    // which is exactly what happened when this was first written.
    const readers = files.filter((file) =>
      withoutComments(readFileSync(join(ROOT, file), 'utf8')).includes('process.env'),
    );

    expect(readers.sort()).toEqual([
      join('apps', 'ledger', 'src', 'application', 'jobs', 'reconciliation.job.ts'),
      join('libs', 'contracts', 'src', 'topics.ts'),
    ]);
  });
});
