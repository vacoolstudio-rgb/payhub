import { Injectable } from '@nestjs/common';
import { In, type SelectQueryBuilder } from 'typeorm';
import { ConcurrencyError, type CursorPage, Money, buildPage, decodeCursor } from '@payhub/kernel';
import { TransactionManager, TypeOrmRepositoryBase } from '@payhub/persistence';
import {
  Payment,
  PaymentId,
  type PaymentDirection,
  type PaymentFailureReason,
  type PaymentStatus,
} from '../../../domain/payment.aggregate.js';
import type {
  PaymentFilter,
  PaymentRepository,
  PaymentStats,
} from '../../../domain/payment.repository.js';
import { PaymentEntity } from '../entities/payment.entity.js';

@Injectable()
export class TypeOrmPaymentRepository
  extends TypeOrmRepositoryBase<PaymentEntity>
  implements PaymentRepository
{
  constructor(transactions: TransactionManager) {
    super(transactions, PaymentEntity);
  }

  async findById(id: PaymentId): Promise<Payment | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity ? toDomain(entity) : null;
  }

  async findByIdForUpdate(id: PaymentId): Promise<Payment | null> {
    if (!this.transactions.isInTransaction()) {
      throw new Error('findByIdForUpdate() must run inside a transaction');
    }

    const entity = await this.repository.findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });

    return entity ? toDomain(entity) : null;
  }

  async findByTransferId(transferId: string): Promise<Payment | null> {
    const entity = await this.repository.findOne({ where: { transferId } });
    return entity ? toDomain(entity) : null;
  }

  async findManyByIds(ids: readonly PaymentId[]): Promise<Map<PaymentId, Payment>> {
    if (ids.length === 0) {
      return new Map();
    }
    const entities = await this.repository.find({ where: { id: In([...ids]) } });
    return new Map(entities.map((entity) => [PaymentId.of(entity.id), toDomain(entity)] as const));
  }

  /**
   * Keyset pagination again, with the composite `(created_at, id)` cursor so
   * a payment created during paging cannot shift the window.
   *
   * A user's listing has to include transfers where they are the
   * destination. Expressed as `user_id = $1 OR counterparty_user_id = $1`
   * that is a disjunction over two columns, which no single index can
   * serve: Postgres scanned the whole table and top-N sorted the result,
   * so a 25-row page cost 9 839 buffers and 40 ms over 400 000 rows —
   * against 29 buffers and 0.24 ms for the merchant listing, the same
   * query without the `OR`. The cost grew with the table rather than with
   * the page, defeating the point of keyset pagination.
   *
   * Splitting the disjunction into two branches lets each one walk its own
   * `(owner, created_at DESC, id DESC)` index in order. Each branch is
   * limited to one page, so merging them sorts at most `2 × limit` rows
   * however large the table gets.
   */
  async list(filter: PaymentFilter): Promise<CursorPage<Payment>> {
    const limit = Math.min(Math.max(filter.limit, 1), 100);
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : null;

    const rows = filter.userId
      ? await this.listForUser(filter, filter.userId, limit, cursor)
      : await this.applyFilters(this.repository.createQueryBuilder('p'), filter, cursor)
          .orderBy('p.created_at', 'DESC')
          .addOrderBy('p.id', 'DESC')
          .take(limit + 1)
          .getMany();

    const page = buildPage(rows, limit, (row) => ({
      createdAt: row.createdAt.toISOString(),
      id: row.id,
    }));

    return { ...page, items: page.items.map((entity) => toDomain(entity)) };
  }

  /**
   * The two-branch form. `UNION ALL` and not `UNION`: a payment cannot be
   * both its own originator and its own counterparty, so there are no
   * duplicates to remove and deduplicating would cost a sort over the
   * whole result.
   */
  private async listForUser(
    filter: PaymentFilter,
    userId: string,
    limit: number,
    cursor: { createdAt: string; id: string } | null,
  ): Promise<PaymentEntity[]> {
    const branch = (column: 'user_id' | 'counterparty_user_id') =>
      this.applyFilters(
        this.repository
          .createQueryBuilder('p')
          .where(`p.${column} = :userId`, { userId }),
        filter,
        cursor,
      )
        .orderBy('p.created_at', 'DESC')
        .addOrderBy('p.id', 'DESC')
        .take(limit + 1);

    const [owned, received] = await Promise.all([
      branch('user_id').getMany(),
      branch('counterparty_user_id').getMany(),
    ]);

    // Merging in memory rather than in SQL: TypeORM's query builder cannot
    // express `UNION ALL` over two entity selects without dropping to raw
    // SQL and hand-mapping every column, and the inputs are two already
    // sorted lists of at most `limit + 1` rows each.
    return [...owned, ...received]
      .sort((a, b) => compareDesc(a, b))
      .slice(0, limit + 1);
  }

  /** Every filter except the owner, which differs per branch. */
  private applyFilters(
    query: SelectQueryBuilder<PaymentEntity>,
    filter: PaymentFilter,
    cursor: { createdAt: string; id: string } | null,
  ): SelectQueryBuilder<PaymentEntity> {
    if (filter.merchantId) {
      query.andWhere('p.merchant_id = :merchantId', { merchantId: filter.merchantId });
    }
    if (filter.status) {
      query.andWhere('p.status = :status', { status: filter.status });
    }
    if (filter.direction) {
      query.andWhere('p.direction = :direction', { direction: filter.direction });
    }
    if (filter.currency) {
      query.andWhere('p.currency = :currency', { currency: filter.currency });
    }
    if (filter.from) {
      query.andWhere('p.created_at >= :from', { from: filter.from });
    }
    if (filter.to) {
      query.andWhere('p.created_at < :to', { to: filter.to });
    }
    if (cursor) {
      query.andWhere('(p.created_at, p.id) < (:cursorAt, :cursorId)', {
        cursorAt: cursor.createdAt,
        cursorId: cursor.id,
      });
    }

    return query;
  }

  /**
   * One pass with `FILTER` clauses instead of four round trips.
   * `count(*) FILTER (WHERE …)` is the Postgres-native way to do conditional
   * aggregation and reads far better than `sum(case when … then 1 end)`.
   */
  async stats(input: {
    merchantId?: string;
    userId?: string;
    currency: string;
    from: Date;
    to: Date;
  }): Promise<PaymentStats> {
    const rows = (await this.manager.query(
      `
      SELECT
        count(*)::int                                                   AS "totalCount",
        count(*) FILTER (WHERE status = 'captured')::int                AS "capturedCount",
        count(*) FILTER (WHERE status = 'failed')::int                  AS "failedCount",
        COALESCE(SUM(amount_minor) FILTER (WHERE status = 'captured'), 0)::text AS "volumeMinor",
        COALESCE(SUM(fee_minor)    FILTER (WHERE status = 'captured'), 0)::text AS "feeMinor"
      FROM payments
      WHERE currency = $1
        AND created_at >= $2
        AND created_at < $3
        AND ($4::uuid IS NULL OR merchant_id = $4::uuid)
        AND ($5::uuid IS NULL OR user_id = $5::uuid)
      `,
      [input.currency, input.from, input.to, input.merchantId ?? null, input.userId ?? null],
    )) as Array<Omit<PaymentStats, 'currency'>>;

    return { ...(rows[0] as Omit<PaymentStats, 'currency'>), currency: input.currency };
  }

  /**
   * First write, and the only one that does not check a version.
   *
   * The in-memory aggregate starts at version 0 — "never persisted" —
   * while the row is created at 1. Leaving the two out of step makes
   * `insert(p); p.mutate(); save(p)` fail with a `ConcurrencyError`
   * blaming a concurrent writer that does not exist. The production
   * paths all reload before saving, so it never fired there; it is
   * still a trap worth closing rather than documenting.
   */
  async insert(payment: Payment): Promise<void> {
    const row = toPersistence(payment);
    row.version = INITIAL_VERSION;

    await this.repository.insert(row as never);
    payment.setVersion(INITIAL_VERSION);
  }

  /**
   * Optimistic-locked update of everything a payment's lifecycle can
   * change.
   *
   * The mutable set is derived by *removing* the columns fixed at
   * creation, rather than by listing the ones to write. The allow-list
   * version silently dropped any field added to the aggregate later —
   * `refund_transfer_id` was mapped end to end, compiled, and still
   * never reached the database, because nobody remembered this
   * `.set({…})`. Subtracting instead of adding makes a new field persist
   * by default and a newly *immutable* one a deliberate edit here.
   */
  async save(payment: Payment): Promise<void> {
    const {
      // Fixed when the payment was created; never written again.
      id: _id,
      merchantId: _merchantId,
      userId: _userId,
      counterpartyUserId: _counterpartyUserId,
      direction: _direction,
      amountMinor: _amountMinor,
      feeMinor: _feeMinor,
      currency: _currency,
      method: _method,
      reference: _reference,
      idempotencyKey: _idempotencyKey,
      expiresAt: _expiresAt,
      createdAt: _createdAt,
      // Owned by the statement below, not by the mapper.
      version: _version,
      updatedAt: _updatedAt,
      ...mutable
    } = toPersistence(payment);

    const result = await this.repository
      .createQueryBuilder()
      .update(PaymentEntity)
      .set({
        ...mutable,
        version: () => 'version + 1',
        updatedAt: () => 'now()',
      })
      .where('id = :id AND version = :version', { id: payment.id, version: payment.version })
      .execute();

    if (result.affected === 0) {
      throw new ConcurrencyError('Payment', payment.id, payment.version);
    }
    payment.setVersion(payment.version + 1);
  }
}

