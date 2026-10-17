import { Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { ConcurrencyError } from '@payhub/kernel';
import { TransactionManager, TypeOrmRepositoryBase } from '@payhub/persistence';
import { FeePolicy } from '../../../domain/fee-policy.vo.js';
import {
  Merchant,
  MerchantId,
  type MerchantStatus,
} from '../../../domain/merchant.aggregate.js';
import type { MerchantRepository } from '../../../domain/merchant.repository.js';
import { WebhookEndpoint } from '../../../domain/webhook-endpoint.vo.js';
import { MerchantEntity } from '../entities/merchant.entity.js';

@Injectable()
export class TypeOrmMerchantRepository
  extends TypeOrmRepositoryBase<MerchantEntity>
  implements MerchantRepository
{
  constructor(transactions: TransactionManager) {
    super(transactions, MerchantEntity);
  }

  async findById(id: MerchantId): Promise<Merchant | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity ? toDomain(entity) : null;
  }

  async findByOwner(ownerUserId: string): Promise<Merchant[]> {
    const entities = await this.repository.find({
      where: { ownerUserId },
      order: { createdAt: 'ASC' },
    });
    return entities.map((entity) => toDomain(entity));
  }

  /**
   * Batch loader. GraphQL resolving `merchant` on fifty payments would issue
   * fifty queries; DataLoader collapses them into this single `IN (…)`.
   */
  async findManyByIds(ids: readonly MerchantId[]): Promise<Map<MerchantId, Merchant>> {
    if (ids.length === 0) {
      return new Map();
    }

    const entities = await this.repository.find({ where: { id: In([...ids]) } });
    return new Map(entities.map((entity) => [MerchantId.of(entity.id), toDomain(entity)] as const));
  }

  async insert(merchant: Merchant): Promise<void> {
    await this.repository.insert(toPersistence(merchant));
  }

  async save(merchant: Merchant): Promise<void> {
    const row = toPersistence(merchant);
    const result = await this.repository
      .createQueryBuilder()
      .update(MerchantEntity)
      .set({
        name: row.name,
        status: row.status,
        feeBasisPoints: row.feeBasisPoints,
        feeFixedMinor: row.feeFixedMinor,
        feeMinimumMinor: row.feeMinimumMinor,
        feeMaximumMinor: row.feeMaximumMinor,
        webhookUrl: row.webhookUrl,
        webhookSecret: row.webhookSecret,
        webhookEvents: row.webhookEvents,
        webhookActive: row.webhookActive,
        version: () => 'version + 1',
        updatedAt: () => 'now()',
      })
      .where('id = :id AND version = :version', { id: merchant.id, version: merchant.version })
      .execute();

    if (result.affected === 0) {
      throw new ConcurrencyError('Merchant', merchant.id, merchant.version);
    }
    merchant.setVersion(merchant.version + 1);
  }
}

function toDomain(entity: MerchantEntity): Merchant {
  const feePolicy = FeePolicy.create({
    basisPoints: entity.feeBasisPoints,
    fixedMinor: entity.feeFixedMinor,
    minimumMinor: entity.feeMinimumMinor,
    maximumMinor: entity.feeMaximumMinor === null ? null : BigInt(entity.feeMaximumMinor),
  });

  const webhook =
    entity.webhookUrl && entity.webhookSecret
      ? WebhookEndpoint.of({
          url: entity.webhookUrl,
          secret: entity.webhookSecret,
          subscribedEvents: entity.webhookEvents,
          active: entity.webhookActive,
        })
      : null;

  return Merchant.rehydrate(
    MerchantId.of(entity.id),
    {
      ownerUserId: entity.ownerUserId,
      name: entity.name,
      status: entity.status as MerchantStatus,
      // A stored policy that no longer validates means the row predates a
      // rule change; falling back keeps the merchant usable and loud in logs.
      feePolicy: feePolicy.isOk() ? feePolicy.value : FeePolicy.default(),
      webhook,
      supportedCurrencies: entity.supportedCurrencies,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    },
    entity.version,
  );
}

function toPersistence(merchant: Merchant): MerchantEntity {
  const entity = new MerchantEntity();
  entity.id = merchant.id;
  entity.ownerUserId = merchant.ownerUserId;
  entity.name = merchant.name;
  entity.status = merchant.status;
  entity.feeBasisPoints = merchant.feePolicy.basisPoints;
  entity.feeFixedMinor = merchant.feePolicy.fixedMinor;
  entity.feeMinimumMinor = merchant.feePolicy.minimumMinor;
  entity.feeMaximumMinor =
    merchant.feePolicy.maximumMinor === null ? null : merchant.feePolicy.maximumMinor.toString();
  entity.webhookUrl = merchant.webhook?.url ?? null;
  entity.webhookSecret = merchant.webhook?.secret ?? null;
  entity.webhookEvents = [...(merchant.webhook?.subscribedEvents ?? ['*'])];
  entity.webhookActive = merchant.webhook?.active ?? false;
  entity.supportedCurrencies = [...merchant.supportedCurrencies];
  return entity;
}
