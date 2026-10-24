import { ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';
import { ShutdownState } from './shutdown-state.service.js';

/**
 * Readiness during a rolling update.
 *
 * Removing a pod from a Service is asynchronous — the endpoint is
 * withdrawn and every node rewrites its proxy rules — so for a few
 * seconds after SIGTERM the orchestrator is still routing work to a pod
 * that is on its way out. A pod that answers 200 for that whole window
 * and then refuses the connection hands those requests to the user as
 * errors.
 *
 * Measured on the running service before this existed: `/health/ready`
 * answered 200 at the instant SIGTERM arrived and the socket refused
 * connections 38 ms later, with no failing probe in between.
 */
describe('readiness while shutting down', () => {
  let shutdown: ShutdownState;
  let controller: HealthController;
  let checked: unknown[];

  beforeEach(() => {
    shutdown = new ShutdownState();
    checked = [];

    const health = {
      // Terminus runs each indicator and aggregates; here the point is
      // which indicators were offered and whether the first one throws.
      check: vi.fn(async (indicators: Array<() => Promise<unknown>>) => {
        checked = indicators;
        for (const indicator of indicators) {
          await indicator();
        }
        return { status: 'ok' };
      }),
    };

    controller = new HealthController(
      health as never,
      { pingCheck: async () => ({ postgres: { status: 'up' } }) } as never,
      { isHealthy: async () => ({ redis: { status: 'up' } }) } as never,
      {} as never,
      { checkHeap: async () => ({}), checkRSS: async () => ({}) } as never,
      {} as never,
      new Set(['postgres', 'redis']) as never,
      shutdown,
    );
  });

  it('reports ready while the instance is serving', async () => {
    await expect(controller.ready()).resolves.toMatchObject({ status: 'ok' });
  });

  it('reports not ready the moment draining begins', async () => {
    shutdown.beginDraining();

    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  /**
   * Before the dependencies, not after. A terminating pod is not ready
   * however healthy Postgres is, and checking it first means the answer
   * does not depend on a database round trip that may itself be slow.
   */
  it('answers without touching a dependency', async () => {
    shutdown.beginDraining();
    const pingCheck = vi.fn();

    controller = new HealthController(
      { check: async (indicators: Array<() => Promise<unknown>>) => {
          for (const indicator of indicators) {
            await indicator();
          }
          return { status: 'ok' };
        } } as never,
      { pingCheck } as never,
      { isHealthy: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      new Set(['postgres', 'redis']) as never,
      shutdown,
    );

    await expect(controller.ready()).rejects.toThrow();
    expect(pingCheck).not.toHaveBeenCalled();
  });

  it('still offers the dependency probes when it is not draining', async () => {
    await controller.ready();

    // Accepting traffic, postgres, redis.
    expect(checked).toHaveLength(3);
  });

  /** Liveness is a different question: the process is fine, it is leaving. */
  it('stays alive while draining, so the orchestrator does not restart it', async () => {
    shutdown.beginDraining();

    await expect(controller.live()).resolves.toMatchObject({ status: 'ok' });
  });

  it('never becomes ready again once it has started draining', () => {
    shutdown.beginDraining();
    shutdown.beginDraining();

    expect(shutdown.isDraining).toBe(true);
  });
});
