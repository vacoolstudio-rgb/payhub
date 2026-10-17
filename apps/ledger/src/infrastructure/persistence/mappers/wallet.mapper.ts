import { Money } from '@payhub/kernel';
import { Wallet, WalletId, type WalletStatus } from '../../../domain/wallet/wallet.aggregate.js';
import { WalletEntity } from '../entities/wallet.entity.js';

/**
 * Mapper, not an ORM-annotated aggregate.
 *
 * Keeping TypeORM decorators out of the domain means the aggregate can be
 * unit-tested with `new`, refactored without a migration, and does not grow
 * accidental persistence concerns (lazy relations, `save()` cascades) into
 * its public API. The cost is this file; the benefit is a domain layer with
 * zero infrastructure imports.
 */
export const WalletMapper = {
  toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate(
      WalletId.of(entity.id),
      {
        userId: entity.userId,
        currency: entity.currency,
        available: Money.fromMinor(entity.availableMinor, entity.currency),
        pending: Money.fromMinor(entity.pendingMinor, entity.currency),
        status: entity.status as WalletStatus,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
      },
      entity.version,
    );
  },

  toPersistence(wallet: Wallet): WalletEntity {
    const entity = new WalletEntity();
    entity.id = wallet.id;
    entity.userId = wallet.userId;
    entity.currency = wallet.currency;
    entity.availableMinor = wallet.available.amount;
    entity.pendingMinor = wallet.pending.amount;
    entity.status = wallet.status;
    entity.version = wallet.version;
    return entity;
  },
};
