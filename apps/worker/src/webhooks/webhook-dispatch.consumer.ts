import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { type WorkerConfig, workerConfig } from '@payhub/config';
import {
  PaymentCaptured,
  PaymentFailed,
  PaymentRefunded,
  type PayloadOf,
} from '@payhub/contracts';
import { KafkaHandler, type MessageContext } from '@payhub/messaging';
import { Transactional } from '@payhub/persistence';
import { QueueName, type WebhookDeliveryJob } from '@payhub/queue';
import { MerchantLookupService } from './merchant-lookup.service.js';
import { WebhookDeliveryRepository } from './webhook-delivery.repository.js';

/**
 * Turns payment facts into webhook deliveries.
 *
 * The Kafka consumer, the delivery row and the queue job all commit
 * together: the inbox row (written by the consumer framework) and the
 * delivery row share one transaction, and the job is only enqueued after it
 * commits. A duplicate Kafka delivery therefore cannot produce a second
 * webhook — the unique `(merchant_id, event_id)` index catches it.
 */
@Injectable()
export class WebhookDispatchConsumer {
  private readonly logger = new Logger(WebhookDispatchConsumer.name);

  constructor(
    @InjectQueue(QueueName.WebhookDelivery) private readonly queue: Queue<WebhookDeliveryJob>,
    private readonly deliveries: WebhookDeliveryRepository,
    private readonly merchants: MerchantLookupService,
    @Inject(workerConfig.KEY) private readonly config: WorkerConfig,
  ) {}

  @KafkaHandler(PaymentCaptured)
  async onCaptured(
    payload: PayloadOf<typeof PaymentCaptured>,
    context: MessageContext,
  ): Promise<void> {
    await this.dispatch('payment.captured.v1', payload.merchantId, payload, context);
  }

  @KafkaHandler(PaymentFailed)
  async onFailed(
    payload: PayloadOf<typeof PaymentFailed>,
    context: MessageContext,
  ): Promise<void> {
    await this.dispatch('payment.failed.v1', payload.merchantId, payload, context);
  }

  @KafkaHandler(PaymentRefunded)
  async onRefunded(
    payload: PayloadOf<typeof PaymentRefunded>,
    context: MessageContext,
  ): Promise<void> {
    await this.dispatch('payment.refunded.v1', payload.merchantId, payload, context);
  }

  @Transactional()
  private async dispatch(
    eventType: string,
    merchantId: string,
    payload: Record<string, unknown>,
    context: MessageContext,
  ): Promise<void> {
    const endpoint = await this.merchants.webhookFor(merchantId, eventType);

    if (!endpoint) {
      this.logger.debug(`Merchant ${merchantId} has no active endpoint for ${eventType}`);
      return;
    }

    const deliveryId = randomUUID();

    const delivery = await this.deliveries.createIfAbsent({
      id: deliveryId,
      merchantId,
      eventId: context.messageId,
      eventType,
      endpointUrl: endpoint.url,
      payload: {
        id: context.messageId,
        type: eventType,
        createdAt: new Date().toISOString(),
        data: payload,
      },
      maxAttempts: this.config.webhookMaxAttempts,
    });

    if (!delivery) {
      this.logger.debug(`Delivery for ${merchantId}/${context.messageId} already scheduled`);
      return;
    }

    await this.queue.add(
      eventType,
      {
        deliveryId: delivery.id,
        merchantId,
        endpointUrl: endpoint.url,
        secretRef: endpoint.secret,
        eventType,
        eventId: context.messageId,
        payload: delivery.payload,
        attempt: 0,
      },
      {
        // The delivery id is the BullMQ job id too, so even a double enqueue
        // (a retry that crossed the commit) collapses to one job.
        jobId: delivery.id,
        attempts: this.config.webhookMaxAttempts,
        backoff: { type: 'exponentialJitter' },
        removeOnComplete: { age: 86_400, count: 5_000 },
        removeOnFail: { age: 7 * 86_400 },
      },
    );

    this.logger.log(`Queued ${eventType} webhook ${delivery.id} for merchant ${merchantId}`);
  }
}
