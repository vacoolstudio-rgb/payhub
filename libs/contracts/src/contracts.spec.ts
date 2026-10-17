import { describe, expect, it } from 'vitest';
import {
  MessageRegistry,
  PaymentCaptured,
  PostTransferCommand,
  RETRY_DELAYS_MS,
  TransferRejected,
  Topics,
  deadLetterTopic,
  integrationEventEnvelopeSchema,
  retryTopic,
} from './index.js';

const validEnvelope = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'payment.captured.v1',
  specVersion: '1.0',
  source: 'payhub-api',
  aggregateType: 'Payment',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  occurredAt: '2026-01-01T00:00:00.000Z',
  correlationId: 'corr-1',
  causationId: null,
  tenantId: null,
  payload: {},
};

describe('integration event envelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(integrationEventEnvelopeSchema.parse(validEnvelope).id).toBe(validEnvelope.id);
  });

  it('defaults the optional correlation fields', () => {
    const { causationId: _c, tenantId: _t, ...without } = validEnvelope;
    const parsed = integrationEventEnvelopeSchema.parse(without);

    expect(parsed.causationId).toBeNull();
    expect(parsed.tenantId).toBeNull();
  });

  /**
   * The envelope is the anti-corruption layer: a malformed message is
   * rejected at the boundary rather than reaching a handler.
   */
  it('rejects messages missing the fields consumers rely on', () => {
    for (const field of ['id', 'type', 'aggregateId', 'correlationId', 'occurredAt']) {
      const broken = { ...validEnvelope, [field]: undefined };
      expect(integrationEventEnvelopeSchema.safeParse(broken).success).toBe(false);
    }
  });

  it('rejects a non-UUID message id — deduplication depends on it', () => {
    expect(
      integrationEventEnvelopeSchema.safeParse({ ...validEnvelope, id: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('pins the spec version, so a future envelope cannot be silently misread', () => {
    expect(
      integrationEventEnvelopeSchema.safeParse({ ...validEnvelope, specVersion: '2.0' }).success,
    ).toBe(false);
  });
});

describe('event definitions', () => {
  it('names every event with an explicit version', () => {
    for (const definition of Object.values(MessageRegistry)) {
      expect(definition.name).toMatch(/\.v\d+$/);
      expect(definition.topic.startsWith(Topics.PaymentEvents.split('.')[0]!)).toBe(true);
    }
  });

  it('registry keys and definition names agree', () => {
    for (const [key, definition] of Object.entries(MessageRegistry)) {
      expect(key).toBe(definition.name);
    }
  });

  it('validates a payload against the shared schema', () => {
    const payload = {
      paymentId: '11111111-1111-4111-8111-111111111111',
      merchantId: '22222222-2222-4222-8222-222222222222',
      userId: '33333333-3333-4333-8333-333333333333',
      direction: 'deposit',
      amount: { amount: '10000', currency: 'USD' },
      fee: { amount: '320', currency: 'USD' },
      reference: 'order-1',
      transferId: '44444444-4444-4444-8444-444444444444',
      capturedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(PaymentCaptured.schema.safeParse(payload).success).toBe(true);
    // Money crosses the wire as an integer string; a float is a bug.
    expect(
      PaymentCaptured.schema.safeParse({ ...payload, amount: { amount: '100.5', currency: 'USD' } })
        .success,
    ).toBe(false);
  });

  it('requires a semantic ledger command, not a list of postings', () => {
    const command = {
      transferId: '11111111-1111-4111-8111-111111111111',
      paymentId: '22222222-2222-4222-8222-222222222222',
      userId: '33333333-3333-4333-8333-333333333333',
      counterpartyUserId: null,
      merchantId: '44444444-4444-4444-8444-444444444444',
      operation: 'deposit',
      amount: { amount: '10000', currency: 'USD' },
      fee: { amount: '320', currency: 'USD' },
      provider: 'card',
      description: 'deposit',
      requestedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(PostTransferCommand.schema.safeParse(command).success).toBe(true);
    expect(
      PostTransferCommand.schema.safeParse({ ...command, operation: 'teleport' }).success,
    ).toBe(false);
  });

  it('constrains the rejection reasons a consumer must handle', () => {
    const base = {
      transferId: '11111111-1111-4111-8111-111111111111',
      paymentId: '22222222-2222-4222-8222-222222222222',
      userId: '33333333-3333-4333-8333-333333333333',
      rejectedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(TransferRejected.schema.safeParse({ ...base, reason: 'insufficient_funds' }).success).toBe(
      true,
    );
    expect(TransferRejected.schema.safeParse({ ...base, reason: 'because' }).success).toBe(false);
  });
});

describe('topic naming', () => {
  it('derives retry and dead-letter topics per consumer group', () => {
    const base = Topics.PaymentEvents;

    expect(retryTopic(base, 'worker', 2)).toBe(`${base}.worker.retry.2`);
    expect(deadLetterTopic(base, 'worker')).toBe(`${base}.worker.dlq`);
  });

  /** Two groups retry independently; one group's backlog cannot block another. */
  it('keeps groups isolated', () => {
    expect(retryTopic(Topics.PaymentEvents, 'a', 1)).not.toBe(
      retryTopic(Topics.PaymentEvents, 'b', 1),
    );
  });

  it('has one retry level per configured delay, and they increase', () => {
    expect(RETRY_DELAYS_MS.length).toBeGreaterThan(0);

    for (let i = 1; i < RETRY_DELAYS_MS.length; i += 1) {
      expect(RETRY_DELAYS_MS[i]!).toBeGreaterThan(RETRY_DELAYS_MS[i - 1]!);
    }
  });
});
