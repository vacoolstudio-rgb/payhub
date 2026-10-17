import { Injectable } from '@nestjs/common';
import { TransactionManager, TypeOrmRepositoryBase } from '@payhub/persistence';
import { WebhookDeliveryEntity, type WebhookStatus } from './webhook-delivery.entity.js';

export interface CreateDeliveryInput {
  readonly id: string;
  readonly merchantId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly endpointUrl: string;
  readonly payload: Record<string, unknown>;
  readonly maxAttempts: number;
}

@Injectable()
export class WebhookDeliveryRepository extends TypeOrmRepositoryBase<WebhookDeliveryEntity> {
  constructor(transactions: TransactionManager) {
    super(transactions, WebhookDeliveryEntity);
  }

  /**
   * Creates the delivery record, or returns `null` when one already exists
   * for this (merchant, event). The unique index makes the whole
   * "did we already schedule this webhook?" question a single statement.
   */
  async createIfAbsent(input: CreateDeliveryInput): Promise<WebhookDeliveryEntity | null> {
    const result = await this.repository
      .createQueryBuilder()
      .insert()
      .values({
        id: input.id,
        merchantId: input.merchantId,
        eventId: input.eventId,
        eventType: input.eventType,
        endpointUrl: input.endpointUrl,
        payload: input.payload,
        status: 'pending',
        attempts: 0,
        maxAttempts: input.maxAttempts,
        nextAttemptAt: new Date(),
      } as never)
      .orIgnore()
      .execute();

    if ((result.raw as unknown[]).length === 0) {
      return null;
    }

    return this.repository.findOneBy({ id: input.id });
  }

  async findById(id: string): Promise<WebhookDeliveryEntity | null> {
    return this.repository.findOneBy({ id });
  }

  async markAttempt(
    id: string,
    update: {
      status: WebhookStatus;
      statusCode?: number | null;
      error?: string | null;
      responseBody?: string | null;
      durationMs: number;
      nextAttemptAt?: Date | null;
    },
  ): Promise<void> {
    await this.repository
      .createQueryBuilder()
      .update(WebhookDeliveryEntity)
      .set({
        status: update.status,
        attempts: () => 'attempts + 1',
        lastStatusCode: update.statusCode ?? null,
        lastError: update.error?.slice(0, 2_000) ?? null,
        responseBody: update.responseBody?.slice(0, 2_000) ?? null,
        durationMs: update.durationMs,
        nextAttemptAt: update.nextAttemptAt ?? null,
        deliveredAt: update.status === 'delivered' ? () => 'now()' : null,
        updatedAt: () => 'now()',
      })
      .where('id = :id', { id })
      .execute();
  }

  async listForMerchant(merchantId: string, limit = 50): Promise<WebhookDeliveryEntity[]> {
    return this.repository.find({
      where: { merchantId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
