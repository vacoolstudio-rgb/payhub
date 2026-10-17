import { Module } from '@nestjs/common';
import { ConfigModule, type RedisConfig, redisConfig } from '@payhub/config';
import { ObservabilityModule } from '@payhub/observability';
import { RedisModule } from '@payhub/redis';
import { EmailChannel, PushChannel } from './channels/notification.channels.js';
import { NotificationDispatcher } from './channels/notification.dispatcher.js';
import { NotificationsController } from './notifications.controller.js';

/**
 * Notifications service.
 *
 * The smallest deployable in the platform, and the one with the loosest
 * guarantees — which is exactly why it is separate. It owns no database:
 * everything it needs arrives in the event, and its only state (dedup +
 * rate limit) is cache-shaped and lives in Redis.
 */
@Module({
  imports: [
    ConfigModule,
    // No database in this service: it reacts to Kafka and pushes out.
    ObservabilityModule.forRoot({ health: ['redis'] }),
    RedisModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (config: RedisConfig) => ({
        url: config.url,
        keyPrefix: `${config.keyPrefix}:notifications`,
        maxRetries: config.maxRetries,
      }),
    }),
  ],
  controllers: [NotificationsController],
  providers: [EmailChannel, PushChannel, NotificationDispatcher],
})
export class NotificationsModule {}
