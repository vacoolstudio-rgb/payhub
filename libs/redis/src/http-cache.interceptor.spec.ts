import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of } from 'rxjs';
import type { HttpCacheOptions } from './http-cache.decorator.js';
import { HttpCacheInterceptor } from './http-cache.interceptor.js';
import type { ResourceVersionService } from './resource-version.service.js';

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
}

function build(options: {
  metadata?: HttpCacheOptions;
  method?: string;
  ifNoneMatch?: string;
  version?: string | null;
  user?: { id: string; merchantId?: string };
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  handler?: () => unknown;
}) {
  const response: FakeResponse = { statusCode: 200, headers: {} };

  const request = {
    method: options.method ?? 'GET',
    originalUrl: '/api/v1/wallets',
    url: '/api/v1/wallets',
    params: options.params ?? {},
    query: options.query ?? {},
    headers: options.ifNoneMatch ? { 'if-none-match': options.ifNoneMatch } : {},
    user: options.user ?? { id: 'user-1' },
  };

  const reflector = { get: vi.fn().mockReturnValue(options.metadata) } as unknown as Reflector;

  const versions = {
    tokenFor: vi.fn().mockResolvedValue(options.version === undefined ? 'v1' : options.version),
    bump: vi.fn(),
  } as unknown as ResourceVersionService;

  const handler = vi.fn(() => of(options.handler ? options.handler() : { balance: '10.00' }));

  const context = {
    getType: () => 'http',
    getHandler: () => () => undefined,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({
        status: (code: number) => (response.statusCode = code),
        setHeader: (name: string, value: string) => (response.headers[name] = value),
        getHeader: (name: string) => response.headers[name],
      }),
    }),
  } as never;

  const interceptor = new HttpCacheInterceptor(reflector, versions);

  return {
    response,
    versions,
    handler,
    run: async () =>
      firstValueFrom(await interceptor.intercept(context, { handle: handler } as never)),
  };
}

const scoped: HttpCacheOptions = { scopes: () => ['wallets:user-1'] };

