import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FailureObserver } from '@payhub/kernel';
import { ResourceVersionService } from './resource-version.service.js';

/**
 * What a lost version bump costs, and who hears about it.
 *
 * The token this service stores is what the HTTP cache builds its ETag
 * from, so a bump that does not happen leaves every conditional request
 * answering 304 for data that has moved. The bump is deliberately
 * non-fatal — it follows a write that must not roll back because Redis
 * blinked — which makes it exactly the kind of failure that needs to be
 * counted rather than only logged.
 */
describe('ResourceVersionService', () => {
  let failures: { suppressed: ReturnType<typeof vi.fn> };
  let pipeline: { set: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> };
  let service: ResourceVersionService;

  const build = () =>
    new ResourceVersionService(
      { client: { pipeline: () => pipeline } } as never,
      failures as unknown as FailureObserver,
    );

  beforeEach(() => {
    failures = { suppressed: vi.fn() };
    pipeline = { set: vi.fn(), exec: vi.fn().mockResolvedValue([]) };
    service = build();
  });

  it('bumps every scope it is given', async () => {
    await service.bump('payment:1', 'payments:user:7');

    expect(pipeline.set).toHaveBeenCalledTimes(2);
    expect(failures.suppressed).not.toHaveBeenCalled();
  });

  it('does nothing, and reports nothing, for an empty list', async () => {
    await service.bump();

    expect(pipeline.set).not.toHaveBeenCalled();
    expect(failures.suppressed).not.toHaveBeenCalled();
  });

  /** The write it follows has already committed; this cannot throw. */
  it('does not propagate a redis failure to the caller', async () => {
    pipeline.exec.mockRejectedValue(new Error('connection refused'));

    await expect(service.bump('payment:1')).resolves.toBeUndefined();
  });

  it('counts the failure instead of only logging it', async () => {
    pipeline.exec.mockRejectedValue(new Error('connection refused'));

    await service.bump('payment:1');

    expect(failures.suppressed).toHaveBeenCalledWith(
      'resource-version-bump',
      expect.any(String),
    );
  });

  it('still works with no observer wired', async () => {
    pipeline.exec.mockRejectedValue(new Error('connection refused'));
    const bare = new ResourceVersionService({ client: { pipeline: () => pipeline } } as never);

    await expect(bare.bump('payment:1')).resolves.toBeUndefined();
  });

  /**
   * The bound that makes a lost bump survivable.
   *
   * It was thirty days, which is not a bound: a terminal state change
   * has no later write to heal it, so an integrator polling that
   * payment would never have seen it settle. Measured against the
   * running API before the change — a payment taken from `captured` to
   * `failed` still answered 304 to a conditional request.
   */
  it('expires a token within the hour, so a missed bump self-heals', async () => {
    await service.bump('payment:1');

    const ttl = pipeline.set.mock.calls[0]?.[3] as number;
    expect(ttl).toBeLessThanOrEqual(60 * 60);
    expect(ttl).toBeGreaterThan(60);
  });
});
