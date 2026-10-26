import { Test, type TestingModule } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiKeyAuthenticator } from '../apps/api/src/modules/identity/application/api-key-authenticator.service.js';
import { ApiKey, ApiKeyId } from '../apps/api/src/modules/identity/domain/api-key.aggregate.js';
import { API_KEY_REPOSITORY } from '../apps/api/src/modules/identity/domain/identity.ports.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { llmConfig, resilienceConfig } from '@payhub/config';
import { TokenBudgetService } from '../apps/api/src/modules/assistant/application/token-budget.service.js';
import { MetricsService } from '@payhub/observability';
import { appConfig } from '@payhub/config';
import {
  CacheService,
  ResourceVersionService,
  DistributedLockService,
  IdempotencyService,
  REDIS_MODULE_OPTIONS,
  RedisService,
  RedisThrottlerStorage,
  TokenBucketService,
} from '@payhub/redis';

/**
 * Redis integration tests.
 *
 * Every primitive under test is a Lua script, and the whole reason those
 * scripts exist is atomicity under concurrency — which an in-memory fake
 * cannot reproduce. These also pin down the one behaviour that silently
 * broke in development: ioredis prefixes the KEYS array of `EVAL`, so a
 * manually prefixed key lands under `prefix:prefix:…` and two code paths
 * quietly use different keys.
 */
