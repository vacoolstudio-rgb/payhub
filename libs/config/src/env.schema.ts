import { z } from 'zod';

/**
 * Single source of truth for every environment variable the platform reads.
 *
 * The schema is parsed once at bootstrap: an invalid or missing variable
 * crashes the process before the HTTP server binds, so a broken deployment
 * never passes its readiness probe (fail fast, not fail weird at 3am).
 */

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) =>
    typeof value === 'boolean' ? value : value === 'true' || value === '1' || value === 'yes',
  );

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

const csv = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

export const NodeEnv = z.enum(['development', 'test', 'staging', 'production']);
export type NodeEnv = z.infer<typeof NodeEnv>;

export const envSchema = z
  .object({
    // ---- runtime -----------------------------------------------------------
    NODE_ENV: NodeEnv.default('development'),
    SERVICE_NAME: z.string().min(1).default('payhub-api'),
    SERVICE_VERSION: z.string().min(1).default('0.0.0-dev'),
    PORT: port.default(3000),
    HTTP_GLOBAL_PREFIX: z.string().default('api'),
    HTTP_BODY_LIMIT: z.string().default('256kb'),
    SHUTDOWN_GRACE_MS: positiveInt.default(15_000),
    REQUEST_TIMEOUT_MS: positiveInt.default(30_000),
    CORS_ORIGINS: z.string().default('*'),
    TRUST_PROXY: booleanish.default(false),

    // ---- logging & telemetry ----------------------------------------------
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: booleanish.default(false),
    METRICS_ENABLED: booleanish.default(true),
    OTEL_ENABLED: booleanish.default(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default('http://localhost:4318'),

    // ---- postgres ----------------------------------------------------------
    DATABASE_URL: z.string().url().refine((value) => value.startsWith('postgres'), {
      message: 'DATABASE_URL must be a postgres:// connection string',
    }),
    DATABASE_SCHEMA: z.string().min(1).default('public'),
    DATABASE_POOL_MAX: positiveInt.default(20),
    DATABASE_POOL_MIN: nonNegativeInt.default(2),
    DATABASE_SSL: booleanish.default(false),
    DATABASE_LOGGING: booleanish.default(false),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveInt.default(10_000),
    DATABASE_LOCK_TIMEOUT_MS: positiveInt.default(5_000),
    DATABASE_RUN_MIGRATIONS: booleanish.default(false),

    // ---- redis -------------------------------------------------------------
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    REDIS_KEY_PREFIX: z.string().default('payhub'),
    REDIS_MAX_RETRIES: nonNegativeInt.default(10),

    // ---- kafka -------------------------------------------------------------
    KAFKA_BROKERS: csv.default(['localhost:9092']),
    KAFKA_CLIENT_ID: z.string().min(1).default('payhub'),
    KAFKA_CONSUMER_GROUP: z.string().min(1).default('payhub-default'),
    KAFKA_SSL: booleanish.default(false),
    KAFKA_SASL_MECHANISM: z.enum(['none', 'plain', 'scram-sha-256', 'scram-sha-512']).default('none'),
    KAFKA_SASL_USERNAME: z.string().optional(),
    KAFKA_SASL_PASSWORD: z.string().optional(),
    KAFKA_TOPIC_PREFIX: z.string().default('payhub'),
    KAFKA_MAX_DELIVERY_ATTEMPTS: positiveInt.default(5),

    // ---- grpc --------------------------------------------------------------
    GRPC_LISTEN_URL: z.string().min(1).default('0.0.0.0:50051'),
    LEDGER_GRPC_URL: z.string().min(1).default('localhost:50051'),
    GRPC_DEADLINE_MS: positiveInt.default(3_000),

    // ---- auth --------------------------------------------------------------
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
    JWT_ACCESS_TTL_SEC: positiveInt.default(900),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
    JWT_REFRESH_TTL_SEC: positiveInt.default(2_592_000),
    JWT_ISSUER: z.string().default('payhub'),
    JWT_AUDIENCE: z.string().default('payhub-api'),
    API_KEY_PEPPER: z.string().min(16, 'API_KEY_PEPPER must be at least 16 chars'),
    ARGON2_MEMORY_COST: positiveInt.default(19_456),
    ARGON2_TIME_COST: positiveInt.default(2),
    ARGON2_PARALLELISM: positiveInt.default(1),

    // ---- rate limiting & idempotency --------------------------------------
    THROTTLE_TTL_MS: positiveInt.default(60_000),
    THROTTLE_LIMIT: positiveInt.default(120),
    IDEMPOTENCY_TTL_SEC: positiveInt.default(86_400),
    IDEMPOTENCY_LOCK_TTL_MS: positiveInt.default(30_000),

    // ---- outbox, webhooks, reconciliation ---------------------------------
    OUTBOX_POLL_INTERVAL_MS: positiveInt.default(500),
    OUTBOX_BATCH_SIZE: positiveInt.default(200),
    WEBHOOK_MAX_ATTEMPTS: positiveInt.default(8),
    WEBHOOK_TIMEOUT_MS: positiveInt.default(5_000),
    WEBHOOK_CONCURRENCY: positiveInt.default(10),
    RECONCILIATION_CRON: z.string().default('*/5 * * * *'),
    DISTRIBUTED_LOCK_TTL_MS: positiveInt.default(30_000),

    // ---- llm ---------------------------------------------------------------
    LLM_ENABLED: booleanish.default(false),
    ANTHROPIC_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().default('claude-sonnet-5'),
    LLM_MAX_OUTPUT_TOKENS: positiveInt.default(1_024),
    LLM_REQUEST_TIMEOUT_MS: positiveInt.default(60_000),
    LLM_USER_RPM: positiveInt.default(10),
    LLM_USER_DAILY_TOKEN_BUDGET: positiveInt.default(100_000),
    LLM_CACHE_TTL_SEC: positiveInt.default(300),
    LLM_MAX_RETRIES: nonNegativeInt.default(3),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_ENABLED && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'ANTHROPIC_API_KEY is required when LLM_ENABLED=true',
      });
    }
    if (env.KAFKA_SASL_MECHANISM !== 'none' && !(env.KAFKA_SASL_USERNAME && env.KAFKA_SASL_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['KAFKA_SASL_USERNAME'],
        message: 'SASL credentials are required when KAFKA_SASL_MECHANISM is set',
      });
    }
    if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'Access and refresh tokens must be signed with different secrets',
      });
    }
    if (env.DATABASE_POOL_MIN > env.DATABASE_POOL_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_POOL_MIN'],
        message: 'DATABASE_POOL_MIN cannot exceed DATABASE_POOL_MAX',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;
