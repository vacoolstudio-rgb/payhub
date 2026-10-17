import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RedisService } from './redis.service.js';

/**
 * Opaque version markers, one per cacheable resource scope.
 *
 * These exist so a conditional `GET` can be answered **without doing the
 * work**. A validator derived from the response body can only be computed
 * after the body exists — guard, query, serialisation, all of it — and then
 * thrown away to send a 304. A validator derived from a version marker is
 * one `MGET` against Redis, so the whole request short-circuits.
 *
 * The value is deliberately opaque rather than a counter. Nothing here
 * needs ordering — an `ETag` is only ever compared for equality — and an
 * `INCR` counter that expired and restarted at 1 would make a client's old
 * `ETag` match again and serve them a stale balance. A random token cannot
 * collide with a previous one, so the worst an expiry can do is cost one
 * extra 200.
 *
 * Scopes are strings like `wallets:<userId>` or `payment:<id>`. Writers bump
 * the scopes they affect; readers fold the current values into the `ETag`.
 */
@Injectable()
export class ResourceVersionService {
  private readonly logger = new Logger(ResourceVersionService.name);

  /**
   * Long, but not infinite. A version key is pure derived state: losing it
   * costs one cache miss, so it does not deserve to live forever in memory.
   */
  private static readonly TTL_SEC = 30 * 24 * 60 * 60;

  constructor(private readonly redis: RedisService) {}

  /**
   * Current markers for every scope, in one round trip.
   *
   * A scope that has never been written is lazily seeded, so repeat reads
   * of an untouched resource still agree on a validator and can still get a
   * 304. Seeding uses `SET NX`: concurrent seeders converge on one value
   * instead of invalidating each other.
   */
  async tokenFor(scopes: readonly string[]): Promise<string | null> {
    if (scopes.length === 0) {
      return null;
    }

    try {
      const keys = scopes.map(key);
      const current = await this.redis.client.mget(...keys);

      // The overwhelmingly common path: every scope has been seen before,
      // so the whole validator is one round trip and no writes.
      if (current.every((value) => value !== null)) {
        return current.join('.');
      }

      const resolved = await Promise.all(
        current.map(async (value, index) => value ?? (await this.seed(keys[index]!))),
      );

      return resolved.join('.');
    } catch (error) {
      // A cache validator is never worth failing a request over. Returning
      // null simply means this response is not conditionally cacheable.
      this.logger.warn(`Version lookup failed: ${describe(error)}`);
      return null;
    }
  }

  /**
   * Marks every listed scope as changed. Callers are write paths, so a
   * failure here must not roll back the write — a missed bump costs
   * staleness bounded by the TTL on the response, not a lost payment.
   */
  async bump(...scopes: string[]): Promise<void> {
    if (scopes.length === 0) {
      return;
    }

    try {
      const pipeline = this.redis.client.pipeline();
      for (const scope of scopes) {
        pipeline.set(key(scope), token(), 'EX', ResourceVersionService.TTL_SEC);
      }
      await pipeline.exec();
    } catch (error) {
      this.logger.warn(`Version bump failed for [${scopes.join(', ')}]: ${describe(error)}`);
    }
  }

  private async seed(versionKey: string): Promise<string> {
    const fresh = token();
    const applied = await this.redis.client.set(
      versionKey,
      fresh,
      'EX',
      ResourceVersionService.TTL_SEC,
      'NX',
    );

    // Lost the race: adopt whatever the winner wrote, so both readers
    // produce the same ETag.
    return applied ? fresh : ((await this.redis.client.get(versionKey)) ?? fresh);
  }
}

const key = (scope: string) => `ver:${scope}`;
const token = () => randomBytes(8).toString('base64url');
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
