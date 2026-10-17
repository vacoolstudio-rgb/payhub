import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { type WorkerConfig, workerConfig } from '@payhub/config';
import { OutboxRepository } from '@payhub/persistence';
import { MetricsService } from '@payhub/observability';
import { backoffDelay } from '@payhub/shared';
import { KafkaProducerService, type PublishInput } from './kafka-producer.service.js';

export const OUTBOX_RELAY_ENABLED = Symbol.for('payhub:OutboxRelayEnabled');

/**
 * Polling relay that drains the transactional outbox into Kafka.
 *
 * Polling, not logical decoding (Debezium), on purpose: one fewer moving part
 * for a platform this size, and the latency floor is a configurable few
 * hundred milliseconds. The trade-off is explicit — at serious volume the CDC
 * route stops hammering the table and becomes the better answer.
 *
 * Safe to run on every replica: `claimBatch` uses `FOR UPDATE SKIP LOCKED`,
 * so instances partition the work between themselves without a leader.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayService.name);
  private stopping = false;
  private loop?: Promise<void>;
  private consecutiveFailures = 0;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly producer: KafkaProducerService,
    private readonly metrics: MetricsService,
    @Inject(workerConfig.KEY) private readonly config: WorkerConfig,
    @Inject(OUTBOX_RELAY_ENABLED) private readonly enabled: boolean,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Outbox relay disabled in this process');
      return;
    }
    this.loop = this.run();
    this.logger.log(
      `Outbox relay started (poll=${this.config.outboxPollIntervalMs}ms, batch=${this.config.outboxBatchSize})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const published = await this.drainOnce();
        this.consecutiveFailures = 0;

        // Back-to-back drains while there is a backlog; idle poll otherwise.
        if (published < this.config.outboxBatchSize) {
          await delay(this.config.outboxPollIntervalMs);
        }
      } catch (error) {
        this.consecutiveFailures += 1;
        const waitMs = backoffDelay(Math.min(this.consecutiveFailures, 6), 500, 30_000);
        this.logger.error(
          `Outbox relay iteration failed (#${this.consecutiveFailures}), backing off ${waitMs}ms: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await delay(waitMs);
      }
    }
  }

  async drainOnce(): Promise<number> {
    const batch = await this.outbox.claimBatch(this.config.outboxBatchSize);

    if (batch.length === 0) {
      await this.reportBacklog();
      return 0;
    }

    const inputs: PublishInput[] = batch.map((row) => ({
      topic: row.topic,
      eventType: row.eventType,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      partitionKey: row.partitionKey,
      payload: row.payload,
      messageId: row.id,
      headers: row.headers,
      occurredAt: new Date(row.occurredAt),
    }));

    try {
      await this.producer.publishBatch(inputs);
      await this.outbox.markPublished(batch.map((row) => row.id));
      return batch.length;
    } catch (error) {
      // The whole batch failed (broker unreachable). Reschedule each row with
      // its own backoff so a poison message cannot block the others forever.
      const reason = error instanceof Error ? error.message : String(error);

      await Promise.all(
        batch.map((row) =>
          this.outbox.markFailed(
            row.id,
            reason,
            backoffDelay(row.attempts, 500, 60_000),
            this.config.webhookMaxAttempts,
          ),
        ),
      );
      throw error;
    }
  }

  private async reportBacklog(): Promise<void> {
    const counts = await this.outbox.countByStatus();
    for (const [status, count] of Object.entries(counts)) {
      this.metrics.outboxBacklog.set({ status }, count);
    }
  }
}
