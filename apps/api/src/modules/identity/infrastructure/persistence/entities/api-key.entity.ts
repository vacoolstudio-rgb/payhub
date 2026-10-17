import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'api_keys' })
@Index('uq_api_key_hash', ['keyHash'], { unique: true })
@Index('ix_api_keys_merchant', ['merchantId'])
export class ApiKeyEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'merchant_id' })
  merchantId!: string;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'char', length: 64, name: 'key_hash' })
  keyHash!: string;

  @Column({ type: 'varchar', length: 16 })
  prefix!: string;

  @Column({ type: 'char', length: 4 })
  last4!: string;

  @Column({ type: 'varchar', length: 8 })
  environment!: string;

  @Column({ type: 'text', array: true, default: () => `ARRAY[]::text[]` })
  scopes!: string[];

  @Column({ type: 'timestamptz', name: 'last_used_at', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
