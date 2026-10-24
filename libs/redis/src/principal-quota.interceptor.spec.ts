import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of } from 'rxjs';
import type { PrincipalQuotaOptions } from './principal-quota.decorator.js';
import { PrincipalQuotaInterceptor } from './principal-quota.interceptor.js';
import type { TokenBucketService } from './token-bucket.service.js';

const QUOTA: PrincipalQuotaOptions = {
  name: 'payment-create',
  capacity: 10,
  refillPerSecond: 1,
};

function build(options: {
  quota?: PrincipalQuotaOptions;
  principalId?: string;
  allowed?: boolean;
}) {
  const consume = vi.fn().mockResolvedValue({
    allowed: options.allowed ?? true,
    remaining: 5,
    retryAfterMs: 2_000,
  });

  const interceptor = new PrincipalQuotaInterceptor(
    { get: vi.fn().mockReturnValue(options.quota) } as unknown as Reflector,
    { consume } as unknown as TokenBucketService,
  );

  const handler = vi.fn(() => of('handled'));

  const context = {
    getType: () => 'http',
    getHandler: () => function create() {},
    switchToHttp: () => ({
      getRequest: () => ({
        ip: '203.0.113.9',
        ...(options.principalId ? { user: { id: options.principalId } } : {}),
      }),
    }),
  } as never;

  return {
    consume,
    handler,
    run: () =>
      interceptor
        .intercept(context, { handle: handler } as never)
        .then((observable) => firstValueFrom(observable)),
  };
}

/**
 * The second rate-limiting layer: the caller's own budget.
 *
 * The global throttle counts by address and runs before authentication,
 * which is right for keeping an unauthenticated flood away from argon2
 * and wrong as a fair-use policy for an API whose clients are merchant
 * servers. An earlier attempt put this in the throttler's `getTracker`
 * and silently did nothing, because at that point in the chain there is
 * no principal yet.
 */
describe('PrincipalQuotaInterceptor', () => {
  it('spends the quota of the caller, not of the address', async () => {
    const probe = build({ quota: QUOTA, principalId: 'merchant-7' });

    await probe.run();

    expect(probe.consume).toHaveBeenCalledWith(
      'quota:payment-create:merchant-7',
      expect.objectContaining({ capacity: 10, refillPerSecond: 1 }),
    );
  });

  it('refuses the request once the bucket is empty', async () => {
    const probe = build({ quota: QUOTA, principalId: 'merchant-7', allowed: false });

    await expect(probe.run()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(probe.handler).not.toHaveBeenCalled();
  });

  it('tells the caller how long to wait', async () => {
    const probe = build({ quota: QUOTA, principalId: 'merchant-7', allowed: false });

    await expect(probe.run()).rejects.toMatchObject({ details: { retryAfterMs: 2_000 } });
  });

  it('lets a request through while the bucket has tokens', async () => {
    const probe = build({ quota: QUOTA, principalId: 'merchant-7' });

    await expect(probe.run()).resolves.toBe('handled');
    expect(probe.handler).toHaveBeenCalled();
  });

  /**
   * Login and registration have no principal yet, and the per-address
   * throttle is the correct control there — guessing an identity is the
   * whole point of those endpoints.
   */
  it('leaves anonymous traffic to the address throttle', async () => {
    const probe = build({ quota: QUOTA });

    await expect(probe.run()).resolves.toBe('handled');
    expect(probe.consume).not.toHaveBeenCalled();
  });

  it('does nothing on a handler that declares no quota', async () => {
    const probe = build({ principalId: 'merchant-7' });

    await expect(probe.run()).resolves.toBe('handled');
    expect(probe.consume).not.toHaveBeenCalled();
  });
});
