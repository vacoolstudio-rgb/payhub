import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka';
import { AssignerProtocol, Kafka, type Consumer, type Producer } from 'kafkajs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appConfig, kafkaConfig } from '@payhub/config';
import {
  MessageHeader,
  RETRY_DELAYS_MS,
  deadLetterTopic,
  defineEvent,
  retryTopic,
} from '@payhub/contracts';
import { DependencyFailureError, ValidationError } from '@payhub/kernel';
import { InboxRepository, TransactionManager } from '@payhub/persistence';
import { MetricsService } from '@payhub/observability';
import {
  KafkaClientProvider,
  KafkaConsumerService,
  KafkaHandler,
  KafkaProducerService,
  type MessageContext,
} from '@payhub/messaging';

/**
 * The retry ladder and the dead-letter queue, against a real broker.
 *
 * None of this is testable with a fake: the behaviour under test *is* the
 * interaction with Kafka — topics being provisioned before subscribe, a
 * message being re-published onto `…retry.N` with an incremented attempt
 * header, a partition being paused and sought backwards so a delayed retry
 * does not block the partition, and a poison message landing in a DLQ that
 * has to already exist.
 */

const GROUP = 'payhub-test';
const TOPIC = 'payhub.test.events.v1';

const payloadSchema = z.object({ ref: z.string().min(1) });

const AlwaysFails = defineEvent('test.always_fails.v1', TOPIC, payloadSchema);
const Succeeds = defineEvent('test.succeeds.v1', TOPIC, payloadSchema);
const NotRetryable = defineEvent('test.not_retryable.v1', TOPIC, payloadSchema);
const Unhandled = defineEvent('test.unhandled.v1', TOPIC, payloadSchema);

/** Records every delivery so the test can assert on the attempt sequence. */
@Injectable()
class ProbeHandlers {
  readonly seen: Array<{ eventType: string; attempt: number; topic: string }> = [];

  // Two levels is enough to prove the ladder walks, and keeps the test to
  // RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1] of real waiting.
  @KafkaHandler(AlwaysFails, { skipDeduplication: true, maxAttempts: 2 })
  async onAlwaysFails(_payload: unknown, context: MessageContext): Promise<void> {
    this.record(context);
    throw new DependencyFailureError('ledger', 'connection reset', { retryable: true });
  }

  @KafkaHandler(Succeeds, { skipDeduplication: true })
  async onSucceeds(_payload: unknown, context: MessageContext): Promise<void> {
    this.record(context);
  }

  @KafkaHandler(NotRetryable, { skipDeduplication: true })
  async onNotRetryable(_payload: unknown, context: MessageContext): Promise<void> {
    this.record(context);
    throw new ValidationError('amount must be positive');
  }

  private record(context: MessageContext): void {
    this.seen.push({
      eventType: context.eventType,
      attempt: context.attempt,
      topic: context.topic,
    });
  }
}

