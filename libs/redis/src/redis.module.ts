import { Module } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { CacheService } from './cache.service.js';
import { DistributedLockService } from './distributed-lock.service.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyService } from './idempotency.service.js';
import { HttpCacheInterceptor } from './http-cache.interceptor.js';
import { ResourceVersionService } from './resource-version.service.js';
import { ConfigurableRedisModuleClass } from './redis.module-definition.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import { RedisService } from './redis.service.js';
import { TokenBucketService } from './token-bucket.service.js';

/**
 * Everything that needs a Redis connection, wired once.
 *
 * `extends ConfigurableRedisModuleClass` is what gives this module its
 * generated `RedisModule.forRoot(...)` and `RedisModule.forRootAsync(...)`.
 */
@Module({
  providers: [
    RedisService,
    CacheService,
    DistributedLockService,
    IdempotencyService,
    IdempotencyInterceptor,
    ResourceVersionService,
    HttpCacheInterceptor,
    TokenBucketService,
    RedisThrottlerStorage,
    { provide: ThrottlerStorage, useExisting: RedisThrottlerStorage },
  ],
  exports: [
    RedisService,
    CacheService,
    DistributedLockService,
    IdempotencyService,
    IdempotencyInterceptor,
    ResourceVersionService,
    HttpCacheInterceptor,
    TokenBucketService,
    RedisThrottlerStorage,
    ThrottlerStorage,
  ],
})
export class RedisModule extends ConfigurableRedisModuleClass {}
