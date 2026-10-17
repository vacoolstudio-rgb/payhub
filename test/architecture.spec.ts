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