/** Matches the column default; the aggregate starts a step behind at 0. */
const INITIAL_VERSION = 1;

/**
 * The page ordering, in one place: the two branches and the merge must
 * agree exactly, or the cursor of the last row would not describe the
 * boundary of the page actually returned.
 */
function compareDesc(a: PaymentEntity, b: PaymentEntity): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  return byTime !== 0 ? byTime : (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);
}

function toDomain(entity: PaymentEntity): Payment {
  return Payment.rehydrate(
    PaymentId.of(entity.id),
    {
      merchantId: entity.merchantId,
      userId: entity.userId,
      counterpartyUserId: entity.counterpartyUserId,
      direction: entity.direction as PaymentDirection,
      amount: Money.fromMinor(entity.amountMinor, entity.currency),
      fee: Money.fromMinor(entity.feeMinor, entity.currency),
      method: entity.method,
      reference: entity.reference,
      idempotencyKey: entity.idempotencyKey,
      metadata: entity.metadata ?? {},
      status: entity.status as PaymentStatus,
      providerReference: entity.providerReference,
      transferId: entity.transferId,
      refundTransferId: entity.refundTransferId,
      refundAmount:
        entity.refundAmountMinor === null
          ? null
          : Money.fromMinor(entity.refundAmountMinor, entity.currency),
      refundedAmount: Money.fromMinor(entity.refundedMinor, entity.currency),
      failureReason: entity.failureReason as PaymentFailureReason | null,
      failureDetail: entity.failureDetail,
      authorizedAt: entity.authorizedAt,
      capturedAt: entity.capturedAt,
      settledAt: entity.settledAt,
      expiresAt: entity.expiresAt,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    },
    entity.version,
  );
}

function toPersistence(payment: Payment): PaymentEntity {
  const entity = new PaymentEntity();
  entity.id = payment.id;
  entity.merchantId = payment.merchantId;
  entity.userId = payment.userId;
  entity.counterpartyUserId = payment.counterpartyUserId;
  entity.direction = payment.direction;
  entity.status = payment.status;
  entity.amountMinor = payment.amount.amount;
  entity.feeMinor = payment.fee.amount;
  entity.refundedMinor = payment.refundedAmount.amount;
  entity.currency = payment.amount.currencyCode;
  entity.method = payment.method;
  entity.reference = payment.reference;
  entity.providerReference = payment.providerReference;
  entity.transferId = payment.transferId;
  entity.refundTransferId = payment.refundTransferId;
  entity.refundAmountMinor = payment.refundAmount?.amount.toString() ?? null;
  entity.idempotencyKey = payment.idempotencyKey;
  entity.failureReason = payment.failureReason;
  entity.failureDetail = payment.failureDetail;
  entity.metadata = { ...payment.metadata };
  entity.authorizedAt = payment.authorizedAt;
  entity.capturedAt = payment.capturedAt;
  entity.settledAt = payment.settledAt;
  entity.expiresAt = payment.expiresAt;
  return entity;
}
