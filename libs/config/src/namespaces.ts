import { type ConfigType, registerAs } from '@nestjs/config';
import { loadEnv } from './env.js';

/**
 * Configuration namespaces.
 *
 * Consumers inject a strongly typed slice:
 *
 * ```ts
 * constructor(@Inject(databaseConfig.KEY) private readonly db: DatabaseConfig) {}
 * ```
 *
 * No stringly-typed `configService.get('DATABASE_URL')` anywhere in the code
 * base: a renamed variable becomes a compile error instead of `undefined`.
 */

export const appConfig = registerAs('app', () => {
  const env = loadEnv();
  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    serviceName: env.SERVICE_NAME,
    serviceVersion: env.SERVICE_VERSION,
    port: env.PORT,
    globalPrefix: env.HTTP_GLOBAL_PREFIX,
    bodyLimit: env.HTTP_BODY_LIMIT,
    shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
    shutdownDrainDelayMs: env.SHUTDOWN_DRAIN_DELAY_MS,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    corsOrigins: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    trustProxy: env.TRUST_PROXY,
  } as const;
});

export const observabilityConfig = registerAs('observability', () => {
  const env = loadEnv();
  return {
    logLevel: env.LOG_LEVEL,
    logPretty: env.LOG_PRETTY,
    metricsEnabled: env.METRICS_ENABLED,
    otelEnabled: env.OTEL_ENABLED,
    otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  } as const;
});

export const databaseConfig = registerAs('database', () => {
  const env = loadEnv();
  return {
    url: env.DATABASE_URL,
    schema: env.DATABASE_SCHEMA,
    poolMax: env.DATABASE_POOL_MAX,
    poolMin: env.DATABASE_POOL_MIN,
    ssl: env.DATABASE_SSL,
    logging: env.DATABASE_LOGGING,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: env.DATABASE_LOCK_TIMEOUT_MS,
    runMigrations: env.DATABASE_RUN_MIGRATIONS,
  } as const;
});

export const redisConfig = registerAs('redis', () => {
  const env = loadEnv();
  return {
    url: env.REDIS_URL,
    keyPrefix: env.REDIS_KEY_PREFIX,
    maxRetries: env.REDIS_MAX_RETRIES,
  } as const;
});

export const kafkaConfig = registerAs('kafka', () => {
  const env = loadEnv();
  return {
    brokers: env.KAFKA_BROKERS,
    clientId: env.KAFKA_CLIENT_ID,
    consumerGroup: env.KAFKA_CONSUMER_GROUP,
    ssl: env.KAFKA_SSL,
    saslMechanism: env.KAFKA_SASL_MECHANISM,
    saslUsername: env.KAFKA_SASL_USERNAME,
    saslPassword: env.KAFKA_SASL_PASSWORD,
    topicPrefix: env.KAFKA_TOPIC_PREFIX,
    maxDeliveryAttempts: env.KAFKA_MAX_DELIVERY_ATTEMPTS,
    replicationFactor: env.KAFKA_REPLICATION_FACTOR,
    // One short of the replica count: a three-broker cluster stays
    // writable with one broker down, and a write that only one replica
    // holds is still refused.
    minInsyncReplicas:
      env.KAFKA_MIN_INSYNC_REPLICAS ?? Math.max(1, env.KAFKA_REPLICATION_FACTOR - 1),
  } as const;
});

export const grpcConfig = registerAs('grpc', () => {
  const env = loadEnv();
  return {
    listenUrl: env.GRPC_LISTEN_URL,
    ledgerUrl: env.LEDGER_GRPC_URL,
    deadlineMs: env.GRPC_DEADLINE_MS,
  } as const;
});

export const authConfig = registerAs('auth', () => {
  const env = loadEnv();
  return {
    accessSecret: env.JWT_ACCESS_SECRET,
    accessTtlSec: env.JWT_ACCESS_TTL_SEC,
    refreshSecret: env.JWT_REFRESH_SECRET,
    refreshTtlSec: env.JWT_REFRESH_TTL_SEC,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    apiKeyPepper: env.API_KEY_PEPPER,
    argon2: {
      memoryCost: env.ARGON2_MEMORY_COST,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    },
  } as const;
});

export const resilienceConfig = registerAs('resilience', () => {
  const env = loadEnv();
  return {
    throttleTtlMs: env.THROTTLE_TTL_MS,
    throttleLimit: env.THROTTLE_LIMIT,
    idempotencyTtlSec: env.IDEMPOTENCY_TTL_SEC,
    idempotencyLockTtlMs: env.IDEMPOTENCY_LOCK_TTL_MS,
    distributedLockTtlMs: env.DISTRIBUTED_LOCK_TTL_MS,
  } as const;
});

export const workerConfig = registerAs('worker', () => {
  const env = loadEnv();
  return {
    outboxPollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    outboxBatchSize: env.OUTBOX_BATCH_SIZE,
    webhookMaxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    webhookTimeoutMs: env.WEBHOOK_TIMEOUT_MS,
    webhookConcurrency: env.WEBHOOK_CONCURRENCY,
    reconciliationCron: env.RECONCILIATION_CRON,
  } as const;
});

export const llmConfig = registerAs('llm', () => {
  const env = loadEnv();
  return {
    enabled: env.LLM_ENABLED,
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.LLM_MODEL,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    userRpm: env.LLM_USER_RPM,
    userDailyTokenBudget: env.LLM_USER_DAILY_TOKEN_BUDGET,
    cacheTtlSec: env.LLM_CACHE_TTL_SEC,
    maxRetries: env.LLM_MAX_RETRIES,
  } as const;
});

export const allConfigNamespaces = [
  appConfig,
  observabilityConfig,
  databaseConfig,
  redisConfig,
  kafkaConfig,
  grpcConfig,
  authConfig,
  resilienceConfig,
  workerConfig,
  llmConfig,
];

export type AppConfig = ConfigType<typeof appConfig>;
export type ObservabilityConfig = ConfigType<typeof observabilityConfig>;
export type DatabaseConfig = ConfigType<typeof databaseConfig>;
export type RedisConfig = ConfigType<typeof redisConfig>;
export type KafkaConfig = ConfigType<typeof kafkaConfig>;
export type GrpcConfig = ConfigType<typeof grpcConfig>;
export type AuthConfig = ConfigType<typeof authConfig>;
export type ResilienceConfig = ConfigType<typeof resilienceConfig>;
export type WorkerConfig = ConfigType<typeof workerConfig>;
export type LlmConfig = ConfigType<typeof llmConfig>;
