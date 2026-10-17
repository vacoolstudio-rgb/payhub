import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'refresh_sessions' })
@Index('uq_refresh_token_hash', ['tokenHash'], { unique: true })
@Index('ix_refresh_family', ['familyId'])
@Index('ix_refresh_user', ['userId'])
@Index('ix_refresh_expires', ['expiresAt'])
export class RefreshSessionEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** All tokens descended from one login share a family id. */
  @Column({ type: 'uuid', name: 'family_id' })
  familyId!: string;

  /**
   * SHA-256 of the token, not the token itself. A database leak then yields
   * nothing usable, and the lookup stays a single index hit (unlike argon2,
   * which cannot be used as a search key).
   */
  @Column({ type: 'char', length: 64, name: 'token_hash' })
  tokenHash!: string;

  @Column({ type: 'timestamptz', name: 'used_at', nullable: true })
  usedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'uuid', name: 'replaced_by', nullable: true })
  replacedBy!: string | null;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'varchar', length: 255, name: 'user_agent', nullable: true })
  userAgent!: string | null;

  @Column({ type: 'inet', nullable: true })
  ip!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
