import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type OutboxStatus = 'pending' | 'publishing' | 'published' | 'dead';

/**
 * Transactional outbox.
 *
 * A row is written in the *same* transaction as the state change, so the
 * event and the fact it describes commit atomically. Publishing to Kafka
 * happens afterwards from a relay: we trade "exactly once" (impossible across
 * two systems without 2PC) for "at least once + idempotent consumers", which
 * is what actually ships.
 */
@Entity({ name: 'outbox_messages' })
@Index('ix_outbox_dispatch', ['status', 'availableAt'])
@Index('ix_outbox_aggregate', ['aggregateType', 'aggregateId'])
export class OutboxMessageEntity {
  /** Also the Kafka message id — consumers deduplicate on it. */
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  aggregateType!: string;

  @Column({ type: 'varchar', length: 64 })
  aggregateId!: string;

  @Column({ type: 'varchar', length: 128 })
  eventType!: string;

  @Column({ type: 'varchar', length: 255 })
  topic!: string;

  /** Kafka partition key — same aggregate ⇒ same partition ⇒ ordered. */
  @Column({ type: 'varchar', length: 128 })
  partitionKey!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  headers!: Record<string, string>;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: OutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  /** Backoff marker: the relay ignores rows scheduled in the future. */
  @Column({ type: 'timestamptz' })
  availableAt!: Date;

  @Column({ type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;
}
