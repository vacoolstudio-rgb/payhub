import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Consumer-side deduplication table (the "inbox" half of the outbox pattern).
 *
 * Kafka gives at-least-once delivery; the handler becomes effectively
 * exactly-once by inserting this row **in the same transaction** as its side
 * effects. A duplicate delivery hits the primary key and is skipped.
 */
@Entity({ name: 'processed_messages' })
@Index('ix_processed_messages_processed_at', ['processedAt'])
export class ProcessedMessageEntity {
  @PrimaryColumn({ type: 'uuid' })
  messageId!: string;

  @PrimaryColumn({ type: 'varchar', length: 128 })
  consumerGroup!: string;

  @Column({ type: 'varchar', length: 128 })
  eventType!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  processedAt!: Date;

  /** Stored so a replay can return the original outcome instead of redoing work. */
  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;
}
