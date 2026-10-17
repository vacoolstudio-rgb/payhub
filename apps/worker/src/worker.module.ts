import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import {
  ConfigModule,
  type RedisConfig,
  redisConfig,
} from '@payhub/config';
import { MessagingModule } from '@payhub/messaging';
import { ObservabilityModule } from '@payhub/observability';
import { PersistenceModule } from '@payhub/persistence';
import { QueueModule, QueueName } from '@payhub/queue';
import { RedisModule } from '@payhub/redis';
import { AllExceptionsFilter } from '@payhub/shared';
import { ApiKeyEntity } from '../../api/src/modules/identity/infrastructure/persistence/entities/api-key.entity.js';
import { RefreshSessionEntity } from '../../api/src/modules/identity/infrastructure/persistence/entities/refresh-session.entity.js';
import { UserEntity } from '../../api/src/modules/identity/infrastructure/persistence/entities/user.entity.js';
import { MerchantEntity } from '../../api/src/modules/merchant/infrastructure/persistence/entities/merchant.entity.js';
import { PaymentEntity } from '../../api/src/modules/payment/infrastructure/persistence/entities/payment.entity.js';
import { QueueAdminModule } from './admin/bull-board.module.js';
import { CleanupJob } from './jobs/cleanup.job.js';
import { PaymentExpiryJob } from './jobs/payment-expiry.job.js';
import { MerchantLookupService } from './webhooks/merchant-lookup.service.js';
import { WebhookDeliveryEntity } from './webhooks/webhook-delivery.entity.js';
import { WebhookDeliveryRepository } from './webhooks/webhook-delivery.repository.js';
import { WebhookDispatchConsumer } from './webhooks/webhook-dispatch.consumer.js';
import { WebhookProcessor } from './webhooks/webhook.processor.js';

/**
 * Background worker.
 *
 * Shares the `payhub` schema with the API because it is the same bounded
 * context deployed for a different workload profile: the API is latency
 * bound and scales on request rate, the worker is throughput bound and
 * scales on queue depth. Splitting the deployment while keeping the schema
 * is the right call here; splitting the schema too would mean the worker
 * could not read a payment it is compensating.
 *
 * It does **not** run migrations — only the API does, so two deployments
 * can never race the same DDL.
 */
@Module({
  imports: [
    ConfigModule,
    ObservabilityModule.forRoot({ health: ['postgres', 'redis', 'outbox'] }),
    ScheduleModule.forRoot(),

    RedisModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (config: RedisConfig) => ({
        url: config.url,
        keyPrefix: `${config.keyPrefix}:api`,
        maxRetries: config.maxRetries,
      }),
    }),

    PersistenceModule.forRoot({
      schema: 'payhub',
      applicationName: 'payhub-worker',
      entities: [
        UserEntity,
        RefreshSessionEntity,
        ApiKeyEntity,
        MerchantEntity,
        PaymentEntity,
        WebhookDeliveryEntity,
      ],
      migrations: [],
    }),

    // The worker owns the relay: draining the outbox is background work by
    // definition, and keeping it out of the API means a deploy of the API
    // never pauses event delivery.
    MessagingModule.forRoot({ consumer: true, relay: true }),

    QueueModule.forRoot(),
    BullModule.registerQueue({ name: QueueName.WebhookDelivery }),
    QueueAdminModule,
  ],
  providers: [
    WebhookProcessor,
    WebhookDispatchConsumer,
    WebhookDeliveryRepository,
    MerchantLookupService,
    PaymentExpiryJob,
    CleanupJob,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class WorkerModule {}
