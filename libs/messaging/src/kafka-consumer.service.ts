import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { Consumer, EachMessagePayload, KafkaMessage } from 'kafkajs';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { type KafkaConfig, kafkaConfig } from '@payhub/config';
import {
  MessageHeader,
  RETRY_DELAYS_MS,
  deadLetterTopic,
  integrationEventEnvelopeSchema,
  retryTopic,
} from '@payhub/contracts';
import { DependencyFailureError, DomainError } from '@payhub/kernel';
import { InboxRepository, TransactionManager } from '@payhub/persistence';
import { MetricsService } from '@payhub/observability';
import type { PayHubClsStore } from '@payhub/shared';
import { KafkaClientProvider } from './kafka.client.js';
import { KafkaProducerService } from './kafka-producer.service.js';
import {
  KAFKA_HANDLER_METADATA,
  type KafkaHandlerMetadata,
} from './kafka-handler.decorator.js';

interface TopicSpec {
  readonly topic: string;
  readonly retentionMs: number;
}

const PARTITIONS = 3;
const RETRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DLQ_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

interface RegisteredHandler extends KafkaHandlerMetadata {
  readonly invoke: (payload: unknown, context: MessageContext) => Promise<unknown>;
}

export interface MessageContext {
  readonly messageId: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly attempt: number;
  readonly topic: string;
  readonly partition: number;
}

/**
 * Consumer runtime: discovery, validation, deduplication, retries, DLQ.
 *
 * Delivery semantics are **at-least-once**. Kafka's "exactly once" only
 * covers read-process-write *inside* Kafka; the moment a handler touches
 * Postgres or an HTTP endpoint the guarantee is gone. Instead the handler and
 * its inbox row commit in one database transaction, which makes reprocessing
 * a no-op — effectively-once without transactional magic.
 */
