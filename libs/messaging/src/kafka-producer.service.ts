import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Message, Producer } from 'kafkajs';
import { ClsService } from 'nestjs-cls';
import { type AppConfig, appConfig } from '@payhub/config';
import { DependencyFailureError } from '@payhub/kernel';
import {
  type IntegrationEventEnvelope,
  MessageHeader,
  Topics,
} from '@payhub/contracts';
import type { PayHubClsStore } from '@payhub/shared';
import { KafkaClientProvider } from './kafka.client.js';

export interface PublishInput<TPayload = unknown> {
  readonly topic: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: TPayload;
  readonly messageId?: string;
  readonly partitionKey?: string;
  readonly headers?: Record<string, string>;
  readonly occurredAt?: Date;
  readonly tenantId?: string | null;
  readonly causationId?: string | null;
}

/**
 * Kafka producer.
 *
 * `idempotent: true` turns on the broker-side producer id + sequence number,
 * which removes duplicates caused by *internal* retries (the broker persisted
 * the batch but the ack was lost). It does **not** make the whole pipeline
 * exactly-once: the relay can still crash after a successful send and before
 * the outbox row is marked published, so consumers must stay idempotent.
 * That combination — idempotent producer + deduplicating consumer — is what
 * "effectively once" means in practice.
 */
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaProducerService.name);
  private producer!: Producer;
  private connected = false;

  constructor(
    private readonly client: KafkaClientProvider,
    private readonly cls: ClsService<PayHubClsStore>,
    @Inject(appConfig.KEY) private readonly app: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    this.producer = this.client.kafka.producer({
      idempotent: true,
      // Required for idempotence: >5 in-flight batches cannot be deduplicated.
      maxInFlightRequests: 5,
      allowAutoTopicCreation: !this.app.isProduction,
      createPartitioner: this.client.partitioner,
      transactionTimeout: 30_000,
    });

    await this.producer.connect();
    this.connected = true;

    // Auto-creation is off in production (and should be), so the topics this
    // service publishes to are declared explicitly at boot. Doing it here
    // rather than in a migration keeps the topic list next to the contract
    // that defines it.
    await this.ensureTopics(Object.values(Topics));

    this.logger.log('Kafka producer connected');
  }

  private async ensureTopics(topics: readonly string[]): Promise<void> {
    const admin = this.client.kafka.admin();

    try {
      await admin.connect();
      const existing = new Set(await admin.listTopics());
      const missing = topics.filter((topic) => !existing.has(topic));

      if (missing.length > 0) {
        await admin.createTopics({
          waitForLeaders: true,
          topics: missing.map((topic) => ({
            topic,
            numPartitions: 3,
            replicationFactor: 1,
          })),
        });
        this.logger.log(`Created ${missing.length} topic(s): ${missing.join(', ')}`);
      }
    } finally {
      await admin.disconnect();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.connected) {
      await this.producer.disconnect();
      this.connected = false;
    }
  }

  async publish<TPayload>(input: PublishInput<TPayload>): Promise<string> {
    const [messageId] = await this.publishBatch([input]);
    return messageId!;
  }

  /**
   * Batched send. Messages for the same topic are grouped so kafkajs issues
   * one produce request per topic instead of one per message — the single
   * biggest throughput lever for the outbox relay.
   */
  async publishBatch(inputs: readonly PublishInput[]): Promise<string[]> {
    if (inputs.length === 0) {
      return [];
    }

    const ids: string[] = [];
    const byTopic = new Map<string, Message[]>();

    for (const input of inputs) {
      const messageId = input.messageId ?? randomUUID();
      ids.push(messageId);

      /**
       * Per message, and the stored header wins.
       *
       * This was computed once for the whole batch, from the ambient CLS
       * context. Both halves were wrong for the outbox relay, which is
       * the main caller: it is a background poller, so there is no
       * request context and every message got a fresh random id — and a
       * batch holds rows from many different requests, so one id for all
       * of them could not be right even in principle.
       *
       * Meanwhile the id was sitting in `input.headers`, where
       * `OutboxPublisher` had carefully stored it at the moment the
       * business transaction committed. The spread below even put it on
       * the Kafka header, so the message already carried the correct
       * value one field away from the envelope that contradicted it —
       * and consumers read the envelope.
       */
      const correlationId =
        headerValue(input.headers, MessageHeader.CorrelationId) ??
        (this.cls.isActive() ? this.cls.get('correlationId') : undefined) ??
        randomUUID();

      const envelope: IntegrationEventEnvelope = {
        id: messageId,
        type: input.eventType,
        specVersion: '1.0',
        source: this.app.serviceName,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        occurredAt: (input.occurredAt ?? new Date()).toISOString(),
        correlationId,
        causationId: input.causationId ?? null,
        tenantId: input.tenantId ?? null,
        payload: input.payload,
      };

      const messages = byTopic.get(input.topic) ?? [];
      messages.push({
        // The partition key decides ordering. Keying by aggregate id is what
        // guarantees that two events about the same payment are never
        // reordered, while still spreading load across partitions.
        key: input.partitionKey ?? input.aggregateId,
        value: JSON.stringify(envelope),
        headers: {
          [MessageHeader.EventType]: input.eventType,
          [MessageHeader.EventId]: messageId,
          [MessageHeader.Source]: envelope.source,
          [MessageHeader.ContentType]: 'application/json',
          ...(input.causationId ? { [MessageHeader.CausationId]: input.causationId } : {}),
          ...input.headers,
          // Last, so the header and the envelope cannot disagree. They
          // did: the spread above overwrote the header with the stored
          // value while the envelope kept the generated one.
          [MessageHeader.CorrelationId]: envelope.correlationId,
        },
        timestamp: String(envelope.occurredAt ? Date.parse(envelope.occurredAt) : Date.now()),
      });
      byTopic.set(input.topic, messages);
    }

    try {
      await this.producer.sendBatch({
        // acks = -1: every in-sync replica must persist the record. Anything
        // weaker can silently lose an accepted payment on a leader failover.
        acks: -1,
        timeout: 30_000,
        compression: 1, // GZIP
        topicMessages: [...byTopic.entries()].map(([topic, messages]) => ({ topic, messages })),
      });
    } catch (error) {
      throw new DependencyFailureError('kafka', 'Failed to publish to Kafka', {
        cause: error,
        retryable: true,
      });
    }

    return ids;
  }

  /** Raw send used by the retry/DLQ router, which forwards an existing envelope. */
  async forward(topic: string, message: Message): Promise<void> {
    await this.producer.send({ topic, acks: -1, messages: [message] });
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

/** Reads one header out of an outbox row's stored map, if it is usable. */
function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  const value = headers?.[name];
  return value !== undefined && value !== '' ? value : undefined;
}
