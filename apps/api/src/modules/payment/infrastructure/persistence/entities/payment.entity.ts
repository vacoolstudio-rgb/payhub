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

@Entity({ name: 'payments' })
// Composite indexes ordered to match the dashboard's query shape: filter by
// owner, then by status, sorted by time. A separate index per column would
// force a bitmap-or and a sort.
@Index('ix_payments_user_created', ['userId', 'createdAt'])
@Index('ix_payments_merchant_created', ['merchantId', 'createdAt'])
@Index('ix_payments_status_expires', ['status', 'expiresAt'])
@Index('ix_payments_transfer', ['transferId'])
export class PaymentEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'merchant_id' })
  merchantId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'counterparty_user_id', nullable: true })
  counterpartyUserId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  direction!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: string;

  @Column({ type: 'bigint', name: 'amount_minor', transformer: minorUnitsTransformer })
  amountMinor!: bigint;

  @Column({ type: 'bigint', name: 'fee_minor', transformer: minorUnitsTransformer })
  feeMinor!: bigint;

  @Column({
    type: 'bigint',
    name: 'refunded_minor',
    default: 0,
    transformer: minorUnitsTransformer,
  })
  refundedMinor!: bigint;

  @Column({ type: 'varchar', length: 4 })
  currency!: string;

  @Column({ type: 'varchar', length: 32 })
  method!: string;

  @Column({ type: 'varchar', length: 64 })
  reference!: string;

  @Column({ type: 'varchar', length: 128, name: 'provider_reference', nullable: true })
  providerReference!: string | null;

  @Column({ type: 'uuid', name: 'transfer_id', nullable: true })
  transferId!: string | null;

  /** The transfer a refund in flight will be posted under, if any. */
  @Column({ type: 'uuid', name: 'refund_transfer_id', nullable: true })
  refundTransferId!: string | null;

  /** Its amount, so a recovery re-sends what was asked for. */
  @Column({ type: 'bigint', name: 'refund_amount_minor', nullable: true })
  refundAmountMinor!: string | null;

  @Column({ type: 'varchar', length: 255, name: 'idempotency_key', nullable: true })
  idempotencyKey!: string | null;

  @Column({ type: 'varchar', length: 32, name: 'failure_reason', nullable: true })
  failureReason!: string | null;

  @Column({ type: 'text', name: 'failure_detail', nullable: true })
  failureDetail!: string | null;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  metadata!: Record<string, string>;

  @Column({ type: 'timestamptz', name: 'authorized_at', nullable: true })
  authorizedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'captured_at', nullable: true })
  capturedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'settled_at', nullable: true })
  settledAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @VersionColumn()
  version!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