@Injectable()
export class KafkaConsumerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private readonly handlers = new Map<string, RegisteredHandler>();
  private consumer?: Consumer;
  private running = false;

  constructor(
    private readonly client: KafkaClientProvider,
    private readonly producer: KafkaProducerService,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly inbox: InboxRepository,
    private readonly transactions: TransactionManager,
    private readonly metrics: MetricsService,
    private readonly cls: ClsService<PayHubClsStore>,
    @Inject(kafkaConfig.KEY) private readonly config: KafkaConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.discoverHandlers();

    if (this.handlers.size === 0) {
      this.logger.log('No @KafkaHandler methods found — consumer not started');
      return;
    }

    this.consumer = this.client.kafka.consumer({
      groupId: this.config.consumerGroup,
      // A short session timeout detects a dead pod quickly; a long rebalance
      // timeout gives healthy pods time to finish in-flight work before the
      // partitions move. Getting these backwards causes rebalance storms.
      sessionTimeout: 30_000,
      rebalanceTimeout: 60_000,
      heartbeatInterval: 3_000,
      maxBytesPerPartition: 1_048_576,
      retry: { retries: 5, initialRetryTime: 300 },
    });

    await this.consumer.connect();
    this.reportLag();

    const plan = this.topicPlan();

    // Create the topics before subscribing. Relying on auto-creation means
    // the first `subscribe` races the broker and fails with
    // UNKNOWN_TOPIC_OR_PARTITION, and auto-creation is disabled in every
    // serious cluster anyway — so the retry and dead-letter topics would
    // simply never exist. Declaring them explicitly also lets us control
    // partition count and retention per role.
    await this.ensureTopics(plan.provision);

    for (const topic of plan.subscribe) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    this.logger.log(
      `Subscribed to ${plan.subscribe.length} topic(s); ` +
        `dead letters go to ${plan.deadLetters.join(', ')}`,
    );

    await this.consumer.run({
      // Keep ordering per partition but process partitions in parallel.
      partitionsConsumedConcurrently: 3,
      eachMessage: (payload) => this.handleMessage(payload),
    });

    this.running = true;
  }

  /**
   * Publishes consumer lag, which is the first number anyone asks for.
   *
   * The gauge existed and nothing ever wrote to it, so the panel read
   * zero whether the ledger was keeping up or an hour behind — and a
   * consumer falling behind is how payments quietly stop settling while
   * every service still reports healthy.
   *
   * Taken from `END_BATCH_PROCESS` rather than polled from the broker:
   * kafkajs already knows the distance between the batch it just
   * finished and the partition's high watermark, so this costs nothing
   * and cannot itself fall behind.
   */
  private reportLag(): void {
    const consumer = this.consumer;
    if (!consumer) {
      return;
    }

    consumer.on(consumer.events.END_BATCH_PROCESS, ({ payload }) => {
      this.observe(() =>
        this.metrics.kafkaConsumerLag.set(
          {
            topic: payload.topic,
            partition: String(payload.partition),
            group: this.config.consumerGroup,
          },
          Number(payload.offsetLag ?? 0),
        ),
      );
    });

    // A revoked partition's last reading would otherwise sit there
    // forever, reporting lag on a partition this pod no longer owns.
    consumer.on(consumer.events.GROUP_JOIN, () => {
      this.observe(() => this.metrics.kafkaConsumerLag.reset());
    });
  }

  /**
   * Runs an instrumentation write that must never matter.
   *
   * These listeners execute inside kafkajs's runner, and a throw from one
   * crashes the consumer: the group rebalances, the pod stops consuming,
   * and payments stop being processed. Trading a gauge for the data path
   * is never the right trade, so the write is contained and the failure
   * is logged once rather than propagated.
   */
  private observe(write: () => void): void {
    try {
      write();
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Failed to record consumer lag; message processing is unaffected',
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.consumer && this.running) {
      this.logger.log('Stopping Kafka consumer (committing in-flight offsets)');
      await this.consumer.stop();
      await this.consumer.disconnect();
      this.running = false;
    }
  }

  // --- discovery ----------------------------------------------------------

  private discoverHandlers(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== 'object') {
        continue;
      }

      const prototype = Object.getPrototypeOf(instance) as object;

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const metadata = this.reflector.get<KafkaHandlerMetadata | undefined>(
          KAFKA_HANDLER_METADATA,
          (instance as Record<string, () => unknown>)[methodName]!,
        );

        if (!metadata) {
          continue;
        }

        if (this.handlers.has(metadata.eventType)) {
          throw new Error(`Duplicate @KafkaHandler for "${metadata.eventType}"`);
        }

        this.handlers.set(metadata.eventType, {
          ...metadata,
          invoke: (payload, context) =>
            (
              (instance as Record<string, (p: unknown, c: MessageContext) => Promise<unknown>>)[
                methodName
              ]
            )!.call(instance, payload, context),
        });

        this.logger.log(`Registered handler ${wrapper.name}.${methodName} → ${metadata.eventType}`);
      }
    }
  }

  /**
   * Idempotent topic provisioning, with retention chosen per role.
   *
   * Failing to create a topic aborts startup on purpose. A service that
   * boots without its dead-letter topic looks healthy and quietly loses
   * every poison message — far worse than refusing to start with a message
   * naming exactly what is missing.
   */
  private async ensureTopics(topics: ReadonlyArray<TopicSpec>): Promise<void> {
    const admin = this.client.kafka.admin();

    try {
      await admin.connect();
      const existing = new Set(await admin.listTopics());
      const missing = topics.filter((spec) => !existing.has(spec.topic));

      if (missing.length === 0) {
        return;
      }

      await admin.createTopics({
        // Wait for leader election: subscribing to a topic whose partitions
        // have no leader yet fails exactly the same way as a missing topic.
        waitForLeaders: true,
        topics: missing.map((spec) => ({
          topic: spec.topic,
          numPartitions: PARTITIONS,
          // See the note in KafkaProducerService: with one replica
          // `acks: all` is `acks: 1`, so durability is this number.
          replicationFactor: this.config.replicationFactor,
          configEntries: [
            { name: 'retention.ms', value: String(spec.retentionMs) },
            ...(this.config.minInsyncReplicas > 1
              ? [{ name: 'min.insync.replicas', value: String(this.config.minInsyncReplicas) }]
              : []),
          ],
        })),
      });

      this.logger.log(
        `Created ${missing.length} Kafka topic(s): ${missing.map((spec) => spec.topic).join(', ')}`,
      );
    } catch (error) {
      this.logger.error(
        `Topic provisioning failed for [${topics.map((spec) => spec.topic).join(', ')}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    } finally {
      await admin.disconnect();
    }
  }

  /**
   * What to create versus what to consume.
   *
   * The dead-letter topic must exist — otherwise `toDeadLetter` fails and,
   * because that call is on the path that handles a poison message, the
   * poison message is redelivered forever — but it must **not** be
   * subscribed to: a dead letter is terminal, and consuming it here would
   * simply replay the failure.
   */
  private topicPlan(): {
    subscribe: string[];
    deadLetters: string[];
    provision: TopicSpec[];
  } {
    const group = this.config.consumerGroup;
    const main = [...new Set([...this.handlers.values()].map((handler) => handler.topic))];

    // One topic per retry level keeps a slow-retrying message from blocking
    // the head of the main partition.
    const retries = main.flatMap((topic) =>
      RETRY_DELAYS_MS.map((_, index) => retryTopic(topic, group, index + 1)),
    );
    const deadLetters = main.map((topic) => deadLetterTopic(topic, group));

    return {
      subscribe: [...main, ...retries],
      deadLetters,
      provision: [
        ...[...main, ...retries].map((topic) => ({ topic, retentionMs: RETRY_RETENTION_MS })),
        // Dead letters are kept far longer: somebody has to look at them,
        // and the person who can is rarely on call the same week.
        ...deadLetters.map((topic) => ({ topic, retentionMs: DLQ_RETENTION_MS })),
      ],
    };
  }

  // --- processing ---------------------------------------------------------

  private async handleMessage({ topic, partition, message }: EachMessagePayload): Promise<void> {
    const attempt = Number(header(message, MessageHeader.Attempt) ?? '0');

    // Retry topics carry their own delay. Rather than sleeping (which blocks
    // the partition and risks a rebalance), pause the partition, seek back to
    // this offset and resume once the delay has elapsed.
    const waitMs = this.remainingDelay(topic, message, attempt);
    if (waitMs > 0) {
      this.deferPartition(topic, partition, message.offset, waitMs);
      return;
    }

    const parsed = this.parseEnvelope(message);
    if (!parsed) {
      await this.toDeadLetter(topic, message, 'envelope_unparseable');
      return;
    }

    const handler = this.handlers.get(parsed.type);
    if (!handler) {
      // Another service owns this event type. Committing the offset is the
      // correct behaviour: this consumer group has nothing to do with it.
      return;
    }

    const validation = handler.schema.safeParse(parsed.payload);
    if (!validation.success) {
      this.logger.error(
        `Schema violation on ${parsed.type} (${parsed.id}): ${validation.error.message}`,
      );
      // A malformed payload will never become valid — retrying is pure waste.
      await this.toDeadLetter(topic, message, 'schema_violation');
      this.metrics.messagesProcessed.inc({ topic, event_type: parsed.type, outcome: 'invalid' });
      return;
    }

    const context: MessageContext = {
      messageId: parsed.id,
      correlationId: parsed.correlationId,
      eventType: parsed.type,
      aggregateId: parsed.aggregateId,
      attempt,
      topic,
      partition,
    };

    await this.cls.run(async () => {
      this.cls.set('correlationId', parsed.correlationId);
      this.cls.set('requestId', randomUUID());
      this.cls.set('startedAt', Date.now());

      try {
        await this.runHandler(handler, validation.data, context);
        this.metrics.messagesProcessed.inc({
          topic,
          event_type: parsed.type,
          outcome: 'processed',
        });
      } catch (error) {
        await this.onHandlerFailure(error, { topic, message, context, handler });
      }
    });
  }

  /**
   * Handler + inbox row commit together. If the handler succeeds but the
   * process dies before the commit, the whole thing rolls back and the
   * message is simply redelivered.
   */
  private async runHandler(
    handler: RegisteredHandler,
    payload: unknown,
    context: MessageContext,
  ): Promise<void> {
    if (handler.skipDeduplication) {
      await handler.invoke(payload, context);
      return;
    }

    await this.transactions.run(async () => {
      const claimed = await this.inbox.tryClaim({
        messageId: context.messageId,
        consumerGroup: this.config.consumerGroup,
        eventType: context.eventType,
      });

      if (!claimed) {
        this.logger.debug(`Duplicate ${context.eventType} ${context.messageId} — skipped`);
        return;
      }

      await handler.invoke(payload, context);
    });
  }

  private async onHandlerFailure(
    error: unknown,
    input: {
      topic: string;
      message: KafkaMessage;
      context: MessageContext;
      handler: RegisteredHandler;
    },
  ): Promise<void> {
    const { topic, message, context, handler } = input;
    const retryable = isRetryable(error);
    const maxAttempts = handler.maxAttempts ?? this.config.maxDeliveryAttempts;
    const nextAttempt = context.attempt + 1;

    this.metrics.messagesProcessed.inc({
      topic,
      event_type: context.eventType,
      outcome: retryable ? 'retry' : 'failed',
    });

    const reason = error instanceof Error ? error.message : String(error);

    if (!retryable || nextAttempt > Math.min(maxAttempts, RETRY_DELAYS_MS.length)) {
      this.logger.error(
        `Dead-lettering ${context.eventType} ${context.messageId} after ${context.attempt} attempt(s): ${reason}`,
      );
      await this.toDeadLetter(topic, message, reason);
      return;
    }

    this.logger.warn(
      `Retrying ${context.eventType} ${context.messageId} (attempt ${nextAttempt}): ${reason}`,
    );

    await this.producer.forward(
      retryTopic(this.baseTopic(topic), this.config.consumerGroup, nextAttempt),
      withHeaders(message, {
        [MessageHeader.Attempt]: String(nextAttempt),
        [MessageHeader.LastError]: reason.slice(0, 512),
        [MessageHeader.OriginalTopic]: this.baseTopic(topic),
        [MessageHeader.FirstFailureAt]:
          header(message, MessageHeader.FirstFailureAt) ?? new Date().toISOString(),
      }),
    );
  }

  private async toDeadLetter(
    topic: string,
    message: KafkaMessage,
    reason: string,
  ): Promise<void> {
    await this.producer.forward(
      deadLetterTopic(this.baseTopic(topic), this.config.consumerGroup),
      withHeaders(message, {
        [MessageHeader.LastError]: reason.slice(0, 512),
        // The *base* topic, not `topic`: a message dead-lettered out of
        // `…retry.3` must be replayable, and replaying it onto the retry
        // topic would re-enter the ladder halfway with a stale attempt
        // count instead of starting over.
        [MessageHeader.OriginalTopic]: this.baseTopic(topic),
      }),
    );
  }

  // --- helpers ------------------------------------------------------------

  private parseEnvelope(message: KafkaMessage): {
    id: string;
    type: string;
    correlationId: string;
    aggregateId: string;
    payload: unknown;
  } | null {
    if (!message.value) {
      return null;
    }
    try {
      const envelope = integrationEventEnvelopeSchema.parse(
        JSON.parse(message.value.toString('utf8')),
      );
      return {
        id: envelope.id,
        type: envelope.type,
        correlationId: envelope.correlationId,
        aggregateId: envelope.aggregateId,
        payload: envelope.payload,
      };
    } catch (error) {
      this.logger.error(
        `Unparseable message: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private remainingDelay(topic: string, message: KafkaMessage, attempt: number): number {
    if (!topic.includes('.retry.') || attempt < 1) {
      return 0;
    }
    const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!;
    const producedAt = Number(message.timestamp);
    return Math.max(0, producedAt + delay - Date.now());
  }

  private deferPartition(topic: string, partition: number, offset: string, waitMs: number): void {
    this.consumer?.pause([{ topic, partitions: [partition] }]);
    this.consumer?.seek({ topic, partition, offset });

    const timer = setTimeout(() => {
      this.consumer?.resume([{ topic, partitions: [partition] }]);
    }, waitMs);
    timer.unref();
  }

  /** `topic.group.retry.2` → `topic` */
  private baseTopic(topic: string): string {
    const marker = `.${this.config.consumerGroup}.retry.`;
    const index = topic.indexOf(marker);
    return index === -1 ? topic : topic.slice(0, index);
  }
}

function header(message: KafkaMessage, name: string): string | undefined {
  const raw = message.headers?.[name];
  return raw === undefined ? undefined : raw.toString();
}

function withHeaders(message: KafkaMessage, extra: Record<string, string>) {
  return {
    key: message.key,
    value: message.value,
    headers: {
      ...Object.fromEntries(
        Object.entries(message.headers ?? {}).map(([key, value]) => [key, value?.toString() ?? '']),
      ),
      ...extra,
    },
  };
}

/**
 * Retry only what can plausibly succeed later.
 *
 * A validation or business-rule failure is deterministic: replaying it five
 * times just moves the same error five times. Infrastructure failures are
 * worth retrying.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof DependencyFailureError) {
    return error.retryable;
  }
  if (error instanceof DomainError) {
    return error.kind === 'unavailable' || error.kind === 'conflict';
  }
  return true;
}
