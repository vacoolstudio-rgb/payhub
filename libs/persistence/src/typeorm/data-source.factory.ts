import { DataSource, type DataSourceOptions, type EntitySchema, type MixedList } from 'typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy.js';
import type { DatabaseConfig } from '@payhub/config';

export interface DataSourceFactoryOptions {
  readonly config: DatabaseConfig;
  /**
   * Schema override. Each bounded context owns its own schema and is never
   * allowed to read another context's tables — that boundary is what makes
   * extracting the service later a deployment change, not a rewrite.
   */
  readonly schema: string;
  readonly entities: MixedList<Function | string | EntitySchema>;
  readonly migrations: MixedList<Function | string>;
  readonly applicationName: string;
}

export function buildDataSourceOptions(options: DataSourceFactoryOptions): DataSourceOptions {
  const { config, schema, entities, migrations, applicationName } = options;

  return {
    type: 'postgres',
    url: config.url,
    schema,
    entities,
    migrations,
    // Entity property names map to snake_case columns automatically, so an
    // entity and a hand-written migration cannot drift apart.
    namingStrategy: new SnakeNamingStrategy(),
    // Never true. Schema changes go through reviewed, reversible migrations;
    // `synchronize` silently drops columns it does not recognise.
    synchronize: false,
    migrationsRun: false,
    logging: config.logging ? ['query', 'error', 'warn', 'migration'] : ['error', 'warn'],
    maxQueryExecutionTime: 1_000,
    poolSize: config.poolMax,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    applicationName,
    extra: {
      /**
       * Pin `search_path` to this service's own schema.
       *
       * TypeORM's `schema` option only qualifies the SQL *it* generates;
       * hand-written SQL in a repository stays unqualified and is resolved
       * by the server's `search_path`, which defaults to `"$user", public`.
       * With a database user called `payhub`, an unqualified
       * `SELECT … FROM outbox_messages` inside the **ledger** service
       * silently reads the **payments** schema — a cross-context read that
       * the whole design exists to prevent, and one that produces no error
       * at all. Setting it per connection makes the boundary real.
       */
      options: `-c search_path=${schema},public`,
      min: config.poolMin,
      max: config.poolMax,
      // A query that outlives its budget is killed by the server, so a stuck
      // statement cannot hold a pool connection (and its locks) forever.
      statement_timeout: config.statementTimeoutMs,
      lock_timeout: config.lockTimeoutMs,
      idle_in_transaction_session_timeout: config.statementTimeoutMs * 3,
      application_name: applicationName,
    },
  } satisfies DataSourceOptions;
}

export function createDataSource(options: DataSourceFactoryOptions): DataSource {
  return new DataSource(buildDataSourceOptions(options));
}
