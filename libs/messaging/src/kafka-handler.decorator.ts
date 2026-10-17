import { SetMetadata } from '@nestjs/common';
import type { ZodType } from 'zod';
import type { EventDefinition } from '@payhub/contracts';

export const KAFKA_HANDLER_METADATA = 'payhub:kafka-handler';

export interface KafkaHandlerOptions {
  /** Skip the inbox table — only for genuinely side-effect-free handlers. */
  readonly skipDeduplication?: boolean;
  /** Override the platform-wide delivery attempt ceiling. */
  readonly maxAttempts?: number;
}

export interface KafkaHandlerMetadata extends KafkaHandlerOptions {
  readonly topic: string;
  readonly eventType: string;
  readonly schema: ZodType;
}

/**
 * Declares a method as the handler for one integration message.
 *
 * ```ts
 * @KafkaHandler(PostTransferCommand)
 * async onPostTransfer(payload: PayloadOf<typeof PostTransferCommand>) { … }
 * ```
 *
 * The decorator carries the contract's Zod schema, so the consumer validates
 * the payload before the handler is reached: an anti-corruption layer that
 * rejects a malformed or renamed field at the boundary instead of letting it
 * reach the domain.
 */
export const KafkaHandler = <TName extends string, TSchema extends ZodType>(
  definition: EventDefinition<TName, TSchema>,
  options: KafkaHandlerOptions = {},
) =>
  SetMetadata(KAFKA_HANDLER_METADATA, {
    topic: definition.topic,
    eventType: definition.name,
    schema: definition.schema,
    ...options,
  } satisfies KafkaHandlerMetadata);