describe('Kafka retries & dead-letter queue (integration)', () => {
  let container: StartedKafkaContainer;
  let moduleRef: TestingModule;
  let handlers: ProbeHandlers;
  let kafka: Kafka;
  let producer: Producer;
  let dlqConsumer: Consumer;

  const dlq: Array<{ headers: Record<string, string>; value: string }> = [];

  /** Publishes a well-formed envelope, or whatever raw value is given. */
  async function publish(
    type: string,
    payload: unknown,
    options: { raw?: string; topic?: string; headers?: Record<string, string> } = {},
  ): Promise<string> {
    const id = randomUUID();
    const envelope = {
      id,
      type,
      specVersion: '1.0',
      source: 'test',
      aggregateType: 'Probe',
      aggregateId: randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: `corr-${id}`,
      causationId: null,
      tenantId: null,
      payload,
    };

    await producer.send({
      topic: options.topic ?? TOPIC,
      messages: [
        {
          key: envelope.aggregateId,
          value: options.raw ?? JSON.stringify(envelope),
          headers: { [MessageHeader.EventType]: type, ...options.headers },
        },
      ],
    });

    return id;
  }

  /** Polls an assertion instead of sleeping a fixed amount. */
  async function eventually<T>(read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = read();
      if (value !== undefined) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error('condition not met within timeout');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const deadLettered = (eventId: string) =>
    dlq.find((entry) => (JSON.parse(entry.value) as { id: string }).id === eventId);

  beforeAll(async () => {
    // Confluent's image rather than the `apache/kafka` one used in compose:
    // the Testcontainers module drives Confluent's entrypoint scripts. The
    // broker protocol is identical, which is all this suite exercises.
    container = await new KafkaContainer('confluentinc/cp-kafka:7.6.1').withKraft().start();
    const brokers = [`${container.getHost()}:${container.getMappedPort(9093)}`];

    moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule, ClsModule.forRoot({ global: true, middleware: { mount: false } })],
      providers: [
        ProbeHandlers,
        KafkaClientProvider,
        KafkaProducerService,
        KafkaConsumerService,
        {
          provide: kafkaConfig.KEY,
          useValue: {
            brokers,
            clientId: 'payhub-test',
            consumerGroup: GROUP,
            ssl: false,
            saslMechanism: 'none',
            saslUsername: null,
            saslPassword: null,
            topicPrefix: 'payhub',
            maxDeliveryAttempts: 5,
          },
        },
        {
          provide: appConfig.KEY,
          useValue: { serviceName: 'probe', isProduction: false, version: 'test', env: 'test' },
        },
        // The inbox is covered against Postgres in outbox.e2e-spec; every
        // handler here opts out of deduplication, so these are never reached.
        { provide: InboxRepository, useValue: { tryClaim: async () => true } },
        {
          provide: TransactionManager,
          useValue: { run: async (fn: () => Promise<unknown>) => fn() },
        },
        { provide: MetricsService, useValue: { messagesProcessed: { inc: () => undefined } } },
      ],
    }).compile();

    handlers = moduleRef.get(ProbeHandlers);

    // init() triggers onApplicationBootstrap, which provisions the topics.
    await moduleRef.init();

    kafka = new Kafka({ clientId: 'probe-client', brokers });
    producer = kafka.producer();
    await producer.connect();

    // A separate group tails the DLQ, exactly as an operator's tooling would.
    dlqConsumer = kafka.consumer({ groupId: 'dlq-observer' });
    await dlqConsumer.connect();
    await dlqConsumer.subscribe({ topic: deadLetterTopic(TOPIC, GROUP), fromBeginning: true });
    await dlqConsumer.run({
      eachMessage: async ({ message }) => {
        dlq.push({
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)]),
          ),
          value: message.value!.toString('utf8'),
        });
      },
    });
  }, 300_000);

  afterAll(async () => {
    await dlqConsumer?.disconnect();
    await producer?.disconnect();
    await moduleRef?.close();
    await container?.stop();
  });

  beforeEach(() => {
    handlers.seen.length = 0;
  });

  describe('topic provisioning', () => {
    /**
     * Regression: `ensureTopics` created the main and retry topics but not
     * the DLQ. In development the producer's auto-creation hid it; in
     * production auto-creation is off, so the first poison message threw
     * inside the error path and was redelivered forever.
     */
    it('creates the dead-letter topic at startup, before anything fails', async () => {
      const admin = kafka.admin();
      await admin.connect();
      const topics = await admin.listTopics();
      await admin.disconnect();

      expect(topics).toContain(deadLetterTopic(TOPIC, GROUP));
    });

    it('creates one retry topic per configured delay', async () => {
      const admin = kafka.admin();
      await admin.connect();
      const topics = new Set(await admin.listTopics());
      await admin.disconnect();

      for (let level = 1; level <= RETRY_DELAYS_MS.length; level += 1) {
        expect(topics).toContain(retryTopic(TOPIC, GROUP, level));
      }
    });

    /** Consuming your own dead letters just replays the failure. */
    it('does not subscribe to its own dead-letter topic', async () => {
      const admin = kafka.admin();
      await admin.connect();
      const described = await admin.describeGroups([GROUP]);
      await admin.disconnect();

      const assigned = described.groups[0]!.members.flatMap((member) =>
        Object.keys(AssignerProtocol.MemberAssignment.decode(member.memberAssignment)!.assignment),
      );

      expect(assigned).toContain(TOPIC);
      expect(assigned).toContain(retryTopic(TOPIC, GROUP, 1));
      expect(assigned).not.toContain(deadLetterTopic(TOPIC, GROUP));
    });
  });

  describe('happy path', () => {
    it('validates, dispatches and commits', async () => {
      await publish(Succeeds.name, { ref: 'ok-1' });

      const delivery = await eventually(() =>
        handlers.seen.find((entry) => entry.eventType === Succeeds.name),
      );

      expect(delivery).toMatchObject({ attempt: 0, topic: TOPIC });
    });

    /** Another service's event on a shared topic must not be an error. */
    it('skips an event type it has no handler for', async () => {
      const unhandledId = await publish(Unhandled.name, { ref: 'nobody-cares' });
      await publish(Succeeds.name, { ref: 'marker' });

      // The marker proves the consumer moved past the unhandled message
      // rather than stalling on it.
      await eventually(() => handlers.seen.find((entry) => entry.eventType === Succeeds.name));

      expect(handlers.seen.some((entry) => entry.eventType === Unhandled.name)).toBe(false);
      expect(deadLettered(unhandledId)).toBeUndefined();
    });
  });

  describe('straight to the dead-letter queue', () => {
    /** A malformed payload is deterministic — retrying it five times is waste. */
    it('dead-letters a schema violation without a single retry', async () => {
      const id = await publish(Succeeds.name, { wrong: 'shape' });

      const entry = await eventually(() => deadLettered(id));

      expect(entry.headers[MessageHeader.LastError]).toBe('schema_violation');
      expect(entry.headers[MessageHeader.OriginalTopic]).toBe(TOPIC);
      expect(handlers.seen).toHaveLength(0);
    });

    it('dead-letters an envelope it cannot parse', async () => {
      await publish(Succeeds.name, null, { raw: '{"not":"an envelope"}' });

      const entry = await eventually(() =>
        dlq.find((e) => e.headers[MessageHeader.LastError] === 'envelope_unparseable'),
      );

      expect(entry.value).toContain('not');
    });

    /**
     * A business-rule rejection is as deterministic as a bad payload. Only
     * infrastructure failures earn a place on the retry ladder.
     */
    it('dead-letters a non-retryable domain error on the first attempt', async () => {
      const id = await publish(NotRetryable.name, { ref: 'bad-amount' });

      const entry = await eventually(() => deadLettered(id));

      expect(entry.headers[MessageHeader.LastError]).toContain('amount must be positive');
      expect(handlers.seen.filter((e) => e.eventType === NotRetryable.name)).toHaveLength(1);
    });
  });

  describe('the retry ladder', () => {
    /**
     * Walks `retry.1` then `retry.2`, then gives up — `maxAttempts: 2` on
     * the handler overrides the platform ceiling, so the whole ladder costs
     * RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1] of wall clock.
     */
    it('retries a dependency failure through each level, then dead-letters it', async () => {
      const id = await publish(AlwaysFails.name, { ref: 'flaky' });

      const entry = await eventually(() => deadLettered(id), 60_000);
      const attempts = handlers.seen.filter((e) => e.eventType === AlwaysFails.name);

      expect(attempts.map((a) => a.attempt)).toEqual([0, 1, 2]);
      expect(attempts.map((a) => a.topic)).toEqual([
        TOPIC,
        retryTopic(TOPIC, GROUP, 1),
        retryTopic(TOPIC, GROUP, 2),
      ]);

      expect(entry.headers[MessageHeader.Attempt]).toBe('2');
      expect(entry.headers[MessageHeader.LastError]).toContain('connection reset');
      // Replay tooling re-publishes onto this topic; it must be the base
      // topic, never the retry level the message happened to die on.
      expect(entry.headers[MessageHeader.OriginalTopic]).toBe(TOPIC);
      expect(entry.headers[MessageHeader.FirstFailureAt]).toBeDefined();
    }, 120_000);

    /** The delay is honoured rather than being retried as fast as possible. */
    it('waits out the configured delay before re-running the handler', async () => {
      const startedAt = Date.now();
      await publish(AlwaysFails.name, { ref: 'timing' });

      await eventually(
        () =>
          handlers.seen.filter((e) => e.eventType === AlwaysFails.name && e.attempt === 1).length >
          0
            ? true
            : undefined,
        60_000,
      );

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(RETRY_DELAYS_MS[0]!);
    }, 120_000);

    /**
     * Pausing and seeking must not lose the message: a naive implementation
     * returns from `eachMessage`, lets auto-commit advance past the offset
     * and the retry is silently dropped.
     */
    it('does not drop the deferred message while the partition is paused', async () => {
      await publish(AlwaysFails.name, { ref: 'not-lost' });

      const redelivered = await eventually(
        () =>
          handlers.seen.find((e) => e.eventType === AlwaysFails.name && e.attempt === 1) ??
          undefined,
        60_000,
      );

      expect(redelivered.topic).toBe(retryTopic(TOPIC, GROUP, 1));
    }, 120_000);
  });

  describe('dead-letter payload', () => {
    it('preserves the original message so it can be replayed verbatim', async () => {
      const id = await publish(NotRetryable.name, { ref: 'keep-me' });

      const entry = await eventually(() => deadLettered(id));
      const envelope = JSON.parse(entry.value) as { id: string; type: string; payload: unknown };

      expect(envelope).toMatchObject({
        id,
        type: NotRetryable.name,
        payload: { ref: 'keep-me' },
      });
    });
  });
});
