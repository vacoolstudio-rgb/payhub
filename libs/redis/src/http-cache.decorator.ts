import { SetMetadata } from '@nestjs/common';

export const HTTP_CACHE_METADATA = 'payhub:http-cache';

/** What the scope resolver is given about the current request. */
export interface HttpCacheRequestContext {
  readonly principalId: string;
  readonly merchantId: string | null;
  readonly params: Record<string, string>;
  readonly query: Record<string, unknown>;
}

export interface HttpCacheOptions {
  /**
   * The resource scopes this response is derived from, resolved per
   * request. Any write that bumps one of these invalidates the `ETag`.
   */
  readonly scopes: (context: HttpCacheRequestContext) => string[];

  /**
   * `private` keeps the response out of shared caches. It is the default,
   * and for anything derived from an account it is the only correct
   * answer: a CDN or corporate proxy must never hold one customer's
   * balance where another customer's request could match it.
   */
  readonly visibility?: 'private' | 'public';

  /**
   * Seconds the client may reuse the response without asking. Defaults to
   * 0 — the client keeps the body but revalidates every time, which is
   * what turns a repeat request into a cheap 304 rather than a stale
   * balance.
   */
  readonly maxAgeSec?: number;
}

/**
 * Marks a read endpoint as conditionally cacheable.
 *
 * ```ts
 * @HttpCache({ scopes: (ctx) => [`wallets:${ctx.principalId}`] })
 * @Get()
 * list() { … }
 * ```
 *
 * See `HttpCacheInterceptor` for what this buys and what it deliberately
 * refuses to do.
 */
export const HttpCache = (options: HttpCacheOptions) =>
  SetMetadata(HTTP_CACHE_METADATA, options);
