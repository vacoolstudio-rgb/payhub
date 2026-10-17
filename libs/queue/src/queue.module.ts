import { type DynamicModule, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { type RedisConfig, redisConfig } from '@payhub/config';
import { DEFAULT_JOB_OPTIONS, type QueueName } from './queue.constants.js';

/**
 * BullMQ wiring.
 *
 * BullMQ needs its own ioredis connection with `maxRetriesPerRequest: null`:
 * blocking commands (`BZPOPMIN`) must not be aborted by the retry policy, and
 * ioredis throws if the option is left at its default. Sharing the
 * application's cache client here is a classic source of random
 * "Connection is closed" errors under load.
 */
@Module({})
export class QueueModule {
  static forRoot(): DynamicModule {
    return {
      module: QueueModule,
      global: true,
      imports: [
        BullModule.forRootAsync({
          inject: [redisConfig.KEY],
          useFactory: (config: RedisConfig) => ({
            connection: {
              // BullMQ parses the URL itself when given a path-less object,
              // so hand it the parsed parts explicitly.
              ...parseRedisUrl(config.url),
              maxRetriesPerRequest: null,
              enableReadyCheck: false,
            },
            prefix: `${config.keyPrefix}:bull`,
            defaultJobOptions: DEFAULT_JOB_OPTIONS,
          }),
        }),
      ],
      exports: [BullModule],
    };
  }

  /** Registers one queue in the importing module. */
  static registerQueue(...names: QueueName[]): DynamicModule {
    return {
      module: QueueModule,
      imports: [BullModule.registerQueue(...names.map((name) => ({ name })))],
      exports: [BullModule],
    };
  }
}

export function parseRedisUrl(url: string): {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
} {
  const parsed = new URL(url);
  const db = Number(parsed.pathname.replace('/', ''));

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(Number.isFinite(db) && db > 0 ? { db } : {}),
  };
}
