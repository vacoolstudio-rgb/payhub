import { Injectable } from '@nestjs/common';
import type { TransactionObserver } from '@payhub/persistence';
import { MetricsService } from './metrics.service.js';

/**
 * The observability side of `TRANSACTION_OBSERVER`.
 *
 * Persistence declares the port and this implements it, which is the
 * only way round that works: observability already imports persistence
 * for the outbox health indicator, so a direct dependency the other way
 * would close a cycle.
 */
@Injectable()
export class TransactionMetricsObserver implements TransactionObserver {
  constructor(private readonly metrics: MetricsService) {}

  record(isolation: string, outcome: 'commit' | 'rollback', seconds: number): void {
    this.metrics.dbTransactionDuration.observe({ isolation, outcome }, seconds);
  }
}
