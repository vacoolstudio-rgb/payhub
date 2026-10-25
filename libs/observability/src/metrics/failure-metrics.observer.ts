import { Injectable } from '@nestjs/common';
import type { FailureObserver } from '@payhub/kernel';
import { MetricsService } from './metrics.service.js';

/**
 * Turns a deliberately swallowed failure into a number.
 *
 * The libraries that raise these sit below this one — persistence and
 * redis are both imported by observability — so they talk to a port in
 * the kernel and this is what satisfies it.
 */
@Injectable()
export class FailureMetricsObserver implements FailureObserver {
  constructor(private readonly metrics: MetricsService) {}

  suppressed(site: string, reason: string): void {
    this.metrics.suppressedFailures.inc({ site, reason });
  }
}
