import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { KafkaClientProvider } from './kafka.client.js';
import { KafkaConsumerService } from './kafka-consumer.service.js';
import { KafkaProducerService } from './kafka-producer.service.js';
import { OutboxPublisher } from './outbox-publisher.service.js';
import { OUTBOX_RELAY_ENABLED, OutboxRelayService } from './outbox-relay.service.js';

export interface MessagingModuleOptions {
  /** Start the Kafka consumer loop in this process. */
  readonly consumer?: boolean;
  /** Drain the outbox from this process. */
  readonly relay?: boolean;
}

/**
 * Hand-written dynamic module again, because the shape of the messaging
 * stack differs per service: the API produces but does not consume, the
 * ledger does both, and the worker only relays.
 */
@Global()
@Module({})
export class MessagingModule {
  static forRoot(options: MessagingModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      KafkaClientProvider,
      KafkaProducerService,
      OutboxPublisher,
      { provide: OUTBOX_RELAY_ENABLED, useValue: options.relay ?? false },
      OutboxRelayService,
    ];

    if (options.consumer) {
      providers.push(KafkaConsumerService);
    }

    return {
      module: MessagingModule,
      imports: [DiscoveryModule],
      providers,
      exports: [KafkaClientProvider, KafkaProducerService, OutboxPublisher, OutboxRelayService],
    };
  }
}