describe('Redis primitives (integration)', () => {
  let container: StartedRedisContainer;
  let moduleRef: TestingModule;
  let redis: RedisService;
  let cache: CacheService;
  let budget: TokenBudgetService;
  let versions: ResourceVersionService;
  let apiKeyAuth: ApiKeyAuthenticator;

  /** Counts reads so the test can prove the database was not consulted. */
  const apiKeyRepository = {
    lookups: 0,
    stored: new Map<string, ApiKey>(),
    async findByHash(hash: string): Promise<ApiKey | null> {
      apiKeyRepository.lookups += 1;
      return apiKeyRepository.stored.get(hash) ?? null;
    },
  };
  let locks: DistributedLockService;
  let buckets: TokenBucketService;
  let idempotency: IdempotencyService;
  let throttler: RedisThrottlerStorage;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();

    moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: REDIS_MODULE_OPTIONS,
          useValue: {
            url: container.getConnectionUrl(),
            keyPrefix: 'payhub-test',
            maxRetries: 3,
          },
        },
        {
          provide: resilienceConfig.KEY,
          useValue: {
            throttleTtlMs: 60_000,
            throttleLimit: 100,
            idempotencyTtlSec: 60,
            idempotencyLockTtlMs: 2_000,
            distributedLockTtlMs: 5_000,
          },
        },
        RedisService,
        CacheService,
        ResourceVersionService,
        ApiKeyAuthenticator,
        { provide: API_KEY_REPOSITORY, useValue: apiKeyRepository },
        DistributedLockService,
        TokenBucketService,
        IdempotencyService,
        RedisThrottlerStorage,
        TokenBudgetService,
        MetricsService,
        {
          provide: appConfig.KEY,
          useValue: { serviceName: 'payhub-test', serviceVersion: '0.0.0', nodeEnv: 'test' },
        },
        {
          provide: llmConfig.KEY,
          useValue: {
            enabled: true,
            userRpm: 1_000,
            userDailyTokenBudget: 1_000,
            model: 'test-model',
          },
        },
      ],
    }).compile();

    await moduleRef.init();

    redis = moduleRef.get(RedisService);
    cache = moduleRef.get(CacheService);
    versions = moduleRef.get(ResourceVersionService);
    apiKeyAuth = moduleRef.get(ApiKeyAuthenticator);
    locks = moduleRef.get(DistributedLockService);
    buckets = moduleRef.get(TokenBucketService);
    budget = moduleRef.get(TokenBudgetService);
    idempotency = moduleRef.get(IdempotencyService);
    throttler = moduleRef.get(RedisThrottlerStorage);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    await redis.client.flushdb();
    apiKeyRepository.lookups = 0;
    apiKeyRepository.stored.clear();
  });

  describe('key prefixing', () => {
    /**
     * Regression: `EVAL` keys are prefixed by ioredis exactly like normal
     * command arguments. Prefixing them again by hand produced
     * `payhub:api:payhub:api:idem:…`, so `begin()` and `complete()` wrote
     * to different keys and every retry looked like "still in progress".
     */
    it('writes Lua and plain commands to the same key', async () => {
      const key = `probe:${randomUUID()}`;

      await idempotency.begin(key, 'fingerprint');
      await redis.client.set(`${key}:plain`, 'x');

      const keys = await redis.client.keys('*');
      const doubled = keys.filter((entry) => entry.includes('payhub-test:payhub-test'));

      expect(doubled).toEqual([]);
      expect(await redis.client.get(key)).toBe('in_progress');
    });
  });

  describe('idempotency', () => {
    const fingerprint = 'body-fingerprint';

    it('claims a fresh key, then replays the stored response', async () => {
      const key = `idem:${randomUUID()}`;

      expect(await idempotency.begin(key, fingerprint)).toEqual({ status: 'fresh' });

      await idempotency.complete(key, { fingerprint, statusCode: 201, body: { id: 'p-1' } });

      expect(await idempotency.begin(key, fingerprint)).toEqual({
        status: 'completed',
        statusCode: 201,
        body: { id: 'p-1' },
      });
    });

    it('reports a concurrent request as in progress', async () => {
      const key = `idem:${randomUUID()}`;
      await idempotency.begin(key, fingerprint);

      expect(await idempotency.begin(key, fingerprint)).toEqual({ status: 'in_progress' });
    });

    /** Reusing a key with a different body is a client bug, not a retry. */
    it('rejects the same key with a different body', async () => {
      const key = `idem:${randomUUID()}`;
      await idempotency.begin(key, fingerprint);
      await idempotency.complete(key, { fingerprint, statusCode: 201, body: {} });

      await expect(idempotency.begin(key, 'a-different-body')).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    });

    /** Exactly one of N concurrent claims may win. */
    it('is atomic under concurrency', async () => {
      const key = `idem:${randomUUID()}`;

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () => idempotency.begin(key, fingerprint)),
      );

      expect(outcomes.filter((outcome) => outcome.status === 'fresh')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'in_progress')).toHaveLength(19);
    });

    it('releases the key after a failure so the client can retry at once', async () => {
      const key = `idem:${randomUUID()}`;
      await idempotency.begin(key, fingerprint);

      await idempotency.abandon(key);

      expect(await idempotency.begin(key, fingerprint)).toEqual({ status: 'fresh' });
    });

    it('does not abandon a key that already holds a response', async () => {
      const key = `idem:${randomUUID()}`;
      await idempotency.begin(key, fingerprint);
      await idempotency.complete(key, { fingerprint, statusCode: 200, body: { ok: true } });

      await idempotency.abandon(key);

      expect((await idempotency.begin(key, fingerprint)).status).toBe('completed');
    });
  });

  describe('token bucket', () => {
    it('allows a burst up to the capacity, then refuses', async () => {
      const bucket = `user:${randomUUID()}`;
      const options = { capacity: 5, refillPerSecond: 1 };

      const allowed: boolean[] = [];
      for (let i = 0; i < 7; i += 1) {
        allowed.push((await buckets.consume(bucket, options)).allowed);
      }

      expect(allowed).toEqual([true, true, true, true, true, false, false]);
    });

    it('tells the caller how long to wait', async () => {
      const bucket = `user:${randomUUID()}`;
      const options = { capacity: 1, refillPerSecond: 2 };

      await buckets.consume(bucket, options);
      const denied = await buckets.consume(bucket, options);

      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(500);
    });

    it('refills over time', async () => {
      const bucket = `user:${randomUUID()}`;
      const options = { capacity: 2, refillPerSecond: 20 };

      await buckets.consume(bucket, options);
      await buckets.consume(bucket, options);
      expect((await buckets.consume(bucket, options)).allowed).toBe(false);

      await delay(150);

      expect((await buckets.consume(bucket, options)).allowed).toBe(true);
    });

    it('spends more than one token when a call is more expensive', async () => {
      const bucket = `user:${randomUUID()}`;
      const options = { capacity: 10, refillPerSecond: 1 };

      expect((await buckets.consume(bucket, { ...options, cost: 8 })).allowed).toBe(true);
      expect((await buckets.consume(bucket, { ...options, cost: 8 })).allowed).toBe(false);
    });

    /** Without Lua this is a read-modify-write race and the cap leaks. */
    it('never allows more than the capacity under concurrency', async () => {
      const bucket = `user:${randomUUID()}`;
      const options = { capacity: 10, refillPerSecond: 0.001 };

      const outcomes = await Promise.all(
        Array.from({ length: 50 }, () => buckets.consume(bucket, options)),
      );

      expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(10);
    });

    it('keeps buckets independent', async () => {
      const options = { capacity: 1, refillPerSecond: 0.001 };

      expect((await buckets.consume('a', options)).allowed).toBe(true);
      expect((await buckets.consume('b', options)).allowed).toBe(true);
      expect((await buckets.consume('a', options)).allowed).toBe(false);
    });
  });

  describe('distributed lock', () => {
    it('admits exactly one holder', async () => {
      const key = `cron:${randomUUID()}`;

      const first = await locks.acquire(key, { ttlMs: 5_000 });
      const second = await locks.acquire(key, { ttlMs: 5_000 });

      expect(first).not.toBeNull();
      expect(second).toBeNull();

      await locks.release(first!);
      expect(await locks.acquire(key, { ttlMs: 5_000 })).not.toBeNull();
    });

    it('serialises concurrent contenders', async () => {
      const key = `cron:${randomUUID()}`;

      const handles = await Promise.all(
        Array.from({ length: 10 }, () => locks.acquire(key, { ttlMs: 5_000 })),
      );

      expect(handles.filter(Boolean)).toHaveLength(1);
    });

    /**
     * Fencing tokens are the answer to the Redlock critique: a lock can
     * expire while its holder is paused, so the protected resource needs a
     * monotonically increasing number it can compare against.
     */
    it('hands out strictly increasing fencing tokens', async () => {
      const key = `cron:${randomUUID()}`;
      const tokens: bigint[] = [];

      for (let i = 0; i < 5; i += 1) {
        const handle = await locks.acquire(key, { ttlMs: 5_000 });
        tokens.push(handle!.fencingToken);
        await locks.release(handle!);
      }

      expect(tokens).toEqual([...tokens].sort((a, b) => (a < b ? -1 : 1)));
      expect(new Set(tokens).size).toBe(tokens.length);
    });

    /** Compare-and-delete: a stale holder must not release somebody else's lock. */
    it('refuses to release a lock it no longer owns', async () => {
      const key = `cron:${randomUUID()}`;
      const handle = await locks.acquire(key, { ttlMs: 100 });

      await delay(200);
      const other = await locks.acquire(key, { ttlMs: 5_000 });

      expect(await locks.release(handle!)).toBe(false);
      expect(await locks.release(other!)).toBe(true);
    });

    it('expires on its own if the holder dies', async () => {
      const key = `cron:${randomUUID()}`;
      await locks.acquire(key, { ttlMs: 120 });

      await delay(250);

      expect(await locks.acquire(key, { ttlMs: 1_000 })).not.toBeNull();
    });

    it('extends a lease it still owns, and not one it does not', async () => {
      const key = `cron:${randomUUID()}`;
      const handle = await locks.acquire(key, { ttlMs: 200 });

      expect(await locks.extend(handle!, 5_000)).toBe(true);
      await delay(300);
      // Still held, because the lease was renewed.
      expect(await locks.acquire(key, { ttlMs: 1_000 })).toBeNull();

      await locks.release(handle!);
      expect(await locks.extend(handle!, 5_000)).toBe(false);
    });

    it('releases the lock even when the work throws', async () => {
      const key = `cron:${randomUUID()}`;

      await expect(
        locks.withLock(key, { ttlMs: 5_000 }, async () => {
          throw new Error('job failed');
        }),
      ).rejects.toThrow('job failed');

      expect(await locks.acquire(key, { ttlMs: 1_000 })).not.toBeNull();
    });

    it('skips the work when another instance holds the lock', async () => {
      const key = `cron:${randomUUID()}`;
      const held = await locks.acquire(key, { ttlMs: 5_000 });

      let ran = false;
      const outcome = await locks.withLock(key, { ttlMs: 5_000 }, async () => {
        ran = true;
        return 'done';
      });

      expect(outcome).toBeNull();
      expect(ran).toBe(false);
      await locks.release(held!);
    });
  });

  describe('throttler storage', () => {
    it('counts hits inside the window and blocks above the limit', async () => {
      const key = `ip:${randomUUID()}`;

      const first = await throttler.increment(key, 1_000, 2, 0, 'default');
      const second = await throttler.increment(key, 1_000, 2, 0, 'default');
      const third = await throttler.increment(key, 1_000, 2, 0, 'default');

      expect(first.totalHits).toBe(1);
      expect(second.isBlocked).toBe(false);
      expect(third.totalHits).toBe(3);
      expect(third.isBlocked).toBe(true);
    });

    /**
     * A fixed window lets a client send `limit` requests at the end of one
     * window and `limit` more at the start of the next. A sliding window
     * forgets hits individually as they age out.
     */
    it('forgets hits as they slide out of the window', async () => {
      const key = `ip:${randomUUID()}`;

      await throttler.increment(key, 200, 2, 0, 'default');
      await throttler.increment(key, 200, 2, 0, 'default');
      await delay(250);

      const afterWindow = await throttler.increment(key, 200, 2, 0, 'default');

      expect(afterWindow.totalHits).toBe(1);
      expect(afterWindow.isBlocked).toBe(false);
    });

    it('keeps blocking for the block duration once tripped', async () => {
      const key = `ip:${randomUUID()}`;

      await throttler.increment(key, 1_000, 1, 2_000, 'default');
      const blocked = await throttler.increment(key, 1_000, 1, 2_000, 'default');

      expect(blocked.isBlocked).toBe(true);
      expect(blocked.timeToBlockExpire).toBeGreaterThan(0);

      const stillBlocked = await throttler.increment(key, 1_000, 1, 2_000, 'default');
      expect(stillBlocked.isBlocked).toBe(true);
    });

    it('keeps named throttlers apart', async () => {
      const key = `ip:${randomUUID()}`;

      await throttler.increment(key, 1_000, 1, 0, 'login');
      const other = await throttler.increment(key, 1_000, 1, 0, 'payments');

      expect(other.totalHits).toBe(1);
    });
  });

  describe('cache', () => {
    it('stores, reads and deletes', async () => {
      const key = `wallet:${randomUUID()}`;

      expect(await cache.get(key)).toBeUndefined();

      await cache.set(key, { balance: '100.00' }, { ttlSec: 30 });
      expect(await cache.get(key)).toEqual({ balance: '100.00' });

      await cache.del(key);
      expect(await cache.get(key)).toBeUndefined();
    });

    /** `undefined` means "not cached"; `null` means "known to be absent". */
    it('distinguishes a miss from a cached absence', async () => {
      const key = `wallet:${randomUUID()}`;

      const loaded = await cache.getOrSet(key, async () => null, { ttlSec: 30 });

      expect(loaded).toBeNull();
      expect(await cache.get(key)).toBeNull();
    });

    /**
     * Stampede control: when a hot key expires, only one caller may reach
     * the database. The rest wait and read the result.
     */
    it('collapses concurrent misses into a single load', async () => {
      const key = `wallet:${randomUUID()}`;
      let loads = 0;

      const results = await Promise.all(
        Array.from({ length: 25 }, () =>
          cache.getOrSet(
            key,
            async () => {
              loads += 1;
              await delay(40);
              return { value: loads };
            },
            { ttlSec: 30 },
          ),
        ),
      );

      expect(loads).toBe(1);
      expect(results.every((result) => (result as { value: number }).value === 1)).toBe(true);
    });

    it('serves later readers from the cache', async () => {
      const key = `wallet:${randomUUID()}`;
      let loads = 0;
      const loader = async () => {
        loads += 1;
        return { value: loads };
      };

      await cache.getOrSet(key, loader, { ttlSec: 30 });
      await cache.getOrSet(key, loader, { ttlSec: 30 });

      expect(loads).toBe(1);
    });

    it('invalidates by pattern using SCAN, not KEYS', async () => {
      const prefix = randomUUID();
      await cache.set(`wallet:${prefix}:1`, 1, { ttlSec: 30 });
      await cache.set(`wallet:${prefix}:2`, 2, { ttlSec: 30 });
      await cache.set(`payment:${prefix}:1`, 3, { ttlSec: 30 });

      const removed = await cache.invalidatePattern(`wallet:${prefix}:*`);

      expect(removed).toBe(2);
      expect(await cache.get(`wallet:${prefix}:1`)).toBeUndefined();
      expect(await cache.get(`payment:${prefix}:1`)).toBe(3);
    });

    it('applies a jittered TTL so keys do not expire in lockstep', async () => {
      const ttls: number[] = [];

      for (let i = 0; i < 12; i += 1) {
        const key = `jitter:${randomUUID()}`;
        await cache.set(key, i, { ttlSec: 100, jitterRatio: 0.2 });
        ttls.push(await redis.client.ttl(key));
      }

      expect(new Set(ttls).size).toBeGreaterThan(1);
      expect(Math.min(...ttls)).toBeGreaterThanOrEqual(80);
      expect(Math.max(...ttls)).toBeLessThanOrEqual(120);
    });

    it('serves the L1 tier without a Redis round trip, and evicts it on delete', async () => {
      const key = `wallet:${randomUUID()}`;

      await cache.set(key, { balance: '1.00' }, { ttlSec: 30, l1: true });
      await redis.client.del(key);

      // Still answered locally: that is the coalescing window.
      expect(await cache.get(key)).toEqual({ balance: '1.00' });

      await cache.del(key);
      expect(await cache.get(key)).toBeUndefined();
    });
  });

  describe('resource versions', () => {
    /**
     * Two reads of an untouched resource must agree, or no client ever
     * gets a 304: the first request would mint a validator and the second
     * would mint a different one.
     */
    it('returns a stable token for a scope nobody has written', async () => {
      const scope = `wallets:${randomUUID()}`;

      expect(await versions.tokenFor([scope])).toBe(await versions.tokenFor([scope]));
    });

    it('returns a different token once the scope is bumped', async () => {
      const scope = `wallets:${randomUUID()}`;
      const before = await versions.tokenFor([scope]);

      await versions.bump(scope);

      expect(await versions.tokenFor([scope])).not.toBe(before);
    });

    it('folds several scopes into one token, and any of them invalidates it', async () => {
      const a = `payment:${randomUUID()}`;
      const b = `payments:user:${randomUUID()}`;
      const before = await versions.tokenFor([a, b]);

      await versions.bump(b);

      expect(await versions.tokenFor([a, b])).not.toBe(before);
    });

    it('keeps unrelated scopes independent', async () => {
      const mine = `wallets:${randomUUID()}`;
      const theirs = `wallets:${randomUUID()}`;
      const before = await versions.tokenFor([mine]);

      await versions.bump(theirs);

      expect(await versions.tokenFor([mine])).toBe(before);
    });

    /**
     * Concurrent seeding must converge. If each racing reader wrote its
     * own token, they would hand out validators that never match.
     */
    it('admits one seed under concurrency', async () => {
      const scope = `merchant:${randomUUID()}`;

      const tokens = await Promise.all(
        Array.from({ length: 10 }, () => versions.tokenFor([scope])),
      );

      expect(new Set(tokens).size).toBe(1);
    });

    /**
     * The marker is opaque rather than a counter precisely so that an
     * expiry cannot resurrect an old validator: a reused value would mean
     * a client's stale ETag starts matching again.
     */
    it('never reissues a value it has used before', async () => {
      const scope = `wallets:${randomUUID()}`;
      const seen = new Set<string>();

      for (let i = 0; i < 25; i += 1) {
        seen.add((await versions.tokenFor([scope]))!);
        await versions.bump(scope);
      }

      expect(seen.size).toBe(25);
    });

    it('asks for nothing when there are no scopes', async () => {
      expect(await versions.tokenFor([])).toBeNull();
    });
  });

  /**
   * The hottest read in the system: every request from every merchant
   * integration used to be a primary-key lookup against Postgres.
   */
  describe('API key authentication cache', () => {
    function store(overrides: { hash: string; expiresAt?: Date | null; revoked?: boolean }): void {
      const key = ApiKey.issue({
        id: ApiKeyId.create(),
        merchantId: randomUUID(),
        name: 'probe',
        keyHash: overrides.hash,
        prefix: 'ph_test_aaaa',
        last4: 'zzzz',
        environment: 'test',
        scopes: ['payments:read'],
        expiresAt: overrides.expiresAt ?? null,
      });

      if (overrides.revoked) {
        key.revoke();
      }

      apiKeyRepository.stored.set(overrides.hash, key);
    }

    it('reads the database once however many requests arrive', async () => {
      const hash = randomUUID();
      store({ hash });

      for (let i = 0; i < 20; i += 1) {
        expect(await apiKeyAuth.resolve(hash)).not.toBeNull();
      }

      expect(apiKeyRepository.lookups).toBe(1);
    });

    /**
     * Without this, an unauthenticated flood of invented keys becomes one
     * Postgres query per attempt — a load amplifier that needs no
     * credentials.
     */
    it('remembers an unknown key, so a credential spray costs one query', async () => {
      const hash = randomUUID();

      for (let i = 0; i < 20; i += 1) {
        expect(await apiKeyAuth.resolve(hash)).toBeNull();
      }

      expect(apiKeyRepository.lookups).toBe(1);
    });

    /**
     * The cache stores facts, not verdicts. Caching "this key is valid"
     * would keep an expired key working for the whole TTL.
     */
    it('still rejects a key that expires while it is cached', async () => {
      const hash = randomUUID();
      store({ hash, expiresAt: new Date(Date.now() + 40) });

      expect((await apiKeyAuth.resolve(hash))!.assertUsable().isOk()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 80));

      const cached = await apiKeyAuth.resolve(hash);
      expect(apiKeyRepository.lookups).toBe(1);
      expect(cached!.assertUsable().isErr()).toBe(true);
    });

    it('carries a revocation through the cache round trip', async () => {
      const hash = randomUUID();
      store({ hash, revoked: true });

      const resolved = await apiKeyAuth.resolve(hash);

      expect(resolved!.assertUsable().isErr()).toBe(true);
    });

    /** What makes revocation immediate rather than TTL-bounded. */
    it('re-reads after an explicit invalidation', async () => {
      const hash = randomUUID();
      store({ hash });
      await apiKeyAuth.resolve(hash);

      await apiKeyAuth.invalidate(hash);
      await apiKeyAuth.resolve(hash);

      expect(apiKeyRepository.lookups).toBe(2);
    });

    /** Redis keys surface in MONITOR, slow logs and RDB snapshots. */
    it('never puts the presented secret in a key', async () => {
      const hash = randomUUID();
      store({ hash });
      await apiKeyAuth.resolve(hash);

      const keys = await redis.client.keys('*');
      expect(keys.some((key) => key.includes(hash))).toBe(true);
      expect(keys.every((key) => !key.includes('ph_test_'))).toBe(true);
    });
  });

  /**
   * Serving stale data instead of making everyone wait.
   *
   * `getOrSet` already stops a stampede from reaching the database, but
   * the readers that lose the race still wait for the winner — the old
   * value is gone, because expiry deleted it. Under
   * `getOrRevalidate` the value outlives its freshness, so the losers
   * are answered from the stale copy at once and one of them refreshes
   * behind the response.
   *
   * Against a real Redis because the election is a `SET NX` and the
   * point of the test is what happens when several callers race it.
   */
  describe('stale-while-revalidate', () => {
    /**
     * A key per test, deliberately.
     *
     * A background refresh outlives the call that triggered it — that is
     * the whole design — so one test's refresh can land after the next
     * test's `flushdb` and write a value the next test never asked for.
     * It showed up as a failure only in the full file and never alone.
     * Isolating by key is the honest fix; sharing one would just be a
     * slower way to be flaky.
     */
    let KEY = 'swr:report';

    beforeEach(() => {
      KEY = `swr:report:${randomUUID()}`;
    });

    /** A loader that counts its calls and is slow enough to race against. */
    const countingLoader = (value: () => string, ms = 150) => {
      const calls = { n: 0 };
      return {
        calls,
        load: async () => {
          calls.n += 1;
          await delay(ms);
          return value();
        },
      };
    };

    it('blocks only on a key that is genuinely absent', async () => {
      const loader = countingLoader(() => 'first', 50);

      const value = await cache.getOrRevalidate(KEY, loader.load, {
        freshSec: 1,
        staleSec: 60,
      });

      expect(value).toBe('first');
      expect(loader.calls.n).toBe(1);
    });

    it('serves the stale copy immediately once it is no longer fresh', async () => {
      let version = 1;
      const loader = countingLoader(() => `v${version}`, 200);

      await cache.getOrRevalidate(KEY, loader.load, { freshSec: 1, staleSec: 60 });
      await delay(1_100);
      version = 2;

      const startedAt = Date.now();
      const value = await cache.getOrRevalidate(KEY, loader.load, {
        freshSec: 1,
        staleSec: 60,
      });
      const elapsed = Date.now() - startedAt;

      // The stale answer, not the 200 ms the refresh takes.
      expect(value).toBe('v1');
      expect(elapsed).toBeLessThan(100);
    });

    it('refreshes exactly once however many readers find it stale', async () => {
      let version = 1;
      const loader = countingLoader(() => `v${version}`, 150);

      await cache.getOrRevalidate(KEY, loader.load, { freshSec: 1, staleSec: 60 });
      await delay(1_100);
      version = 2;

      const readers = await Promise.all(
        Array.from({ length: 20 }, () =>
          cache.getOrRevalidate(KEY, loader.load, { freshSec: 1, staleSec: 60 }),
        ),
      );

      // Every reader got the old value without waiting...
      expect(readers.every((value) => value === 'v1')).toBe(true);
      await delay(400);
      // ...and the cold load plus exactly one refresh is all the loader saw.
      expect(loader.calls.n).toBe(2);
    });

    it('serves the new value once the refresh lands', async () => {
      let version = 1;
      const loader = countingLoader(() => `v${version}`, 50);

      await cache.getOrRevalidate(KEY, loader.load, { freshSec: 1, staleSec: 60 });
      await delay(1_100);
      version = 2;

      await cache.getOrRevalidate(KEY, loader.load, { freshSec: 1, staleSec: 60 });
      await delay(400);

      await expect(
        cache.getOrRevalidate(KEY, loader.load, { freshSec: 1, staleSec: 60 }),
      ).resolves.toBe('v2');
    });

    /**
     * The property that makes this worth having: a dependency that is
     * down degrades freshness, not availability.
     */
    it('keeps answering from the stale copy when the refresh fails', async () => {
      const loader = countingLoader(() => 'good', 10);

      await cache.getOrRevalidate(KEY, loader.load, { freshSec: 1, staleSec: 60 });
      await delay(1_100);

      const failing = async (): Promise<string | null> => {
        throw new Error('dependency is down');
      };

      await expect(
        cache.getOrRevalidate<string>(KEY, failing, { freshSec: 1, staleSec: 60 }),
      ).resolves.toBe('good');
      await delay(200);
      await expect(
        cache.getOrRevalidate<string>(KEY, failing, { freshSec: 1, staleSec: 60 }),
      ).resolves.toBe('good');
    });
  });

  /**
   * The daily token budget, under concurrency.
   *
   * It used to read the remaining allowance and compare it to the
   * estimate — check-then-act across two round trips, so several
   * questions arriving together all saw the same remaining budget and
   * all decided they fit. The rate limiter in front bounded how badly
   * that could go, which made the budget soft rather than absent; the
   * agent loop then made a single question worth several billed calls
   * instead of one, which is a different size of soft.
   *
   * The estimate is now held before the call and reconciled against the
   * real usage afterwards, the same way a wallet holds a pending amount.
   */
  describe('assistant token budget', () => {
    const USER = () => `budget-user-${randomUUID()}`;

    it('admits a request that fits', async () => {
      await expect(budget.authorizeOrThrow(USER(), 400)).resolves.toBeUndefined();
    });

    it('refuses one that does not', async () => {
      await expect(budget.authorizeOrThrow(USER(), 2_000)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
    });

    it('does not spend the budget of a request it refused', async () => {
      const user = USER();

      await expect(budget.authorizeOrThrow(user, 2_000)).rejects.toThrow();

      expect(await budget.remaining(user)).toBe(1_000);
    });

    /** The race the reservation exists for. */
    it('admits only what the budget covers when requests arrive together', async () => {
      const user = USER();

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () =>
          budget
            .authorizeOrThrow(user, 400)
            .then(() => 'admitted' as const)
            .catch(() => 'refused' as const),
        ),
      );

      // 1000 tokens, 400 apiece: two fit and no more.
      expect(outcomes.filter((outcome) => outcome === 'admitted')).toHaveLength(2);
    });

    /**
     * A question that fails costs nothing.
     *
     * The hold is taken before each billed request and settled by
     * `record` when the usage comes back. A request that throws has no
     * usage, so nothing settled it and the estimate stayed charged for
     * the rest of the day — a provider outage would have spent a
     * user's whole allowance on answers they never received, and the
     * agent loop holds once per iteration, so a failure on the third
     * turn leaked all three.
     */
    it('gives the hold back when nothing was billed', async () => {
      const user = USER();

      await budget.authorizeOrThrow(user, 400);
      await budget.releaseHeld(user);

      expect(await budget.remaining(user)).toBe(1_000);
    });

    it('gives back every hold a multi-turn run took', async () => {
      const user = USER();

      await budget.authorizeOrThrow(user, 300);
      await budget.authorizeOrThrow(user, 300);
      await budget.releaseHeld(user);

      expect(await budget.remaining(user)).toBe(1_000);
    });

    /** `record` drains the hold, so releasing afterwards must be a no-op. */
    it('does not refund a hold that was already settled', async () => {
      const user = USER();

      await budget.authorizeOrThrow(user, 400);
      await budget.record(user, 'test-model', {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      await budget.releaseHeld(user);

      expect(await budget.remaining(user)).toBe(880);
    });

    it('is safe to call when nothing is held', async () => {
      const user = USER();

      await budget.releaseHeld(user);

      expect(await budget.remaining(user)).toBe(1_000);
    });

    it('settles the hold against what was actually billed', async () => {
      const user = USER();

      await budget.authorizeOrThrow(user, 400);
      await budget.record(user, 'test-model', {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });

      // Charged the real 120, not the 400 held.
      expect(await budget.remaining(user)).toBe(880);
    });

    it('keeps every hold when one question authorises several times', async () => {
      const user = USER();

      await budget.authorizeOrThrow(user, 300);
      await budget.authorizeOrThrow(user, 300);

      // Both held: a third would take it past the budget.
      await expect(budget.authorizeOrThrow(user, 500)).rejects.toThrow();
    });
  });
});