describe('HttpCacheInterceptor', () => {
  let etag: string;

  beforeEach(async () => {
    const first = build({ metadata: scoped });
    await first.run();
    etag = first.response.headers['ETag']!;
  });

  describe('when the representation is unchanged', () => {
    /**
     * The whole point. Express also answers a conditional GET with a 304,
     * but only after the handler has queried Postgres and serialised a
     * body it then discards.
     */
    it('answers 304 without invoking the handler at all', async () => {
      const probe = build({ metadata: scoped, ifNoneMatch: etag });

      await probe.run();

      expect(probe.response.statusCode).toBe(304);
      expect(probe.handler).not.toHaveBeenCalled();
    });

    it('still sends the validator and the caching policy on the 304', async () => {
      const probe = build({ metadata: scoped, ifNoneMatch: etag });

      await probe.run();

      expect(probe.response.headers).toMatchObject({
        ETag: etag,
        'Cache-Control': 'private, no-cache',
        Vary: 'Authorization',
      });
    });

    /** RFC 9110: `If-None-Match` is a list, and `*` matches anything. */
    it.each([
      ['a list containing the tag', `"other", ${'ETAG'}`],
      ['a weak form of the tag', `W/${'ETAG'}`],
      ['a wildcard', '*'],
    ])('accepts %s', async (_label, template) => {
      const probe = build({
        metadata: scoped,
        ifNoneMatch: template.replace('ETAG', etag),
      });

      await probe.run();

      expect(probe.response.statusCode).toBe(304);
    });

    it('ignores a validator for a different representation', async () => {
      const probe = build({ metadata: scoped, ifNoneMatch: '"somebody-elses-etag"' });

      await probe.run();

      expect(probe.response.statusCode).toBe(200);
      expect(probe.handler).toHaveBeenCalled();
    });
  });

  describe('the validator', () => {
    it('changes when the resource version changes', async () => {
      const after = build({ metadata: scoped, version: 'v2' });

      await after.run();

      expect(after.response.headers['ETag']).not.toBe(etag);
    });

    /**
     * Defence in depth behind `Vary`. Even a cache that ignored `Vary`
     * could not turn one customer's validator into another's hit.
     */
    it('is different for a different principal on the same URL', async () => {
      const other = build({ metadata: scoped, user: { id: 'user-2' } });

      await other.run();

      expect(other.response.headers['ETag']).not.toBe(etag);
    });

    it('is stable across query parameter ordering', async () => {
      const a = build({ metadata: scoped, query: { currency: 'USD', limit: '25' } });
      const b = build({ metadata: scoped, query: { limit: '25', currency: 'USD' } });

      await a.run();
      await b.run();

      expect(a.response.headers['ETag']).toBe(b.response.headers['ETag']);
    });

    it('distinguishes different query parameters', async () => {
      const usd = build({ metadata: scoped, query: { currency: 'USD' } });
      const eur = build({ metadata: scoped, query: { currency: 'EUR' } });

      await usd.run();
      await eur.run();

      expect(usd.response.headers['ETag']).not.toBe(eur.response.headers['ETag']);
    });
  });

  describe('headers', () => {
    /** A balance in a shared cache is somebody else's balance eventually. */
    it('marks an authenticated response private and non-reusable by default', async () => {
      const probe = build({ metadata: scoped });

      await probe.run();

      expect(probe.response.headers['Cache-Control']).toBe('private, no-cache');
    });

    it('honours an explicit freshness lifetime', async () => {
      const probe = build({
        metadata: { scopes: () => ['rates'], visibility: 'public', maxAgeSec: 300 },
      });

      await probe.run();

      expect(probe.response.headers['Cache-Control']).toBe('public, max-age=300, must-revalidate');
    });

    it('appends to an existing Vary rather than replacing it', async () => {
      const probe = build({ metadata: scoped });
      probe.response.headers['Vary'] = 'Origin, Accept-Encoding';

      await probe.run();

      expect(probe.response.headers['Vary']).toBe('Origin, Accept-Encoding, Authorization');
    });

    it('does not duplicate Vary on a header that already lists it', async () => {
      const probe = build({ metadata: scoped });
      probe.response.headers['Vary'] = 'authorization';

      await probe.run();

      expect(probe.response.headers['Vary']).toBe('authorization');
    });

    /**
     * An error response is not the representation the validator describes,
     * and tagging it would let a client cache a 404 as if it were data.
     */
    it('attaches no validator when the handler fails', async () => {
      const probe = build({ metadata: scoped });
      probe.handler.mockImplementation(() => {
        throw new Error('not found');
      });

      await expect(probe.run()).rejects.toThrow('not found');
      expect(probe.response.headers['ETag']).toBeUndefined();
    });
  });

  describe('when it must stay out of the way', () => {
    it('ignores an endpoint that did not opt in', async () => {
      const probe = build({ ifNoneMatch: etag });

      await probe.run();

      expect(probe.handler).toHaveBeenCalled();
      expect(probe.response.headers['ETag']).toBeUndefined();
    });

    /** A conditional header on a write means optimistic concurrency, not this. */
    it.each(['POST', 'PATCH', 'DELETE'])('ignores a %s', async (method) => {
      const probe = build({ metadata: scoped, method, ifNoneMatch: etag });

      await probe.run();

      expect(probe.handler).toHaveBeenCalled();
      expect(probe.response.statusCode).toBe(200);
    });

    /**
     * A validator we cannot invalidate is worse than none: Redis being
     * down must degrade to uncached reads, never to stale ones.
     */
    it('serves normally when the version store is unavailable', async () => {
      const probe = build({ metadata: scoped, version: null, ifNoneMatch: etag });

      await probe.run();

      expect(probe.handler).toHaveBeenCalled();
      expect(probe.response.statusCode).toBe(200);
      expect(probe.response.headers['ETag']).toBeUndefined();
    });
  });
});
