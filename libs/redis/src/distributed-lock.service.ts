import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RedisService } from './redis.service.js';

export interface LockHandle {
  readonly key: string;
  readonly token: string;
  /**
   * Monotonically increasing number handed out with the lock.
   *
   * This is Martin Kleppmann's answer to the Redlock critique: a lock can
   * always expire while the holder is paused (GC, VM freeze, network
   * partition), so mutual exclusion alone is not safe. The protected resource
   * must *reject* a write carrying a token lower than the highest it has
   * already seen. Without fencing, a distributed lock is an optimisation, not
   * a correctness guarantee.
   */
  readonly fencingToken: bigint;
  readonly expiresAt: number;
}

export interface AcquireOptions {
  readonly ttlMs: number;
  /** Total time to keep retrying before giving up. 0 = fail fast. */
  readonly waitMs?: number;
  readonly retryDelayMs?: number;
  /** Renew the lease in the background while the callback runs. */
  readonly autoExtend?: boolean;
}

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

const EXTEND_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

/**
 * Single-instance Redis lock ("Redlock-lite") with fencing tokens.
 *
 * Deliberately *not* the 5-node Redlock algorithm. Kleppmann's objection
 * stands: Redlock's safety argument depends on bounded clock drift and
 * bounded process pauses, neither of which hold on real hardware. Running it
 * against five nodes buys availability, not correctness.
 *
 * So the policy in this code base is:
 *   • efficiency locks (do not run the same cron on 3 pods) → this service,
 *     which is cheap and good enough because a double run is merely wasteful;
 *   • correctness locks (do not double-spend a wallet) → Postgres row locks
 *     inside the same transaction as the write, where the lock and the data
 *     share a failure domain.
 *
 * `fencingToken` lets a caller bridge the two when a resource can check it.
 */
@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  constructor(private readonly redis: RedisService) {}

  async acquire(key: string, options: AcquireOptions): Promise<LockHandle | null> {
    const lockKey = `lock:${key}`;
    const token = randomUUID();
    const deadline = Date.now() + (options.waitMs ?? 0);
    const retryDelayMs = options.retryDelayMs ?? 50;

    do {
      const acquired = await this.redis.client.set(lockKey, token, 'PX', options.ttlMs, 'NX');

      if (acquired) {
        // INCR is atomic and never reused, which is exactly what a fencing
        // token needs. It survives failover as long as the counter key does.
        const fencingToken = BigInt(await this.redis.client.incr(`fence:${key}`));

        return {
          key: lockKey,
          token,
          fencingToken,
          expiresAt: Date.now() + options.ttlMs,
        };
      }

      if (Date.now() >= deadline) {
        return null;
      }
      await delay(retryDelayMs + Math.floor(Math.random() * retryDelayMs));
    } while (Date.now() < deadline);

    return null;
  }

  async release(handle: LockHandle): Promise<boolean> {
    const result = await this.redis.client.eval(
      RELEASE_SCRIPT,
      1,
      handle.key,
      handle.token,
    );
    return result === 1;
  }

  async extend(handle: LockHandle, ttlMs: number): Promise<boolean> {
    const result = await this.redis.client.eval(
      EXTEND_SCRIPT,
      1,
      handle.key,
      handle.token,
      ttlMs.toString(),
    );
    return result === 1;
  }

  /**
   * Runs `work` while holding the lock, or returns `null` when the lock is
   * held elsewhere. With `autoExtend` a watchdog renews the lease at a third
   * of the TTL so a long job is not evicted mid-flight.
   */
  async withLock<T>(
    key: string,
    options: AcquireOptions,
    work: (handle: LockHandle) => Promise<T>,
  ): Promise<T | null> {
    const handle = await this.acquire(key, options);

    if (!handle) {
      this.logger.debug(`Lock "${key}" is held by another instance — skipping`);
      return null;
    }

    const watchdog = options.autoExtend
      ? setInterval(() => {
          void this.extend(handle, options.ttlMs).then((renewed) => {
            if (!renewed) {
              this.logger.warn(`Lost lock "${key}" while the job was still running`);
            }
          });
        }, Math.max(1_000, Math.floor(options.ttlMs / 3)))
      : undefined;

    watchdog?.unref();

    try {
      return await work(handle);
    } finally {
      if (watchdog) {
        clearInterval(watchdog);
      }
      await this.release(handle);
    }
  }
}
