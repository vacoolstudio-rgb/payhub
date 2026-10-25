import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { HttpMetricsMiddleware } from './http-metrics.middleware.js';
import { MetricsService } from './metrics.service.js';

const CONFIG = { serviceName: 'test', serviceVersion: '0', nodeEnv: 'test' } as never;

/**
 * What the dashboard is told, against what was actually sent.
 *
 * This lived in an interceptor and got both halves wrong. On the error
 * path it read a `status` property off the thrown value — an
 * `HttpException` has one, a `DomainError` does not, since its status
 * is decided later by the problem-details mapper — so every domain
 * error was counted as a 500. And guards run before interceptors, so a
 * rejected request produced no series at all.
 *
 * Measured against the running API before the change: a missing
 * payment answered 404 and incremented the 500 series; an
 * unauthenticated call answered 401 and incremented nothing.
 */
describe('HttpMetricsMiddleware', () => {
  let metrics: MetricsService;
  let middleware: HttpMetricsMiddleware;
  let finish: () => void;

  const run = (request: Partial<Request>, statusCode: number): void => {
    const response = {
      statusCode,
      once: (event: string, listener: () => void) => {
        if (event === 'finish') finish = listener;
      },
    } as unknown as Response;

    middleware.use(request as Request, response, vi.fn());
    finish();
  };

  const series = async (): Promise<string> => metrics.scrape();

  beforeEach(() => {
    metrics = new MetricsService(CONFIG);
    middleware = new HttpMetricsMiddleware(metrics);
  });

  it('records the status the response actually carried', async () => {
    run({ method: 'GET', route: { path: '/api/v1/payments/:paymentId' } as never }, 404);

    expect(await series()).toContain('status="404"');
  });

  /** The case the interceptor turned into a 500. */
  it('does not report a not-found as a server error', async () => {
    run({ method: 'GET', route: { path: '/api/v1/payments/:paymentId' } as never }, 404);

    expect(await series()).not.toContain('status="500"');
  });

  /**
   * Middleware runs before guards, so a rejected request is counted.
   * As an interceptor this produced nothing at all, which hid exactly
   * the traffic the dashboard exists to show.
   */
  it('records a request a guard rejected', async () => {
    run({ method: 'GET', route: { path: '/api/v1/wallets' } as never }, 401);

    const scraped = await series();
    expect(scraped).toContain('status="401"');
    expect(scraped).toContain('route="/api/v1/wallets"');
  });

  it('still records a success', async () => {
    run({ method: 'POST', route: { path: '/api/v1/auth/login' } as never }, 200);

    expect(await series()).toContain('status="200"');
  });

  it('uses the route template so ids do not become series', async () => {
    const route = { path: '/api/v1/payments/:paymentId' } as never;
    run({ method: 'GET', route }, 200);
    run({ method: 'GET', route }, 200);

    const counts = (await series())
      .split('\n')
      .filter((line) => line.startsWith('http_server_request_duration_seconds_count'));

    expect(counts).toHaveLength(1);
    expect(counts[0]).toContain(':paymentId');
  });

  /**
   * A path that matched nothing is attacker-controlled. One series per
   * probed URL is how a scanner turns a metrics endpoint into an
   * outage.
   */
  it('does not create a series per unmatched path', async () => {
    run({ method: 'GET', originalUrl: '/api/v1/aaa' }, 404);
    run({ method: 'GET', originalUrl: '/api/v1/bbb' }, 404);
    run({ method: 'GET', originalUrl: '/api/v1/ccc' }, 404);

    const scraped = await series();
    expect(scraped).not.toContain('/api/v1/aaa');
    expect(
      scraped.split('\n').filter((l) => l.startsWith('http_server_request_duration_seconds_count')),
    ).toHaveLength(1);
  });
});
