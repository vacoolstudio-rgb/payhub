import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { minorUnitsTransformer } from '@payhub/persistence';
// Type-only import on purpose: `journal-entry.entity.ts` imports this file
// for its @OneToMany, so a value import would close an ESM cycle and the
// decorator metadata would read the class before it is initialised.
import type { JournalEntryEntity } from './journal-entry.entity.js';

/**
 * One side of a journal entry. Append-only: there is no update path.
 *
 * `account` is denormalised onto the row (rather than joined through an
 * accounts table) so the statement query — the hottest read in the ledger —
 * is a single index range scan.
 */
@Entity({ name: 'postings' })
@Index('ix_postings_account_posted', ['account', 'postedAt'])
@Index('ix_postings_owner_posted', ['ownerId', 'currency', 'postedAt'])
@Index('ix_postings_entry', ['entryId'])
export class PostingEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @Column({ type: 'uuid', name: 'entry_id' })
  entryId!: string;

  /**
   * String-form relation plus `Relation<T>`: TypeORM's own answer to
   * circular entity imports under ESM. The string is resolved from the
   * entity registry at runtime, so no import is needed at all.
   */
  @ManyToOne('JournalEntryEntity', 'postings', { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'entry_id' })
  entry!: Relation<JournalEntryEntity>;

  @Column({ type: 'varchar', length: 128 })
  account!: string;

  @Column({ type: 'varchar', length: 24, name: 'account_kind' })
  accountKind!: string;

  @Column({ type: 'varchar', length: 64, name: 'owner_id', nullable: true })
  ownerId!: string | null;

  @Column({ type: 'varchar', length: 4 })
  currency!: string;

  @Column({ type: 'varchar', length: 6 })
  direction!: 'debit' | 'credit';

  @Column({ type: 'bigint', name: 'amount_minor', transformer: minorUnitsTransformer })
  amountMinor!: bigint;

  @Column({ type: 'timestamptz', name: 'posted_at' })
  postedAt!: Date;

  @Column({ type: 'uuid', name: 'payment_id', nullable: true })
  paymentId!: string | null;
}
