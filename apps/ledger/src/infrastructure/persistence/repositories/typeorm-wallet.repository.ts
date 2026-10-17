import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConcurrencyError, Money } from '@payhub/kernel';
import { TransactionManager, TypeOrmRepositoryBase } from '@payhub/persistence';
import { Wallet, WalletId } from '../../../domain/wallet/wallet.aggregate.js';
import type {
  WalletIdentity,
  WalletRepository,
} from '../../../domain/wallet/wallet.repository.js';
import { WalletEntity } from '../entities/wallet.entity.js';
import { WalletMapper } from '../mappers/wallet.mapper.js';

@Injectable()
export class TypeOrmWalletRepository
  extends TypeOrmRepositoryBase<WalletEntity>
  implements WalletRepository
{
  constructor(transactions: TransactionManager) {
    super(transactions, WalletEntity);
  }

  async findById(id: WalletId): Promise<Wallet | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async findByUserAndCurrency(userId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.repository.findOne({ where: { userId, currency } });
    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async findAllByUser(userId: string): Promise<Wallet[]> {
    const entities = await this.repository.find({
      where: { userId },
      order: { currency: 'ASC' },
    });
    return entities.map((entity) => WalletMapper.toDomain(entity));
  }

  /**
   * `SELECT … FOR UPDATE` — the pessimistic half of the double-spend defence.
   *
   * `pessimistic_write` blocks any other transaction that wants to write this
   * row until we commit. That is exactly what a balance check followed by a
   * debit needs: without it, two concurrent withdrawals both read "100
   * available" and both succeed.
   *
   * It must run inside a transaction; outside one Postgres releases the lock
   * immediately and the protection is an illusion.
   */
  async findByIdForUpdate(id: WalletId): Promise<Wallet | null> {
    this.assertInTransaction('findByIdForUpdate');

    const entity = await this.repository.findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });

    return entity ? WalletMapper.toDomain(entity) : null;
  }

  /**
   * Locks a set of wallets in a single statement, ordered by id.
   *
   * Ordering is the whole point: Postgres acquires row locks in the order the
   * rows are returned, so an `ORDER BY id` makes every transaction in the
   * system take locks in the same sequence and a cycle becomes impossible.
   */
  async lockMany(ids: readonly WalletId[]): Promise<Map<WalletId, Wallet>> {
    this.assertInTransaction('lockMany');

    if (ids.length === 0) {
      return new Map();
    }

    const entities = await this.repository
      .createQueryBuilder('wallet')
      .where('wallet.id IN (:...ids)', { ids: [...ids] })
      .orderBy('wallet.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();

    return new Map(
      entities.map((entity) => [WalletId.of(entity.id), WalletMapper.toDomain(entity)] as const),
    );
  }

  /**
   * Upsert-or-read. `ON CONFLICT DO NOTHING` followed by a read is race-free
   * and cheaper than catching a unique violation, which would also poison
   * the surrounding transaction in Postgres.
   */
  async findOrOpen(userId: string, currency: string): Promise<Wallet> {
    const existing = await this.findByUserAndCurrency(userId, currency);
    if (existing) {
      return existing;
    }

    const wallet = Wallet.open({ id: WalletId.of(randomUUID()), userId, currency });

    await this.repository
      .createQueryBuilder()
      .insert()
      .values({
        id: wallet.id,
        userId,
        currency,
        availableMinor: 0n,
        pendingMinor: 0n,
        status: wallet.status,
      })
      .orIgnore()
      .execute();

    const created = await this.findByUserAndCurrency(userId, currency);
    if (!created) {
      throw new Error(`Failed to open wallet for ${userId}/${currency}`);
    }
    return created;
  }

  async ensureMany(identities: ReadonlyArray<WalletIdentity>): Promise<Wallet[]> {
    if (identities.length === 0) {
      return [];
    }

    const wanted = new Set(identities.map(keyOf));
    const userIds = [...new Set(identities.map((identity) => identity.userId))];
    const currencies = [...new Set(identities.map((identity) => identity.currency))];

    // `= ANY($1)` keeps the composite index usable; the cross product of
    // users and currencies is filtered back down in memory, which is free
    // at the two or three participants a transfer actually has.
    const load = async (): Promise<WalletEntity[]> => {
      const rows = await this.repository
        .createQueryBuilder('wallet')
        .where('wallet.user_id = ANY(:userIds)', { userIds })
        .andWhere('wallet.currency = ANY(:currencies)', { currencies })
        .getMany();

      return rows.filter((row) => wanted.has(keyOf(row)));
    };

    const existing = await load();

    if (existing.length === identities.length) {
      return existing.map((entity) => WalletMapper.toDomain(entity));
    }

    const present = new Set(existing.map(keyOf));
    const missing = identities.filter((identity) => !present.has(keyOf(identity)));

    await this.repository
      .createQueryBuilder()
      .insert()
      .values(
        missing.map((identity) => ({
          id: randomUUID(),
          userId: identity.userId,
          currency: identity.currency,
          availableMinor: 0n,
          pendingMinor: 0n,
          status: 'active',
        })) as never,
      )
      // A concurrent first deposit may have created the same row; the
      // unique index decides, and the re-read below picks up the winner.
      .orIgnore()
      .execute();

    return (await load()).map((entity) => WalletMapper.toDomain(entity));
  }

  /**
   * Version-checked update. The `WHERE version = :expected` clause is the
   * optimistic lock: zero affected rows means somebody else committed first.
   */
  async save(wallet: Wallet): Promise<void> {
    const result = await this.repository
      .createQueryBuilder()
      .update(WalletEntity)
      .set({
        availableMinor: wallet.available.amount,
        pendingMinor: wallet.pending.amount,
        status: wallet.status,
        version: () => 'version + 1',
        updatedAt: () => 'now()',
      })
      .where('id = :id AND version = :version', { id: wallet.id, version: wallet.version })
      .execute();

    if (result.affected === 0) {
      throw new ConcurrencyError('Wallet', wallet.id, wallet.version);
    }

    wallet.setVersion(wallet.version + 1);
  }

  /**
   * Authoritative balance straight from the postings.
   *
   * User accounts are liabilities, so a credit increases the balance:
   * `SUM(credit) - SUM(debit)`. This query is what reconciliation compares
   * the projection against.
   */
  async computeBalanceFromJournal(id: WalletId): Promise<{ available: Money; pending: Money }> {
    const wallet = await this.findById(id);
    if (!wallet) {
      throw new Error(`Wallet ${id} not found`);
    }

    const rows = (await this.manager.query(
      `
      SELECT account_kind,
             COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END), 0)::text AS balance
      FROM postings
      WHERE owner_id = $1 AND currency = $2 AND account_kind IN ('user_available', 'user_pending')
      GROUP BY account_kind
      `,
      [wallet.userId, wallet.currency],
    )) as Array<{ account_kind: string; balance: string }>;

    const lookup = new Map(rows.map((row) => [row.account_kind, BigInt(row.balance)]));

    return {
      available: Money.fromMinor(lookup.get('user_available') ?? 0n, wallet.currency),
      pending: Money.fromMinor(lookup.get('user_pending') ?? 0n, wallet.currency),
    };
  }

  private assertInTransaction(operation: string): void {
    if (!this.transactions.isInTransaction()) {
      throw new Error(
        `${operation}() takes a row lock and must run inside a transaction — wrap the caller in @Transactional()`,
      );
    }
  }
}

function keyOf(identity: { userId: string; currency: string }): string {
  return `${identity.userId}:${identity.currency}`;
}
