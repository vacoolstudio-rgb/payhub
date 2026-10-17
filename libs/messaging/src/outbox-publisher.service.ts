import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { ZodType } from 'zod';
import type { EventDefinition } from '@payhub/contracts';
import { OutboxRepository } from '@payhub/persistence';
import type { PayHubClsStore } from '@payhub/shared';
import type { z } from 'zod';

export interface OutboxPublishOptions {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly partitionKey?: string;
  readonly messageId?: string;
  readonly causationId?: string;
}

/**
 * Application-facing port for emitting integration events.
 *
 * Callers never touch the Kafka producer directly: they append to the outbox
 * inside the business transaction. Either the state change and the event both
 * exist, or neither does. "Save the row, then publish" is the bug this
 * removes — a crash between the two leaves the rest of the platform
 * permanently out of sync, and no amount of retrying fixes it after the fact.
 */
@Injectable()
export class OutboxPublisher {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly cls: ClsService<PayHubClsStore>,
  ) {}

  /**
   * Type-safe publish: the payload is checked against the contract's schema
   * at compile time *and* parsed at runtime, so a producer can never emit a
   * message its own consumers would reject.
   */
  async publish<TName extends string, TSchema extends ZodType>(
    definition: EventDefinition<TName, TSchema>,
    payload: z.input<TSchema>,
    options: OutboxPublishOptions,
  ): Promise<string> {
    const validated = definition.schema.parse(payload) as Record<string, unknown>;

    return this.outbox.append({
      topic: definition.topic,
      eventType: definition.name,
      aggregateType: options.aggregateType,
      aggregateId: options.aggregateId,
      partitionKey: options.partitionKey ?? options.aggregateId,
      payload: validated,
      headers: {
        'x-correlation-id': (this.cls.isActive() ? this.cls.get('correlationId') : undefined) ?? '',
        ...(options.causationId ? { 'x-causation-id': options.causationId } : {}),
      },
      ...(options.messageId ? { messageId: options.messageId } : {}),
    });
  }
}
