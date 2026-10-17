import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, TopicMessages } from 'kafkajs';
import { MessageHeader } from '@payhub/contracts';
import { KafkaProducerService } from './kafka-producer.service.js';

interface SentBatch {
  topicMessages: TopicMessages[];
}

/** The envelope as it goes on the wire, parsed back out for assertions. */
function envelopeOf(message: Message): Record<string, unknown> {
  return JSON.parse(String(message.value)) as Record<string, unknown>;
}

function build(clsCorrelationId?: string) {
  const sent: SentBatch[] = [];

  const producer = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendBatch: vi.fn(async (batch: SentBatch) => void sent.push(batch)),
  };

  const service = new KafkaProducerService(
    { kafka: { producer: () => producer, admin: () => ({}) } } as never,
    {
      isActive: () => clsCorrelationId !== undefined,
      get: () => clsCorrelationId,
    } as never,
    { serviceName: 'payhub-test', isProduction: false } as never,
  );

  // `onModuleInit` would connect to a broker; the batch builder is what is
  // under test, so the producer is installed directly.
  (service as unknown as { producer: unknown; connected: boolean }).producer = producer;
  (service as unknown as { producer: unknown; connected: boolean }).connected = true;

  const messages = () => sent.flatMap((batch) => batch.topicMessages.flatMap((t) => t.messages));

  return { service, messages };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  topic: 'payhub.payments.events.v1',
  eventType: 'payment.captured.v1',
  aggregateType: 'Payment',
  aggregateId: 'payment-1',
  payload: { amount: '100' },
  ...overrides,
});

describe('KafkaProducerService: correlation', () => {
  let probe: ReturnType<typeof build>;

  beforeEach(() => {
    probe = build();
  });

  /**
   * Regression. The id was read from the ambient CLS context, and the
   * outbox relay — the main caller — is a background poller with no
   * request context, so every published message got a fresh random id.
   * The real one was already in `input.headers`, put there by
   * `OutboxPublisher` when the business transaction committed.
   */
  it('takes the correlation id the outbox stored with the row', async () => {
    await probe.service.publishBatch([
      input({ headers: { [MessageHeader.CorrelationId]: 'from-the-request' } }),
    ]);

    expect(envelopeOf(probe.messages()[0]!)['correlationId']).toBe('from-the-request');
  });

  /**
   * The message already carried the right value one field away from the
   * envelope that contradicted it: the header spread put the stored id on
   * the Kafka header while the envelope kept the generated one — and
   * consumers read the envelope.
   */
  it('puts the same id on the header and in the envelope', async () => {
    await probe.service.publishBatch([
      input({ headers: { [MessageHeader.CorrelationId]: 'from-the-request' } }),
    ]);

    const [message] = probe.messages();
    const headers = message!.headers as Record<string, string>;

    expect(headers[MessageHeader.CorrelationId]).toBe('from-the-request');
    expect(envelopeOf(message!)['correlationId']).toBe(headers[MessageHeader.CorrelationId]);
  });

  /**
   * One id was computed for the whole batch. A relay batch holds rows
   * written by many different requests, so a single id could not have
   * been right even with a working context.
   */
  it('keeps each message on its own correlation id', async () => {
    await probe.service.publishBatch([
      input({ aggregateId: 'a', headers: { [MessageHeader.CorrelationId]: 'request-a' } }),
      input({ aggregateId: 'b', headers: { [MessageHeader.CorrelationId]: 'request-b' } }),
    ]);

    expect(probe.messages().map((message) => envelopeOf(message)['correlationId'])).toEqual([
      'request-a',
      'request-b',
    ]);
  });

  it('falls back to the ambient context when the row carried nothing', async () => {
    const contextual = build('from-cls');

    await contextual.service.publishBatch([input()]);

    expect(envelopeOf(contextual.messages()[0]!)['correlationId']).toBe('from-cls');
  });

  /** An empty stored header is absent, not an empty correlation id. */
  it('ignores a blank stored header', async () => {
    const contextual = build('from-cls');

    await contextual.service.publishBatch([
      input({ headers: { [MessageHeader.CorrelationId]: '' } }),
    ]);

    expect(envelopeOf(contextual.messages()[0]!)['correlationId']).toBe('from-cls');
  });

  it('still produces an id when there is neither', async () => {
    await probe.service.publishBatch([input()]);

    expect(envelopeOf(probe.messages()[0]!)['correlationId']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keys the message by the aggregate, so one payment stays ordered', async () => {
    await probe.service.publishBatch([input({ aggregateId: 'payment-7' })]);

    expect(probe.messages()[0]!.key).toBe('payment-7');
  });
});
