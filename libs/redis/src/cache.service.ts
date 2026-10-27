import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LruCache } from '@payhub/shared';
import { RedisService } from './redis.service.js';

export interface CacheOptions {
  readonly ttlSec: number;
  /**
   * Keep the value in the per-process L1 cache as well. Off by default:
   * see the note on `L1` below for when it is safe.
   */
  readonly l1?: boolean;
  /** Relative spread of the TTL. Defaults to 10 %. */
  readonly jitterRatio?: number;
  /** How long "this key has no value" is remembered. Defaults to 30 s. */
  readonly negativeTtlSec?: number;
}

export interface RevalidateOptions {
  /** How long the value is served without any refresh at all. */
  readonly freshSec: number;
  /**
   * How much longer a stale copy may be served while one refresh runs.
   * This is the window the whole design buys: beyond it, readers block.
   */
  readonly staleSec: number;
  readonly l1?: boolean;
  readonly jitterRatio?: number;
  readonly negativeTtlSec?: number;
}

/** What `getOrRevalidate` stores: the value, plus when it stops being fresh. */
interface Envelope<T> {
  readonly v: T;
  /** Epoch milliseconds. */
  readonly f: number;
}

/**
 * Sentinel for a cached absence. Chosen so it can never collide with JSON.
 *
 * Written as an escape rather than the byte itself. A literal NUL is the
 * same string at runtime and a different file on disk: git classified
 * the whole module as binary, so it had no diffs and no blame, and grep
 * skipped it in silence - a search for `getOrSet` across the repository
 * did not list its own definition.
 */
const NEGATIVE_MARKER = '\u0000__miss__';

/** Atomic compare-and-delete: only the owner of the token releases the lock. */
const RELEASE_IF_OWNER = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

/**
 * Cache-aside with the three classic failure modes handled explicitly.
 *
 * **Stampede / dog-piling** — when a hot key expires every concurrent reader
 * misses and hits the database at once. Two layers of defence: an in-process
 * promise map collapses concurrent callers inside one node, and a short Redis
 * lock elects a single node to recompute while the others wait and re-read.
 *
 * **Penetration** — lookups for a key that genuinely does not exist never
 * populate the cache, so the database absorbs the traffic (and an attacker
 * can aim it). A negative marker with a short TTL absorbs it instead.
 *
 * **Avalanche** — keys populated together expire together. Jittered TTLs
 * spread the expiry over a window instead of a single instant.
 */
/**
 * L1 lifetime.
 *
 * Deliberately about a second. An in-process cache cannot be invalidated
 * from another replica: when a payment settles, *this* pod evicts the key
 * and the other three keep serving their own copies until it expires. So
 * L1 is not a cache in the usual sense — it is a coalescing window that
 * collapses the repeated reads of one page render (and takes the hot key
 * off Redis), bounded tightly enough that no user notices the staleness.
 */
