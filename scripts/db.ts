/**
 * Database CLI.
 *
 * Written against the DataSource API rather than TypeORM's own CLI because
 * the CLI's ESM story is still awkward (it wants a `--dataSource` file it
 * can `require`) and because this way the schema list, the migration list
 * and the connection string all come from the same validated config the
 * application uses. One source of truth beats a parallel CLI config.
 *
 *   npm run db:migrate  — apply pending migrations to every schema
 *   npm run db:revert   — roll the last migration back
 *   npm run db:show     — list applied/pending migrations
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseConfig, loadEnv } from '../libs/config/src/index.js';
import { createDataSource } from '../libs/persistence/src/index.js';
import { apiMigrations } from '../apps/api/src/database/migrations/index.js';
import { InitLedgerSchema1740000000000 } from '../apps/ledger/src/infrastructure/migrations/1740000000000-InitLedgerSchema.js';

interface Target {
  readonly name: string;
  readonly schema: string;
  readonly migrations: Function[];
}

const TARGETS: Target[] = [
  { name: 'api', schema: 'payhub', migrations: apiMigrations },
  { name: 'ledger', schema: 'ledger', migrations: [InitLedgerSchema1740000000000] },
];

async function withDataSource<T>(target: Target, work: (ds: DataSource) => Promise<T>): Promise<T> {
  loadEnv();
  const config = databaseConfig();

  const dataSource = createDataSource({
    config,
    schema: target.schema,
    entities: [],
    migrations: target.migrations,
    applicationName: `payhub-cli-${target.name}`,
  });

  await dataSource.initialize();
  await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${target.schema}"`);

  try {
    return await work(dataSource);
  } finally {
    await dataSource.destroy();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'migrate';

  for (const target of TARGETS) {
    switch (command) {
      case 'migrate': {
        const applied = await withDataSource(target, (ds) =>
          ds.runMigrations({ transaction: 'each' }),
        );
        console.log(
          applied.length === 0
            ? `[${target.name}] already up to date`
            : `[${target.name}] applied: ${applied.map((m) => m.name).join(', ')}`,
        );
        break;
      }

      case 'revert': {
        await withDataSource(target, (ds) => ds.undoLastMigration({ transaction: 'each' }));
        console.log(`[${target.name}] reverted the last migration`);
        break;
      }

      case 'show': {
        const pending = await withDataSource(target, (ds) => ds.showMigrations());
        console.log(`[${target.name}] pending migrations: ${pending ? 'yes' : 'no'}`);
        break;
      }

      default:
        console.error(`Unknown command "${command}". Use migrate | revert | show.`);
        process.exit(1);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
