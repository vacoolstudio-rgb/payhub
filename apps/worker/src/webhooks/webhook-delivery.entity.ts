import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export type WebhookStatus = 'pending' | 'delivering' | 'delivered' | 'failed' | 'dead';

@Entity({ name: 'webhook_deliveries' })
@Index('uq_webhook_merchant_event', ['merchantId', 'eventId'], { unique: true })
@Index('ix_webhook_merchant_created', ['merchantId', 'createdAt'])
export class WebhookDeliveryEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'merchant_id' })
  merchantId!: string;

  @Column({ type: 'uuid', name: 'event_id' })
  eventId!: string;

  @Column({ type: 'varchar', length: 128, name: 'event_type' })
  eventType!: string;

  @Column({ type: 'text', name: 'endpoint_url' })
  endpointUrl!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: WebhookStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', name: 'max_attempts', default: 8 })
  maxAttempts!: number;

  @Column({ type: 'timestamptz', name: 'next_attempt_at', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ type: 'int', name: 'last_status_code', nullable: true })
  lastStatusCode!: number | null;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;

  @Column({ type: 'text', name: 'response_body', nullable: true })
  responseBody!: string | null;

  @Column({ type: 'int', name: 'duration_ms', nullable: true })
  durationMs!: number | null;

  @Column({ type: 'timestamptz', name: 'delivered_at', nullable: true })
  deliveredAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