const L1_TTL_MS = 1_000;
const L1_MAX_ENTRIES = 5_000;

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  /** Single-flight within this process. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  /** Tier 1: this process. Tier 2: Redis. */
  private readonly l1 = new LruCache<unknown>({
    maxEntries: L1_MAX_ENTRIES,
    ttlMs: L1_TTL_MS,
  });

  constructor(private readonly redis: RedisService) {}

  /** `undefined` = not cached, `null` = cached absence. */
  async get<T>(key: string): Promise<T | null | undefined> {
    const local = this.l1.get(key);
    if (local !== undefined) {
      return local as T | null;
    }

    const raw = await this.redis.client.get(key);
    if (raw === null) {
      return undefined;
    }
    if (raw === NEGATIVE_MARKER) {
      return null;
    }
    return JSON.parse(raw) as T;
  }

  async set<T>(key: string, value: T, options: CacheOptions): Promise<void> {
    await this.redis.client.set(key, JSON.stringify(value), 'EX', jitteredTtl(options));

    if (options.l1) {
      this.l1.set(key, value);
    }
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.l1.delete(key);
    }
    if (keys.length > 0) {
      await this.redis.client.del(...keys);
    }
  }

  /** Observability for the L1 tier; surfaced by the metrics endpoint. */
  localStats() {
    return this.l1.stats();
  }

  /**
   * Pattern invalidation through SCAN, never `KEYS`.
   *
   * `KEYS *` is O(n) *and* blocks the single-threaded server for the whole
   * scan — on a large instance that is an outage, not a query. `UNLINK`
   * frees the memory on a background thread.
   */
  async invalidatePattern(pattern: string, batchSize = 500): Promise<number> {
    const stream = this.redis.client.scanStream({
      match: this.redis.prefixed(pattern),
      count: batchSize,
    });

    // The local tier is evicted by the same pattern, translated into a
    // prefix test — `SCAN` globs and `String.startsWith` agree for the
    // trailing-`*` patterns this code base uses.
    const prefix = pattern.replace(/\*+$/, '');
    this.l1.deleteWhere((key) => key.startsWith(prefix));

    let removed = 0;
    for await (const keys of stream as AsyncIterable<string[]>) {
      if (keys.length === 0) {
        continue;
      }
      // SCAN returns fully prefixed keys; ioredis would prefix them again.
      await this.redis.client.unlink(
        ...keys.map((key) => stripPrefix(key, this.redis.keyPrefix)),
      );
      removed += keys.length;
    }
    return removed;
  }

  async getOrSet<T>(
    key: string,
    loader: () => Promise<T | null>,
    options: CacheOptions,
  ): Promise<T | null> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const existing = this.inflight.get(key) as Promise<T | null> | undefined;
    if (existing) {
      return existing;
    }

    const promise = this.loadWithLock(key, loader, options).finally(() =>
      this.inflight.delete(key),
    );
    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Cache-aside that never makes a reader wait for a refresh.
   *
   * `getOrSet` already collapses a stampede — one process-local promise,
   * one Redis lock across nodes — but collapsing is not the same as not
   * waiting. When a hot key expires, the single winner recomputes and
   * every other caller sits in a 50 ms poll loop for up to half a second,
   * because the old value is gone: expiry deleted it. The load on the
   * service behind the cache is bounded; the latency of everyone else is
   * not, and if the loader is slower than the wait they all fall through
   * and recompute anyway.
   *
   * So the value outlives its freshness. It is stored with a physical TTL
   * of `freshSec + staleSec` and a logical `fresh until` stamp inside it.
   * Past the stamp the copy is still returned — immediately — and one
   * caller is elected to refresh in the background. Readers only ever
   * block on a key that is genuinely absent.
   *
   * The cost is honest and worth naming: a reader can be served data up
   * to `staleSec` old. That makes this right for aggregates and
   * configuration, and wrong for a balance — which is why it is a second
   * method rather than a change to the first.
   */
  async getOrRevalidate<T>(
    key: string,
    loader: () => Promise<T | null>,
    options: RevalidateOptions,
  ): Promise<T | null> {
    const stored = await this.get<unknown>(key);

    if (stored === null) {
      return null; // A cached absence is still an answer.
    }

    // Only a value this method wrote can be read as one. `getOrSet`
    // stores the bare value under the same key space, and reading that
    // as an envelope yields `undefined` typed as `T` — a missing
    // balance delivered silently, with nothing to indicate it came from
    // the cache rather than the database. Nothing uses a key both ways
    // today; this is here so that doing it later is a cache miss rather
    // than a wrong answer.
    const envelope = isEnvelope<T>(stored) ? stored : undefined;

    if (stored !== undefined && envelope === undefined) {
      // Evicted rather than read: the cold path below delegates to
      // `getOrSet`, which would hit this same foreign value and hand
      // back `undefined` again.
      await this.del(key);
    }

    if (envelope !== undefined) {
      if (envelope.f > Date.now()) {
        return envelope.v;
      }

      // Stale. Answer now, refresh behind the response. The lock means
      // one node does it however many are reading, and a failure leaves
      // the stale copy in place until its physical TTL runs out.
      void this.refreshInBackground(key, loader, options);
      return envelope.v;
    }

    // Cold. Block, but only once: `getOrSet` already elects a single
    // loader per process and a single node across the cluster. The
    // envelope is written here too, or the next read would find a bare
    // value where it expects a freshness stamp.
    const loaded = await this.getOrSet<Envelope<T>>(
      key,
      async () => {
        const value = await loader();
        return value === null || value === undefined
          ? null
          : { v: value, f: Date.now() + options.freshSec * 1_000 };
      },
      {
        ttlSec: options.freshSec + options.staleSec,
        ...(options.l1 !== undefined ? { l1: options.l1 } : {}),
        ...(options.jitterRatio !== undefined ? { jitterRatio: options.jitterRatio } : {}),
        ...(options.negativeTtlSec !== undefined
          ? { negativeTtlSec: options.negativeTtlSec }
          : {}),
      },
    );

    return loaded === null ? null : loaded.v;
  }

  /**
   * One refresh at a time, and never on the caller's clock.
   *
   * Nothing awaits this, so it must not be able to reject: an unhandled
   * rejection takes the process down under the default Node policy, and
   * a cache refresh is the last thing that should.
   */
  private async refreshInBackground<T>(
    key: string,
    loader: () => Promise<T | null>,
    options: RevalidateOptions,
  ): Promise<void> {
    const lockKey = `${key}:refresh`;
    const token = randomUUID();

    try {
      const acquired = await this.redis.client.set(lockKey, token, 'PX', 10_000, 'NX');
      if (!acquired) {
        return;
      }

      try {
        const value = await loader();
        if (value === null || value === undefined) {
          await this.redis.client.set(key, NEGATIVE_MARKER, 'EX', options.negativeTtlSec ?? 30);
          this.l1.delete(key);
          return;
        }

        await this.storeEnvelope(key, value, options);
      } finally {
        await this.redis.client.eval(RELEASE_IF_OWNER, 1, lockKey, token);
      }
    } catch (error) {
      // The stale value stays readable until its physical TTL, which is
      // the entire point: a failing dependency degrades freshness rather
      // than availability.
      this.logger.warn(
        `Background refresh of "${key}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async storeEnvelope<T>(
    key: string,
    value: T,
    options: RevalidateOptions,
  ): Promise<void> {
    const envelope: Envelope<T> = { v: value, f: Date.now() + options.freshSec * 1_000 };

    await this.set(key, envelope, {
      ttlSec: options.freshSec + options.staleSec,
      ...(options.l1 !== undefined ? { l1: options.l1 } : {}),
      ...(options.jitterRatio !== undefined ? { jitterRatio: options.jitterRatio } : {}),
    });
  }

  private async loadWithLock<T>(
    key: string,
    loader: () => Promise<T | null>,
    options: CacheOptions,
  ): Promise<T | null> {
    const lockKey = `${key}:lock`;
    const token = randomUUID();
    const acquired = await this.redis.client.set(lockKey, token, 'PX', 5_000, 'NX');

    if (!acquired) {
      // Another node is recomputing. Wait for its result instead of piling
      // onto the database behind it.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await delay(50);
        const value = await this.get<T>(key);
        if (value !== undefined) {
          return value;
        }
      }
      this.logger.debug(`Stampede wait timed out for "${key}", recomputing locally`);
    }

    try {
      const value = await loader();

      if (value === null || value === undefined) {
        await this.redis.client.set(
          key,
          NEGATIVE_MARKER,
          'EX',
          options.negativeTtlSec ?? 30,
        );
        if (options.l1) {
          this.l1.set(key, null);
        }
        return null;
      }

      await this.set(key, value, options);
      return value;
    } finally {
      if (acquired) {
        // Raw key: ioredis prefixes EVAL's KEYS array for us.
        await this.redis.client.eval(RELEASE_IF_OWNER, 1, lockKey, token);
      }
    }
  }
}

function jitteredTtl(options: CacheOptions): number {
  const ratio = options.jitterRatio ?? 0.1;
  const spread = options.ttlSec * ratio;
  return Math.max(1, Math.round(options.ttlSec + (Math.random() * 2 - 1) * spread));
}

function stripPrefix(key: string, prefix: string): string {
  return key.startsWith(`${prefix}:`) ? key.slice(prefix.length + 1) : key;
}

/** A value written by `getOrRevalidate`, as opposed to anything else. */
function isEnvelope<T>(value: unknown): value is Envelope<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'v' in value &&
    typeof (value as { f?: unknown }).f === 'number'
  );
}
