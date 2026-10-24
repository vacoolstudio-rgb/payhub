import { beforeEach, describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv, resetEnvCache } from './env.js';

const MINIMAL = {
  DATABASE_URL: 'postgresql://payhub:payhub@localhost:5432/payhub',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  API_KEY_PEPPER: 'c'.repeat(16),
} as unknown as NodeJS.ProcessEnv;

const withEnv = (overrides: Record<string, string>) =>
  ({ ...MINIMAL, ...overrides }) as unknown as NodeJS.ProcessEnv;

describe('environment validation', () => {
  beforeEach(() => resetEnvCache());

  it('accepts a minimal configuration and fills the defaults', () => {
    const env = loadEnv(MINIMAL);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.KAFKA_BROKERS).toEqual(['localhost:9092']);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces and parses the shapes the process actually receives', () => {
    const env = loadEnv(
      withEnv({
        PORT: '8080',
        LOG_PRETTY: 'true',
        METRICS_ENABLED: '0',
        KAFKA_BROKERS: 'a:9092, b:9092 ,c:9092',
      }),
    );

    // Everything arrives as a string; the schema is what makes it typed.
    expect(env.PORT).toBe(8080);
    expect(env.LOG_PRETTY).toBe(true);
    expect(env.METRICS_ENABLED).toBe(false);
    expect(env.KAFKA_BROKERS).toEqual(['a:9092', 'b:9092', 'c:9092']);
  });

  /** Fail fast: a broken deployment must not reach the readiness probe. */
  it('refuses to start without a database URL', () => {
    const { DATABASE_URL: _removed, ...rest } = MINIMAL as Record<string, string>;

    expect(() => loadEnv(rest as NodeJS.ProcessEnv)).toThrow(EnvValidationError);
  });

  it('names every offending variable at once, not one per restart', () => {
    try {
      loadEnv({ DATABASE_URL: 'not-a-url', JWT_ACCESS_SECRET: 'short' } as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (error) {
      const issues = (error as EnvValidationError).issues.map((issue) => issue.path);

      expect(issues).toContain('DATABASE_URL');
      expect(issues).toContain('JWT_ACCESS_SECRET');
      expect(issues).toContain('API_KEY_PEPPER');
    }
  });

  it('rejects a non-postgres database URL', () => {
    expect(() => loadEnv(withEnv({ DATABASE_URL: 'mysql://localhost/db' }))).toThrow(
      EnvValidationError,
    );
  });

  it('rejects secrets that are too short to be secrets', () => {
    expect(() => loadEnv(withEnv({ JWT_ACCESS_SECRET: 'x'.repeat(31) }))).toThrow();
  });

  /**
   * There used to be a rule here that access and refresh tokens must be
   * signed with different secrets in production. Refresh tokens are not
   * signed at all — they are 32 random bytes, stored hashed — so
   * `JWT_REFRESH_SECRET` signed nothing, and the rule asserted a
   * relationship between a real secret and a decorative one.
   *
   * That is worse than an unused variable. It told an operator the two
   * keys were independent levers, so rotating the refresh secret to end
   * every session would have done nothing at all, silently. The
   * variable and the rule are both gone; this test is what remains, so
   * nobody re-adds the knob without re-adding the mechanism.
   */
  it('does not ask for a secret that signs nothing', () => {
    const env = loadEnv(withEnv({}));

    expect(Object.keys(env)).not.toContain('JWT_REFRESH_SECRET');
  });

  it('still rejects a weak access secret, which does sign something', () => {
    expect(() => loadEnv(withEnv({ JWT_ACCESS_SECRET: 'x'.repeat(31) }))).toThrow(
      EnvValidationError,
    );
  });

  it('requires an API key when the assistant is switched on', () => {
    expect(() => loadEnv(withEnv({ LLM_ENABLED: 'true' }))).toThrow(EnvValidationError);

    resetEnvCache();
    expect(() => loadEnv(withEnv({ LLM_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test' }))).not.toThrow();
  });

  it('requires SASL credentials when a SASL mechanism is selected', () => {
    expect(() => loadEnv(withEnv({ KAFKA_SASL_MECHANISM: 'plain' }))).toThrow(EnvValidationError);
  });

  it('rejects a pool whose minimum exceeds its maximum', () => {
    expect(() =>
      loadEnv(withEnv({ DATABASE_POOL_MIN: '50', DATABASE_POOL_MAX: '10' })),
    ).toThrow(EnvValidationError);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadEnv(withEnv({ PORT: '70000' }))).toThrow();
  });

  it('freezes the result and memoises it', () => {
    const first = loadEnv(MINIMAL);
    const second = loadEnv(withEnv({ PORT: '9999' }));

    // Configuration is read once at bootstrap; nothing may change it later.
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toBe(first);
    expect(second.PORT).toBe(3000);
  });
});

/**
 * Durability is the replica count, not the producer's ack setting — see
 * the note in the Kafka producer. These two values have to agree with
 * each other or every write is rejected, so the schema checks them.
 */
describe('Kafka replication', () => {
  // `loadEnv` memoises, so each case needs a clean slate.
  beforeEach(() => resetEnvCache());

  it('defaults min.insync to one short of the replica count', () => {
    expect(loadEnv(withEnv({ KAFKA_REPLICATION_FACTOR: '3' })).KAFKA_REPLICATION_FACTOR).toBe(3);
  });

  it('refuses a quorum larger than the replica count', () => {
    expect(() =>
      loadEnv(withEnv({ KAFKA_REPLICATION_FACTOR: '2', KAFKA_MIN_INSYNC_REPLICAS: '5' })),
    ).toThrow(/cannot exceed/);
  });

  it('accepts a quorum the cluster can satisfy', () => {
    expect(() =>
      loadEnv(withEnv({ KAFKA_REPLICATION_FACTOR: '3', KAFKA_MIN_INSYNC_REPLICAS: '2' })),
    ).not.toThrow();
  });
});

/**
 * Timeouts only mean anything in relation to each other. Each of these
 * pairs was wrong in the codebase at some point, and in both cases the
 * individual values looked perfectly reasonable on their own.
 */
describe('timeout nesting', () => {
  beforeEach(() => resetEnvCache());

  it('refuses an LLM budget at or above the request budget', () => {
    expect(() =>
      loadEnv(withEnv({ REQUEST_TIMEOUT_MS: '30000', LLM_REQUEST_TIMEOUT_MS: '30000' })),
    ).toThrow(/LLM_REQUEST_TIMEOUT_MS/);
  });

  /**
   * Equal is not safe: the handler keeps running after the interceptor
   * stops waiting, so a lock expiring at the same instant lets a retry
   * start the same payment again.
   */
  it('refuses an idempotency lock that expires with the request', () => {
    expect(() =>
      loadEnv(withEnv({ REQUEST_TIMEOUT_MS: '30000', IDEMPOTENCY_LOCK_TTL_MS: '30000' })),
    ).toThrow(/IDEMPOTENCY_LOCK_TTL_MS/);
  });

  it('accepts a correctly nested set', () => {
    expect(() =>
      loadEnv(
        withEnv({
          REQUEST_TIMEOUT_MS: '30000',
          LLM_REQUEST_TIMEOUT_MS: '25000',
          IDEMPOTENCY_LOCK_TTL_MS: '45000',
        }),
      ),
    ).not.toThrow();
  });
});
