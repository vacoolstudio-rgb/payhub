import { Column, CreateDateColumn, Entity, Index, OneToMany, PrimaryColumn } from 'typeorm';
import { PostingEntity } from './posting.entity.js';

/** Journal header. Immutable once written, except for the reversal pointer. */
@Entity({ name: 'journal_entries' })
@Index('ix_journal_payment', ['paymentId'])
@Index('ix_journal_user_posted', ['userId', 'postedAt'])
export class JournalEntryEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'payment_id', nullable: true })
  paymentId!: string | null;

  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar', length: 24 })
  purpose!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'timestamptz', name: 'posted_at' })
  postedAt!: Date;

  @Column({ type: 'uuid', name: 'reversed_by', nullable: true })
  reversedBy!: string | null;

  @Column({ type: 'uuid', name: 'reverses', nullable: true })
  reverses!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @OneToMany(
    () => PostingEntity,
    (posting) => posting.entry,
    { cascade: ['insert'] },
  )
  postings!: PostingEntity[];
}
