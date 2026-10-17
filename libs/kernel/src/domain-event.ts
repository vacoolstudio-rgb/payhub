import { randomUUID } from 'node:crypto';

/**
 * Something that happened inside the domain, in the past tense.
 *
 * Domain events are recorded on the aggregate and dispatched by the
 * application layer *after* the transaction commits (or, for events that must
 * reach other services, written to the outbox inside the same transaction).
 */
export abstract class DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly eventId: string = randomUUID();
  readonly occurredAt: Date = new Date();

  /** Stable, versioned name: `payment.captured.v1`. Never rename — add a new version. */
  abstract readonly eventName: string;
  /** Id of the aggregate that emitted the event; also the partition key on Kafka. */
  abstract readonly aggregateId: string;
  abstract readonly aggregateType: string;

  abstract payload(): TPayload;

  toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventName: this.eventName,
      aggregateId: this.aggregateId,
      aggregateType: this.aggregateType,
      occurredAt: this.occurredAt.toISOString(),
      payload: this.payload(),
    };
  }
}

export type DomainEventClass<T extends DomainEvent = DomainEvent> = new (
  ...args: never[]
) => T;
