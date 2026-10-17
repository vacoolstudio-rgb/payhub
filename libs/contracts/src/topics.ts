/**
 * Topic naming: `<prefix>.<context>.<kind>.v<major>`.
 *
 * Each bounded context owns its topics; nobody writes to a topic owned by
 * another context. Retry and dead-letter topics are derived names so that the
 * consumer framework can build them without extra configuration.
 */
export const TOPIC_PREFIX = process.env['KAFKA_TOPIC_PREFIX'] ?? 'payhub';

export const Topics = {
  /** Facts emitted by the payments context. */
  PaymentEvents: `${TOPIC_PREFIX}.payments.events.v1`,
  /** Commands the payment saga sends to the ledger service. */
  LedgerCommands: `${TOPIC_PREFIX}.ledger.commands.v1`,
  /** Facts emitted by the ledger context. */
  LedgerEvents: `${TOPIC_PREFIX}.ledger.events.v1`,
  /** Facts emitted by the identity context. */
  IdentityEvents: `${TOPIC_PREFIX}.identity.events.v1`,
} as const;

export type Topic = (typeof Topics)[keyof typeof Topics];

/** `payhub.payments.events.v1` → `payhub.payments.events.v1.notifications.retry.3` */
export function retryTopic(topic: string, consumerGroup: string, attempt: number): string {
  return `${topic}.${consumerGroup}.retry.${attempt}`;
}

export function deadLetterTopic(topic: string, consumerGroup: string): string {
  return `${topic}.${consumerGroup}.dlq`;
}

/**
 * Exponential backoff ladder for retry topics. Each level is a separate topic
 * so that a slow-retrying message never blocks the head of the main partition.
 */
export const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000] as const;
