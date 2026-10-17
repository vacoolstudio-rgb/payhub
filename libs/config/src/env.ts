import { type Env, envSchema } from './env.schema.js';

let cached: Env | undefined;

export class EnvValidationError extends Error {
  constructor(readonly issues: ReadonlyArray<{ path: string; message: string }>) {
    super(
      [
        'Invalid environment configuration:',
        ...issues.map((issue) => `  • ${issue.path}: ${issue.message}`),
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates `process.env` exactly once per process.
 *
 * Returning a frozen object (rather than reading `process.env` lazily) means
 * nothing can mutate configuration after bootstrap — a surprisingly common
 * source of "works on my machine" incidents.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) {
    return cached;
  }

  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  cached = Object.freeze(parsed.data);
  return cached;
}

/** Test-only escape hatch. */
export function resetEnvCache(): void {
  cached = undefined;
}
