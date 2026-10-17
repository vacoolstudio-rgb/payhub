import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { minorUnitsTransformer } from '@payhub/persistence';

/**
 * Balance projection.
 *
 * `(user_id, currency)` is unique, which is what makes `findOrOpen` safe
 * under concurrency: two simultaneous first deposits race on the index and
 * one of them loses with a 23505 that the repository turns into a re-read.
 */
@Entity({ name: 'wallets' })
@Index('uq_wallets_user_currency', ['userId', 'currency'], { unique: true })
@Index('ix_wallets_user', ['userId'])
export class WalletEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 4 })
  currency!: string;

  /**
   * bigint, never numeric/float. Minor units are integers by definition and
   * `numeric` would invite someone to store 10.005 cents.
   */
  @Column({
    type: 'bigint',
    name: 'available_minor',
    default: 0,
    transformer: minorUnitsTransformer,
  })
  availableMinor!: bigint;

  @Column({
    type: 'bigint',
    name: 'pending_minor',
    default: 0,
    transformer: minorUnitsTransformer,
  })
  pendingMinor!: bigint;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: string;

  /**
   * Optimistic lock. TypeORM bumps it on every `save()` and throws
   * `OptimisticLockVersionMismatchError` when the row changed underneath —
   * the safety net behind the pessimistic row lock.
   */
  @VersionColumn()
  version!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
