import { z } from 'zod';

/**
 * Transport-agnostic integration event envelope.
 *
 * Every message crossing a service boundary carries the same metadata so that
 * consumers can deduplicate (`id`), trace (`correlationId` / `causationId`),
 * evolve (`type` is versioned) and route (`source`, `aggregateId`).
 */
export const integrationEventEnvelopeSchema = z.object({
  /** Globally unique message id — the deduplication key for consumers. */
  id: z.string().uuid(),
  /** Versioned event name, e.g. `payment.captured.v1`. Never mutate in place. */
  type: z.string().min(1),
  /** Schema version of the envelope itself, not of the payload. */
  specVersion: z.literal('1.0'),
  source: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  occurredAt: z.string().datetime({ offset: true }),
  /** Request-scoped id propagated from the HTTP edge through every hop. */
  correlationId: z.string().min(1),
  /** Id of the message that caused this one — builds the causal chain. */
  causationId: z.string().min(1).nullable().default(null),
  /** Tenant/merchant scoping, when applicable. */
  tenantId: z.string().min(1).nullable().default(null),
  payload: z.unknown(),
});

export type IntegrationEventEnvelope<TPayload = unknown> = Omit<
  z.infer<typeof integrationEventEnvelopeSchema>,
  'payload'
> & { payload: TPayload };

export const moneySchema = z.object({
  /** Minor units as a decimal string — JSON has no 64-bit integers. */
  amount: z.string().regex(/^-?\d+$/),
  currency: z.string().min(3).max(4),
});

export type MoneyDto = z.infer<typeof moneySchema>;

/** Kafka message headers used across the platform. */
export const MessageHeader = {
  EventType: 'x-event-type',
  EventId: 'x-event-id',
  CorrelationId: 'x-correlation-id',
  CausationId: 'x-causation-id',
  Source: 'x-source',
  Attempt: 'x-attempt',
  FirstFailureAt: 'x-first-failure-at',
  LastError: 'x-last-error',
  OriginalTopic: 'x-original-topic',
  ContentType: 'content-type',
} as const;

/**
 * Builds the typed description of one event: its name and its payload schema.
 * Producers and consumers both import this object, which makes a breaking
 * change to the wire format a compile error on both sides.
 */
export interface EventDefinition<TName extends string, TSchema extends z.ZodType> {
  readonly name: TName;
  readonly schema: TSchema;
  readonly topic: string;
}

export function defineEvent<TName extends string, TSchema extends z.ZodType>(
  name: TName,
  topic: string,
  schema: TSchema,
): EventDefinition<TName, TSchema> {
  return { name, topic, schema } as const;
}

export type PayloadOf<T> = T extends EventDefinition<string, infer S> ? z.infer<S> : never;
