import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from '@prometheus-io/client';
import { type AppConfig, appConfig } from '@payhub/config';

/**
 * Application metrics.
 *
 * Deliberately hand-rolled instead of pulling a wrapper library: the registry
 * is three lines, and owning it means the business metrics below (which are
 * the ones anybody actually pages on) sit next to the technical ones.
 *
 * Buckets are chosen per metric. Default buckets are tuned for seconds-scale
 * web requests and are useless for a ledger write that must stay under 50 ms.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  // --- technical ----------------------------------------------------------
  readonly httpDuration = new Histogram({
    name: 'http_server_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly dbTransactionDuration = new Histogram({
    name: 'db_transaction_duration_seconds',
    help: 'Database transaction duration by isolation level',
    labelNames: ['isolation', 'outcome'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5],
    registers: [this.registry],
  });

  readonly outboxBacklog = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Messages waiting in the transactional outbox',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });

  readonly kafkaConsumerLag = new Gauge({
    name: 'kafka_consumer_lag_messages',
    help: 'Difference between the partition high watermark and the committed offset',
    labelNames: ['topic', 'partition', 'group'] as const,
    registers: [this.registry],
  });

  /**
   * Failures that were caught on purpose and went no further.
   *
   * Some failures must not travel — telemetry may not fail a payment,
   * an after-commit effect has nothing left to undo, a cache bump may
   * not roll back the write it follows. Swallowing them is right.
   * Leaving them visible only in a log line is not: both sites this
   * started with changed behaviour while staying silent. A committed
   * transaction whose side effect vanished, and a validator that kept
   * answering 304 for a month after the data moved.
   *
   * `site` and `reason` are deliberately coarse — they are metric
   * dimensions, and a message in a label is a cardinality incident.
   */
  readonly suppressedFailures = new Counter({
    name: 'suppressed_failures_total',
    help: 'Failures caught deliberately and not propagated',
    labelNames: ['site', 'reason'] as const,
    registers: [this.registry],
  });

  readonly messagesProcessed = new Counter({
    name: 'messages_processed_total',
    help: 'Integration messages consumed',
    labelNames: ['topic', 'event_type', 'outcome'] as const,
    registers: [this.registry],
  });

  // --- business -----------------------------------------------------------
  readonly paymentsTotal = new Counter({
    name: 'payments_total',
    help: 'Payments by direction and terminal state',
    labelNames: ['direction', 'status', 'currency'] as const,
    registers: [this.registry],
  });

  /**
   * Work a compensation job found but refused to perform.
   *
   * A sweep that silently skips is indistinguishable from a sweep with
   * nothing to do, which is how a stuck payment sits unnoticed for a
   * quarter. Anything above zero wants a human.
   */
  readonly recoverySkipped = new Counter({
    name: 'recovery_skipped_total',
    help: 'Rows a compensation sweep declined to act on',
    labelNames: ['job', 'reason'] as const,
    registers: [this.registry],
  });

  readonly paymentAmount = new Counter({
    name: 'payment_amount_minor_total',
    help: 'Processed volume in minor units',
    labelNames: ['direction', 'currency'] as const,
    registers: [this.registry],
  });

  readonly ledgerPostings = new Counter({
    name: 'ledger_postings_total',
    help: 'Double-entry journal postings',
    labelNames: ['purpose', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly webhookDeliveries = new Counter({
    name: 'webhook_deliveries_total',
    help: 'Webhook delivery attempts',
    labelNames: ['outcome', 'status_code'] as const,
    registers: [this.registry],
  });

  readonly reconciliationDrift = new Gauge({
    name: 'reconciliation_drift_minor_units',
    help: 'Absolute difference between the ledger and the wallet projection',
    labelNames: ['currency'] as const,
    registers: [this.registry],
  });

  /**
   * The signed sum of every posting, which double-entry bookkeeping makes
   * zero by construction.
   *
   * It had no metric: a broken trial balance produced a log line and
   * nothing a rule could fire on, while the far less serious projection
   * drift above got a gauge. The cheapest integrity check in the system
   * was the one you could not alert on.
   */
  readonly trialBalance = new Gauge({
    name: 'ledger_trial_balance_minor_units',
    help: 'Signed sum of all postings per currency; any non-zero value is a defect',
    labelNames: ['currency'] as const,
    registers: [this.registry],
  });

  /**
   * Projections rewritten from the journal.
   *
   * Healing is safe — it corrects a cache — but a sweep that heals the
   * same wallets every cycle is masking a live bug, and that is only
   * visible if the healing itself is counted.
   */
  readonly reconciliationHealed = new Counter({
    name: 'reconciliation_healed_total',
    help: 'Wallet projections rewritten from the journal',
    labelNames: ['currency'] as const,
    registers: [this.registry],
  });

  readonly llmTokens = new Counter({
    name: 'llm_tokens_total',
    help: 'LLM tokens consumed',
    labelNames: ['model', 'kind'] as const,
    registers: [this.registry],
  });

  readonly llmCostMicroUsd = new Counter({
    name: 'llm_cost_micro_usd_total',
    help: 'Estimated LLM spend in millionths of a dollar',
    labelNames: ['model'] as const,
    registers: [this.registry],
  });

  constructor(@Inject(appConfig.KEY) private readonly config: AppConfig) {}

  onModuleInit(): void {
    this.registry.setDefaultLabels({
      service: this.config.serviceName,
      version: this.config.serviceVersion,
      env: this.config.nodeEnv,
    });

    // Event-loop lag, GC pauses, heap, handles — the first things to check
    // when latency rises but the database looks fine.
    collectDefaultMetrics({ register: this.registry, prefix: '' });

  }

  async scrape(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
