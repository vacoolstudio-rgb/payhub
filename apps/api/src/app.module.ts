import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import {
  ConfigModule,
  type RedisConfig,
  type ResilienceConfig,
  redisConfig,
  resilienceConfig,
} from '@payhub/config';
import { MessagingModule } from '@payhub/messaging';
import { MetricsInterceptor, ObservabilityModule } from '@payhub/observability';
import { PersistenceModule } from '@payhub/persistence';
import { HttpCacheInterceptor, RedisModule, RedisThrottlerStorage } from '@payhub/redis';
import {
  AllExceptionsFilter,
  CorrelationIdMiddleware,
  TimeoutInterceptor,
} from '@payhub/shared';
import { apiMigrations } from './database/migrations/index.js';
import { GqlThrottlerGuard } from './graphql/gql-throttler.guard.js';
import { GraphqlModule } from './graphql/graphql.module.js';
import { AssistantModule } from './modules/assistant/assistant.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { ApiKeyEntity } from './modules/identity/infrastructure/persistence/entities/api-key.entity.js';
import { RefreshSessionEntity } from './modules/identity/infrastructure/persistence/entities/refresh-session.entity.js';
import { UserEntity } from './modules/identity/infrastructure/persistence/entities/user.entity.js';
import { MerchantModule } from './modules/merchant/merchant.module.js';
import { MerchantEntity } from './modules/merchant/infrastructure/persistence/entities/merchant.entity.js';
import { PaymentModule } from './modules/payment/payment.module.js';
import { PaymentEntity } from './modules/payment/infrastructure/persistence/entities/payment.entity.js';
import { WalletModule } from './modules/wallet/wallet.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';

/**
 * Composition root of the API service.
 *
 * Guard order: `ThrottlerGuard` (here) runs before the authentication and
 * authorisation guards (registered in `IdentityModule`, where their
 * dependencies live), so an unauthenticated flood is rejected without ever
 * touching argon2 or the database.
 *
 * Every enhancer is registered through a DI token rather than
 * `app.useGlobalGuards(new …)`, because they all need injected
 * dependencies — the single most common reason a hand-instantiated global
 * guard silently fails.
 */
@Module({
  imports: [
    ConfigModule,
    ObservabilityModule.forRoot({ health: ['postgres', 'redis', 'outbox'] }),
    EventEmitterModule.forRoot({ global: true, maxListeners: 20, verboseMemoryLeak: true }),

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
      applicationName: 'payhub-api',
      entities: [
        UserEntity,
        RefreshSessionEntity,
        ApiKeyEntity,
        MerchantEntity,
        PaymentEntity,
      ],
      migrations: apiMigrations,
    }),

    // Produces payment events and consumes the ledger's facts; the relay
    // runs in the worker, not here, so an API pod restart never interrupts
    // event delivery mid-batch.
    MessagingModule.forRoot({ consumer: true, relay: false }),

    ThrottlerModule.forRootAsync({
      inject: [resilienceConfig.KEY, RedisThrottlerStorage],
      useFactory: (config: ResilienceConfig, storage: RedisThrottlerStorage) => ({
        throttlers: [{ name: 'default', ttl: config.throttleTtlMs, limit: config.throttleLimit }],
        storage,
        // Health and metrics are scraped far more often than the limit
        // allows, and throttling a probe would take the pod out of rotation.
        skipIf: (context) => {
          const request = context.switchToHttp().getRequest<{ url?: string }>();
          return (
            request?.url?.startsWith('/health') === true ||
            request?.url?.startsWith('/metrics') === true
          );
        },
      }),
    }),

    IdentityModule,
    MerchantModule,
    PaymentModule,
    WalletModule,
    AssistantModule,
    GraphqlModule,
    RealtimeModule,
  ],
  providers: [
    // Throttling runs first so an unauthenticated flood never reaches
    // argon2 or the database. The authentication and authorisation guards
    // are registered inside IdentityModule, which owns their dependencies.
    { provide: APP_GUARD, useClass: GqlThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
    // Last in, so it wraps closest to the handler: on a 304 it returns
    // before the handler runs, while metrics and the timeout still see
    // the request.
    { provide: APP_INTERCEPTOR, useClass: HttpCacheInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware)
      .exclude(
        { path: 'health/(.*)', method: RequestMethod.ALL },
        { path: 'metrics', method: RequestMethod.ALL },
      )
      .forRoutes('*');
  }
}
