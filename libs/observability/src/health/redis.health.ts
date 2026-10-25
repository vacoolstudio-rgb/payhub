import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { RedisService } from '@payhub/redis';
import type { HealthIndicatorResult } from '@nestjs/terminus';

/**
 * A probe has to answer faster than the thing asking it gives up.
 *
 * The readiness probe in the manifests allows three seconds. An
 * unbounded `ping` does not promise anything: while Redis is
 * unreachable the client queues the command and the answer arrives
 * whenever its reconnect logic decides. Measured with Redis stopped —
 * the first probe had still not answered after five seconds, and later
 * ones took 2.8, against a three-second budget.
 *
 * The slow-failure half of that is survivable; the other half is not.
 * A probe that times out is indistinguishable from one that failed, so
 * a *healthy* pod whose Redis is merely slow gets pulled from the load
 * balancer. Bounding the check well inside the budget is what keeps
 * "not ready" meaning what it says.
 *
 * The Postgres check has always passed an explicit timeout. This is
 * the same idea, written out because `ping` has no timeout argument.
 */
const PING_DEADLINE_MS = 1_000;

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly redis: RedisService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key = 'redis'): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    const startedAt = Date.now();

    try {
      await this.withDeadline(this.redis.ping());
      return indicator.up({ latencyMs: Date.now() - startedAt });
    } catch (error) {
      return indicator.down({
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async withDeadline<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`redis did not answer within ${PING_DEADLINE_MS}ms`)),
            PING_DEADLINE_MS,
          );
        }),
      ]);
    } finally {
      // The losing side of a race still settles; leaving the timer
      // pending would hold the event loop open at shutdown.
      clearTimeout(timer);
      // And an unobserved rejection from the ping would take the
      // process down under Node's default policy.
      void work.catch(() => undefined);
    }
  }
}
