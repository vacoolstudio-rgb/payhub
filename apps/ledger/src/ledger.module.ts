import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule, type RedisConfig, redisConfig } from '@payhub/config';
import { MessagingModule } from '@payhub/messaging';
import { ObservabilityModule, MetricsInterceptor } from '@payhub/observability';
import { PersistenceModule } from '@payhub/persistence';
import { RedisModule } from '@payhub/redis';
import { AllExceptionsFilter } from '@payhub/shared';
import { PostTransferService } from './application/commands/post-transfer.service.js';
import { LedgerReconciliationJob } from './application/jobs/reconciliation.job.js';
import { ReverseTransferService } from './application/commands/reverse-transfer.service.js';
import { WalletQueryService } from './application/queries/wallet-query.service.js';
import { JOURNAL_REPOSITORY } from './domain/ledger/journal-entry.repository.js';
import { TransferPlanner } from './domain/ledger/transfer-planner.service.js';
import { WALLET_REPOSITORY } from './domain/wallet/wallet.repository.js';
import { LedgerCommandConsumer } from './infrastructure/messaging/ledger-command.consumer.js';
import { InitLedgerSchema1740000000000 } from './infrastructure/migrations/1740000000000-InitLedgerSchema.js';
import { DropRedundantWalletIndex1740000000004 } from './infrastructure/migrations/1740000000004-DropRedundantWalletIndex.js';
import { JournalEntriesAppendOnly1740000000005 } from './infrastructure/migrations/1740000000005-JournalEntriesAppendOnly.js';
import { JournalEntryEntity } from './infrastructure/persistence/entities/journal-entry.entity.js';
import { PostingEntity } from './infrastructure/persistence/entities/posting.entity.js';
import { WalletEntity } from './infrastructure/persistence/entities/wallet.entity.js';
import { TypeOrmJournalRepository } from './infrastructure/persistence/repositories/typeorm-journal.repository.js';
import { TypeOrmWalletRepository } from './infrastructure/persistence/repositories/typeorm-wallet.repository.js';
import { LedgerGrpcController } from './presentation/grpc/ledger.grpc.controller.js';

/**
 * The ledger service.
 *
 * Owns the `ledger` schema exclusively. No other service has credentials for
 * it, which is what makes this a bounded context rather than a folder: the
 * only ways in are the Kafka command topic (writes) and the gRPC API
 * (reads).
 *
 * Note how the ports are bound to adapters here, at the composition root —
 * the application services depend on `WALLET_REPOSITORY`, never on TypeORM.
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
        keyPrefix: `${config.keyPrefix}:ledger`,
        maxRetries: config.maxRetries,
      }),
    }),
    PersistenceModule.forRoot({
      schema: 'ledger',
      applicationName: 'payhub-ledger',
      entities: [WalletEntity, JournalEntryEntity, PostingEntity],
      migrations: [
        InitLedgerSchema1740000000000,
        DropRedundantWalletIndex1740000000004,
        JournalEntriesAppendOnly1740000000005,
      ],
    }),
    MessagingModule.forRoot({ consumer: true, relay: true }),
  ],
  controllers: [LedgerGrpcController],
  providers: [
    // --- domain services --------------------------------------------------
    TransferPlanner,

    // --- application ------------------------------------------------------
    PostTransferService,
    ReverseTransferService,
    WalletQueryService,
    LedgerReconciliationJob,

    // --- ports → adapters -------------------------------------------------
    { provide: WALLET_REPOSITORY, useClass: TypeOrmWalletRepository },
    { provide: JOURNAL_REPOSITORY, useClass: TypeOrmJournalRepository },

    // --- inbound adapters -------------------------------------------------
    LedgerCommandConsumer,

    // --- global enhancers -------------------------------------------------
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
})
export class LedgerModule {}
