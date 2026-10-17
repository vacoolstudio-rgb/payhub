import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { type Observable, of, tap } from 'rxjs';
import {
  HTTP_CACHE_METADATA,
  type HttpCacheOptions,
} from './http-cache.decorator.js';
import { ResourceVersionService } from './resource-version.service.js';

interface HttpRequest {
  method: string;
  originalUrl?: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  user?: { id: string; merchantId?: string };
}

interface HttpResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  getHeader(name: string): unknown;
}

/**
 * Conditional `GET` for read endpoints marked with `@HttpCache`.
 *
 * Express already emits a weak `ETag` and answers `If-None-Match` with a
 * 304 — but only after the handler has run, queried Postgres and
 * serialised a response it then discards. That saves bandwidth and nothing
 * else. Here the validator comes from `ResourceVersionService`, so a
 * revalidation costs one `MGET` and the handler is never invoked.
 *
 * Two things this sets that the framework default does not, and that
 * matter more than the saved query:
 *
 * - `Cache-Control`. Without it a response has no stated freshness and
 *   intermediaries fall back to heuristics — which, for an endpoint
 *   returning a balance, means guessing. `private, no-cache` says exactly
 *   what is true: store it, but never reuse it without asking.
 * - `Vary: Authorization`. The URL is not the cache key here; the bearer
 *   token is part of it. Omitting this is how one customer's statement
 *   gets served to another.
 *
 * The `ETag` also folds in the principal, so even a misconfigured cache
 * that ignored `Vary` could not produce a cross-user hit.
 */
@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly versions: ResourceVersionService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const options = this.reflector.get<HttpCacheOptions | undefined>(
      HTTP_CACHE_METADATA,
      context.getHandler(),
    );

    if (!options || context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequest>();

    // Only safe methods. A conditional header on a write means something
    // entirely different (optimistic concurrency) and is not this.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return next.handle();
    }

    const principalId = request.user?.id ?? 'anonymous';
    const scopes = options.scopes({
      principalId,
      merchantId: request.user?.merchantId ?? null,
      params: request.params ?? {},
      query: request.query ?? {},
    });

    const version = await this.versions.tokenFor(scopes);
    if (version === null) {
      // Redis is unreachable, or the endpoint declared no scope. Serve the
      // request normally rather than inventing a validator we cannot
      // invalidate.
      return next.handle();
    }

    const response = http.getResponse<HttpResponse>();
    const etag = buildEtag({
      path: request.originalUrl ?? request.url,
      principalId,
      query: request.query ?? {},
      version,
    });

    if (matches(request.headers['if-none-match'], etag)) {
      applyHeaders(response, etag, options);
      response.status(304);
      // Returning without calling `next.handle()` is the entire point: the
      // guard has run, but no query, no serialisation, no handler.
      return of(undefined);
    }

    // Applied on success only. A 404 or 403 carries no validator — the
    // error body is not the representation the ETag describes.
    return next.handle().pipe(tap(() => applyHeaders(response, etag, options)));
  }
}

function applyHeaders(response: HttpResponse, etag: string, options: HttpCacheOptions): void {
  const visibility = options.visibility ?? 'private';
  const maxAge = options.maxAgeSec ?? 0;

  response.setHeader(
    'Cache-Control',
    maxAge > 0 ? `${visibility}, max-age=${maxAge}, must-revalidate` : `${visibility}, no-cache`,
  );
  response.setHeader('ETag', etag);
  appendVary(response, 'Authorization');
}

/** `Vary` is additive: CORS and compression already contribute to it. */
function appendVary(response: HttpResponse, field: string): void {
  const current = response.getHeader('Vary');
  const existing =
    typeof current === 'string' ? current.split(',').map((part) => part.trim()) : [];

  if (existing.some((part) => part.toLowerCase() === field.toLowerCase())) {
    return;
  }

  response.setHeader('Vary', [...existing, field].filter(Boolean).join(', '));
}

/**
 * A strong validator: the token is derived from a version marker that only
 * changes when the resource does, so two bodies with the same ETag really
 * are byte-identical.
 */
function buildEtag(input: {
  path: string;
  principalId: string;
  query: Record<string, unknown>;
  version: string;
}): string {
  // The path already contains the query string, but its ordering is the
  // client's choice; canonicalising keeps `?a=1&b=2` and `?b=2&a=1` on one
  // validator instead of two.
  const canonicalQuery = Object.entries(input.query)
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort()
    .join('&');

  const digest = createHash('sha1')
    .update(input.path.split('?')[0] ?? '')
    .update(' ')
    .update(input.principalId)
    .update(' ')
    .update(canonicalQuery)
    .update(' ')
    .update(input.version)
    .digest('base64url');

  return `"${digest}"`;
}

/**
 * `If-None-Match` comparison per RFC 9110: a list, `*` matches anything,
 * and the comparison is weak — `W/"x"` and `"x"` are the same validator
 * for a conditional read.
 */
function matches(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) {
    return false;
  }
  if (raw.trim() === '*') {
    return true;
  }

  const target = stripWeak(etag);
  return raw
    .split(',')
    .map((candidate) => stripWeak(candidate.trim()))
    .some((candidate) => candidate === target);
}

const stripWeak = (value: string) => (value.startsWith('W/') ? value.slice(2) : value);
