import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '@payhub/redis';
import { ApiKey, ApiKeyId, type ApiScope } from '../domain/api-key.aggregate.js';
import { API_KEY_REPOSITORY, type ApiKeyRepository } from '../domain/identity.ports.js';

/**
 * Exactly the columns needed to rebuild the aggregate, as plain JSON.
 *
 * The cache holds *facts*, never a verdict. Storing "this key is valid"
 * would mean a key stays valid for the whole TTL after it expires; storing
 * `expiresAt` means the expiry is re-evaluated by the domain on every
 * single request and the cache can only ever save a query.
 */
interface CachedApiKey {
  readonly id: string;
  readonly merchantId: string;
  readonly name: string;
  readonly keyHash: string;
  readonly prefix: string;
  readonly last4: string;
  readonly environment: 'live' | 'test';
  readonly scopes: ApiScope[];
  readonly revokedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

/**
 * Resolves a presented API key to its aggregate, with a cache in front.
 *
 * This is the hottest uncached read in the system. A bearer token is
 * verified with arithmetic; an API key was a primary-key lookup against
 * Postgres on *every* request from *every* merchant integration — the one
 * query that scales with total traffic rather than with writes.
 *
 * The caching strategy is deliberately not the dashboard's:
 *
 * - **Short TTL.** 30 seconds, not the minutes a merchant's configuration
 *   gets. The TTL is not a performance knob here, it is the bound on how
 *   long a revoked credential keeps working if an invalidation is ever
 *   missed. Explicit invalidation on revoke is the mechanism; the TTL is
 *   the backstop.
 * - **Negative caching, on purpose.** Unknown keys are remembered too.
 *   Without it, anyone can aim an unauthenticated flood of invented keys
 *   at any endpoint and turn it into one Postgres query per attempt — a
 *   load amplifier that needs no credentials at all. With it, a spray
 *   costs a Redis lookup.
 * - **Keyed by the hash.** Never by the presented secret. Redis is not a
 *   credential store: its keys surface in `MONITOR`, in slow logs and in
 *   RDB snapshots.
 */
@Injectable()
export class ApiKeyAuthenticator {
  /** Short enough that a missed invalidation is an incident, not a breach. */
  private static readonly TTL_SEC = 30;

  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly keys: ApiKeyRepository,
    private readonly cache: CacheService,
  ) {}

  async resolve(keyHash: string): Promise<ApiKey | null> {
    const cached = await this.cache.getOrSet<CachedApiKey>(
      cacheKey(keyHash),
      async () => {
        const key = await this.keys.findByHash(keyHash);
        return key ? snapshot(key) : null;
      },
      {
        ttlSec: ApiKeyAuthenticator.TTL_SEC,
        // A miss is the common case under a credential spray, so remember
        // it for as long as a hit.
        negativeTtlSec: ApiKeyAuthenticator.TTL_SEC,
        // Collapses the repeated authentications of one burst without
        // meaningfully widening the revocation window.
        l1: true,
      },
    );

    return cached ? rehydrate(cached) : null;
  }

  /** Called after a revoke commits, so the next request misses. */
  async invalidate(keyHash: string): Promise<void> {
    await this.cache.del(cacheKey(keyHash));
  }
}

const cacheKey = (keyHash: string) => `auth:apikey:${keyHash}`;

function snapshot(key: ApiKey): CachedApiKey {
  return {
    id: key.id,
    merchantId: key.merchantId,
    name: key.name,
    keyHash: key.keyHash,
    prefix: key.prefix,
    last4: key.last4,
    environment: key.environment,
    scopes: [...key.scopes],
    revokedAt: key.revokedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  };
}

/**
 * Back through the domain factory rather than hand-building a principal:
 * `assertUsable` stays the single definition of what makes a key usable,
 * and a new rule added to the aggregate applies to cached keys for free.
 */
function rehydrate(cached: CachedApiKey): ApiKey {
  return ApiKey.rehydrate(ApiKeyId.of(cached.id), {
    merchantId: cached.merchantId,
    name: cached.name,
    keyHash: cached.keyHash,
    prefix: cached.prefix,
    last4: cached.last4,
    environment: cached.environment,
    scopes: cached.scopes,
    lastUsedAt: null,
    revokedAt: cached.revokedAt ? new Date(cached.revokedAt) : null,
    expiresAt: cached.expiresAt ? new Date(cached.expiresAt) : null,
    createdAt: new Date(cached.createdAt),
  });
}
