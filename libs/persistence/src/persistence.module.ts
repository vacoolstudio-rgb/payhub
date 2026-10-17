import {
  type DynamicModule,
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { ClsModule, ClsService } from 'nestjs-cls';
import { DataSource, type EntitySchema, type MixedList } from 'typeorm';
import { type DatabaseConfig, databaseConfig } from '@payhub/config';
import { TypeOrmRepositoryBase } from './base.repository.js';
import { InboxRepository } from './inbox/inbox.repository.js';
import { ProcessedMessageEntity } from './inbox/processed-message.entity.js';
import { AdvisoryLockService } from './locks/advisory-lock.service.js';
import { OutboxMessageEntity } from './outbox/outbox-message.entity.js';
import { OutboxRepository } from './outbox/outbox.repository.js';
import { TransactionManager } from './transaction.manager.js';
import { TransactionalContext } from './transactional.decorator.js';
import { createDataSource } from './typeorm/data-source.factory.js';

export interface PersistenceModuleOptions {
  /** Schema owned by this service. One context, one schema, no cross reads. */
  readonly schema: string;
  readonly entities: MixedList<Function | string | EntitySchema>;
  readonly migrations?: MixedList<Function | string>;
  /** Shows up in `pg_stat_activity` — invaluable when hunting a lock holder. */
  readonly applicationName: string;
  /** Adds the outbox + inbox tables to the schema. */
  readonly withOutbox?: boolean;
}

export const PERSISTENCE_OPTIONS = Symbol.for('payhub:PersistenceOptions');

/**
 * Hand-written dynamic module.
 *
 * `forRoot` is a static factory that returns a `DynamicModule` descriptor —
 * the module class itself carries no state, the returned object does. The
 * async variant exists because the DataSource depends on configuration that
 * is only resolvable through the container.
 */
@Global()
@Module({})
export class PersistenceModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PersistenceModule.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly transactions: TransactionManager,
    @Inject(PERSISTENCE_OPTIONS) private readonly options: PersistenceModuleOptions,
    @Inject(databaseConfig.KEY) private readonly config: DatabaseConfig,
  ) {}

  static forRoot(options: PersistenceModuleOptions): DynamicModule {
    const entities = [
      ...normalise(options.entities),
      ...(options.withOutbox === false ? [] : [OutboxMessageEntity, ProcessedMessageEntity]),
    ];

    const providers: Provider[] = [
      { provide: PERSISTENCE_OPTIONS, useValue: options },
      {
        provide: DataSource,
        inject: [databaseConfig.KEY],
        useFactory: (config: DatabaseConfig) =>
          createDataSource({
            config,
            schema: options.schema,
            entities,
            migrations: normalise(options.migrations ?? []),
            applicationName: options.applicationName,
          }),
      },
      {
        provide: TransactionManager,
        inject: [DataSource, ClsService],
        useFactory: (dataSource: DataSource, cls: ClsService) =>
          new TransactionManager(dataSource, cls),
      },
      OutboxRepository,
      InboxRepository,
      AdvisoryLockService,
    ];

    return {
      module: PersistenceModule,
      imports: [ClsModule],
      providers,
      exports: [
        DataSource,
        TransactionManager,
        OutboxRepository,
        InboxRepository,
        AdvisoryLockService,
        PERSISTENCE_OPTIONS,
      ],
    };
  }

  async onModuleInit(): Promise<void> {
    if (!this.dataSource.isInitialized) {
      await this.dataSource.initialize();
    }

    // Bind before anything can call a @Transactional() method.
    TransactionalContext.bind(this.transactions);

    await this.dataSource.query(
      `CREATE SCHEMA IF NOT EXISTS "${this.options.schema.replace(/"/g, '')}"`,
    );

    if (this.config.runMigrations) {
      const applied = await this.dataSource.runMigrations({ transaction: 'each' });
      this.logger.log(
        applied.length > 0
          ? `Applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}`
          : 'Database schema is up to date',
      );
    }

    this.logger.log(
      `Connected to Postgres (schema="${this.options.schema}", pool=${this.config.poolMin}..${this.config.poolMax})`,
    );
  }

  /**
   * Shutdown hook. Draining the pool here — rather than letting the process
   * exit — lets in-flight transactions finish, which is the difference
   * between a clean rolling deploy and a handful of orphaned payments.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.dataSource.isInitialized) {
      this.logger.log(`Closing database pool (signal=${signal ?? 'n/a'})`);
      await this.dataSource.destroy();
    }
    TransactionalContext.reset();
  }
}

function normalise<T>(value: MixedList<T>): T[] {
  return Array.isArray(value) ? value : (Object.values(value) as T[]);
}

export { TypeOrmRepositoryBase };
