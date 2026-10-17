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

@Entity({ name: 'merchants' })
@Index('ix_merchants_owner', ['ownerUserId'])
export class MerchantEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'owner_user_id' })
  ownerUserId!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: string;

  @Column({ type: 'int', name: 'fee_basis_points', default: 290 })
  feeBasisPoints!: number;

  @Column({
    type: 'bigint',
    name: 'fee_fixed_minor',
    default: 30,
    transformer: minorUnitsTransformer,
  })
  feeFixedMinor!: bigint;

  @Column({
    type: 'bigint',
    name: 'fee_minimum_minor',
    default: 0,
    transformer: minorUnitsTransformer,
  })
  feeMinimumMinor!: bigint;

  @Column({ type: 'bigint', name: 'fee_maximum_minor', nullable: true })
  feeMaximumMinor!: string | null;

  @Column({ type: 'text', name: 'webhook_url', nullable: true })
  webhookUrl!: string | null;

  /** Signing secret. Encrypted at rest in a real deployment (pgcrypto/KMS). */
  @Column({ type: 'text', name: 'webhook_secret', nullable: true })
  webhookSecret!: string | null;

  @Column({ type: 'text', array: true, name: 'webhook_events', default: () => `ARRAY['*']::text[]` })
  webhookEvents!: string[];

  @Column({ type: 'boolean', name: 'webhook_active', default: true })
  webhookActive!: boolean;

  @Column({
    type: 'text',
    array: true,
    name: 'supported_currencies',
    default: () => `ARRAY['USD','EUR']::text[]`,
  })
  supportedCurrencies!: string[];

  @VersionColumn()
  version!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
