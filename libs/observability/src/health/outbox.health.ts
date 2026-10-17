import { Injectable, Optional } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import { OutboxRepository } from '@payhub/persistence';

/**
 * A growing outbox is the earliest signal that events have stopped reaching
 * the rest of the platform, long before anybody notices a missing webhook.
 * Readiness stays green (the service still answers requests correctly), but
 * the liveness payload carries the backlog so the alert fires on the metric.
 */
@Injectable()
export class OutboxHealthIndicator {
  /**
   * `@Optional()` because not every service owns an outbox — the
   * notifications service has no database at all. A globally registered
   * health controller must not force a dependency that only some of its
   * hosts can satisfy.
   */
  constructor(
    @Optional() private readonly outbox: OutboxRepository | undefined,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async check(key = 'outbox', threshold = 1_000): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    if (!this.outbox) {
      return indicator.up({ enabled: false });
    }

    const counts = await this.outbox.countByStatus();
    const pending = counts['pending'] ?? 0;
    const dead = counts['dead'] ?? 0;

    const details = { pending, dead, published: counts['published'] ?? 0 };

    return pending > threshold || dead > 0 ? indicator.down(details) : indicator.up(details);
  }
}
