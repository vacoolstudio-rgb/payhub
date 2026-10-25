import { describe, expect, it, vi } from 'vitest';
import { RedisHealthIndicator } from './redis.health.js';

/** Terminus' builder, reduced to what this indicator uses. */
const indicatorService = () => ({
  check: (key: string) => ({
    up: (detail: Record<string, unknown>) => ({ [key]: { status: 'up', ...detail } }),
    down: (detail: Record<string, unknown>) => ({ [key]: { status: 'down', ...detail } }),
  }),
});

const build = (ping: () => Promise<unknown>) =>
  new RedisHealthIndicator({ ping } as never, indicatorService() as never);

/**
 * A probe has to answer before the thing asking it gives up.
 *
 * The manifests allow three seconds. `ping` had no deadline, so while
 * Redis was unreachable the client queued the command and the answer
 * came whenever its reconnect logic decided. Measured with Redis
 * stopped: the first probe had not answered after five seconds, later
 * ones took 2.8 against a three-second budget.
 *
 * Slow failure detection is the survivable half. The other half is
 * that a timed-out probe is indistinguishable from a failed one, so a
 * healthy pod with a merely slow Redis leaves the load balancer.
 */
describe('RedisHealthIndicator', () => {
  it('reports up when redis answers', async () => {
    const result = await build(async () => 'PONG').isHealthy();

    expect(result['redis']).toMatchObject({ status: 'up' });
  });

  it('reports down when redis refuses', async () => {
    const result = await build(async () => {
      throw new Error('connection refused');
    }).isHealthy();

    expect(result['redis']).toMatchObject({ status: 'down', message: 'connection refused' });
  });

  it('reports down rather than waiting on a ping that never settles', async () => {
    vi.useFakeTimers();
    try {
      const pending = build(() => new Promise(() => undefined)).isHealthy();
      await vi.advanceTimersByTimeAsync(1_500);

      expect((await pending)['redis']).toMatchObject({ status: 'down' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('says why it gave up, so the reason is not guessed from a blank', async () => {
    vi.useFakeTimers();
    try {
      const pending = build(() => new Promise(() => undefined)).isHealthy();
      await vi.advanceTimersByTimeAsync(1_500);

      expect((await pending)['redis']).toMatchObject({
        message: expect.stringContaining('did not answer'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers well inside the probe budget', async () => {
    vi.useFakeTimers();
    try {
      const pending = build(() => new Promise(() => undefined)).isHealthy();

      // The manifests allow three seconds; nothing should be pending by then.
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The ping loses the race and still settles later. Without observing
   * it, its rejection is unhandled — which under Node's default policy
   * ends the process.
   */
  it('does not leave the losing ping unobserved', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    try {
      let fail: (reason: Error) => void = () => undefined;
      const pending = build(
        () => new Promise((_, reject) => { fail = reject; }),
      ).isHealthy();

      await vi.advanceTimersByTimeAsync(1_500);
      await pending;
      fail(new Error('too late'));
      await vi.advanceTimersByTimeAsync(10);

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.useRealTimers();
    }
  });
});
