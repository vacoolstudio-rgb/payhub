import { Injectable } from '@nestjs/common';
import { type CursorPage, buildPage, decodeCursor } from '@payhub/kernel';
import { TransactionManager, TypeOrmRepositoryBase } from '@payhub/persistence';
import {
  JournalEntry,
  type TransferId,
} from '../../../domain/ledger/journal-entry.aggregate.js';
import type {
  JournalEntryRepository,
  StatementFilter,
  StatementRow,
} from '../../../domain/ledger/journal-entry.repository.js';
import { JournalEntryEntity } from '../entities/journal-entry.entity.js';
import { PostingEntity } from '../entities/posting.entity.js';
import { JournalEntryMapper } from '../mappers/journal-entry.mapper.js';

@Injectable()
export class TypeOrmJournalRepository
  extends TypeOrmRepositoryBase<JournalEntryEntity>
  implements JournalEntryRepository
{
  constructor(transactions: TransactionManager) {
    super(transactions, JournalEntryEntity);
  }

  /**
   * Eager-joins the postings in one query.
   *
   * The N+1 trap: `find({ relations: ['postings'] })` on a list of entries
   * issues one query per entry with TypeORM's lazy strategy. A single join —
   * or `relationLoadStrategy: 'query'` for large fan-outs — keeps it at one
   * or two round trips.
   */
  async findById(id: TransferId): Promise<JournalEntry | null> {
    const entity = await this.repository
      .createQueryBuilder('entry')
      .leftJoinAndSelect('entry.postings', 'posting')
      .where('entry.id = :id', { id })
      .orderBy('posting.id', 'ASC')
      .getOne();

    return entity ? JournalEntryMapper.toDomain(entity) : null;
  }

  /** Existence check without hydrating the aggregate. */
  async exists(id: TransferId): Promise<boolean> {
    return this.repository.exists({ where: { id } });
  }

  async append(entry: JournalEntry): Promise<void> {
    const header = JournalEntryMapper.toPersistence(entry);

    // The header insert carries the unique-id guarantee; the postings go in
    // as one multi-row INSERT rather than N statements.
    await this.manager.insert(JournalEntryEntity, {
      id: header.id,
      paymentId: header.paymentId,
      userId: header.userId,
      purpose: header.purpose,
      description: header.description,
      postedAt: header.postedAt,
      reversedBy: header.reversedBy,
      reverses: header.reverses,
    });

    await this.manager
      .createQueryBuilder()
      .insert()
      .into(PostingEntity)
      .values(
        header.postings.map((posting) => ({
          entryId: posting.entryId,
          account: posting.account,
          accountKind: posting.accountKind,
          ownerId: posting.ownerId,
          currency: posting.currency,
          direction: posting.direction,
          amountMinor: posting.amountMinor,
          postedAt: posting.postedAt,
          paymentId: posting.paymentId,
        })),
      )
      .execute();
  }

  async markReversed(id: TransferId, reversalId: TransferId): Promise<void> {
    await this.repository.update({ id }, { reversedBy: reversalId });
  }

  /**
   * Keyset-paginated statement.
   *
   * Sorted by `(posted_at DESC, id DESC)` with a composite comparison in the
   * WHERE clause, which Postgres can satisfy from `ix_postings_owner_posted`
   * without a sort. OFFSET would re-scan every skipped row and, worse, skip
   * or duplicate entries when a new posting lands between two pages.
   */
  async statement(filter: StatementFilter): Promise<CursorPage<StatementRow>> {
    const limit = Math.min(Math.max(filter.limit, 1), 200);
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : null;

    const query = this.manager
      .createQueryBuilder(PostingEntity, 'posting')
      .innerJoin(JournalEntryEntity, 'entry', 'entry.id = posting.entry_id')
      .select([
        'posting.id AS id',
        'posting.entry_id AS "transferId"',
        'posting.account AS account',
        'posting.direction AS direction',
        'posting.amount_minor AS "amountMinor"',
        'posting.currency AS currency',
        'posting.posted_at AS "postedAt"',
        'posting.payment_id AS "paymentId"',
        'entry.purpose AS purpose',
        'entry.description AS description',
      ])
      .where('posting.owner_id = :userId', { userId: filter.userId })
      .andWhere("posting.account_kind IN ('user_available', 'user_pending')");

    if (filter.currency) {
      query.andWhere('posting.currency = :currency', { currency: filter.currency });
    }
    if (filter.from) {
      query.andWhere('posting.posted_at >= :from', { from: filter.from });
    }
    if (filter.to) {
      query.andWhere('posting.posted_at < :to', { to: filter.to });
    }
    if (filter.purpose) {
      query.andWhere('entry.purpose = :purpose', { purpose: filter.purpose });
    }
    if (cursor) {
      query.andWhere('(posting.posted_at, posting.id) < (:cursorAt, :cursorId)', {
        cursorAt: cursor.createdAt,
        cursorId: cursor.id,
      });
    }

    const rows = await query
      .orderBy('posting.posted_at', 'DESC')
      .addOrderBy('posting.id', 'DESC')
      .limit(limit + 1)
      .getRawMany<StatementRow & { id: string }>();

    return buildPage(rows, limit, (row) => ({
      createdAt: new Date(row.postedAt).toISOString(),
      id: row.id,
    }));
  }

  /**
   * Trial balance: every account's balance as of a point in time.
   *
   * In a correct double-entry ledger the signed sum across all accounts is
   * exactly zero. Reconciliation asserts that, which catches a whole class
   * of bugs (a dropped posting, a bad migration) that per-wallet checks miss.
   */
  async trialBalance(
    currency: string,
    asOf: Date,
  ): Promise<Array<{ account: string; balanceMinor: string }>> {
    return (await this.manager.query(
      `
      SELECT account,
             SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END)::text AS "balanceMinor"
      FROM postings
      WHERE currency = $1 AND posted_at < $2
      GROUP BY account
      ORDER BY account
      `,
      [currency, asOf],
    )) as Array<{ account: string; balanceMinor: string }>;
  }
}
