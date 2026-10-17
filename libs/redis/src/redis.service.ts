import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { DependencyFailureError } from '@payhub/kernel';
import { REDIS_MODULE_OPTIONS, type RedisModuleOptions } from './redis.module-definition.js';

/**
 * Owns the ioredis connections and the lifecycle around them.
 *
 * Two clients: a command client and, optionally, a subscriber. A connection
 * in subscriber mode cannot issue normal commands — the single most common
 * way a shared Redis client breaks in production.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  readonly subscriber?: Redis;

  constructor(@Inject(REDIS_MODULE_OPTIONS) private readonly options: RedisModuleOptions) {
    this.client = new Redis(options.url, this.connectionOptions('cmd'));
    if (options.enableSubscriber) {
      this.subscriber = new Redis(options.url, this.connectionOptions('sub'));
    }
  }

  private connectionOptions(role: string): RedisOptions {
    return {
      keyPrefix: `${this.options.keyPrefix}:`,
      connectionName: `${this.options.connectionName ?? 'payhub'}-${role}`,
      maxRetriesPerRequest: this.options.maxRetries,
      enableReadyCheck: true,
      // Commands issued before the socket is ready are queued, not dropped,
      // so a slow Redis start does not fail the first requests.
      enableOfflineQueue: true,
      lazyConnect: true,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
      reconnectOnError: (error) => error.message.includes('READONLY'),
    };
  }

  async onModuleInit(): Promise<void> {
    this.client.on('error', (error: Error) => this.logger.error(`Redis error: ${error.message}`));
    this.client.on('reconnecting', () => this.logger.warn('Redis reconnecting...'));

    await this.client.connect();
    await this.subscriber?.connect();

    const info = await this.client.info('server');
    const version = /redis_version:(\S+)/.exec(info)?.[1] ?? 'unknown';
    this.logger.log(`Connected to Redis ${version} (prefix="${this.options.keyPrefix}")`);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.client.quit(), this.subscriber?.quit()]);
  }

  /**
   * Full key including the configured prefix.
   *
   * Needed **only** for commands ioredis does not prefix itself — in
   * practice that means `SCAN`'s `MATCH` pattern. Ordinary commands *and*
   * the KEYS array of `EVAL` are prefixed automatically, so prefixing them
   * here would write to `payhub:api:payhub:api:…` — a bug whose only
   * symptom is that two code paths silently use different keys.
   */
  prefixed(key: string): string {
    return `${this.options.keyPrefix}:${key}`;
  }

  get keyPrefix(): string {
    return this.options.keyPrefix;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch (error) {
      throw new DependencyFailureError('redis', 'Redis ping failed', { cause: error });
    }
  }
}
