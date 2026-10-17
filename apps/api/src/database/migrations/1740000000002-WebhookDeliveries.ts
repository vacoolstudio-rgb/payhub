import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Webhook delivery log.
 *
 * The queue is not the record. BullMQ can lose its Redis state (eviction, a
 * flushed instance, a failed failover) and a merchant asking "did you ever
 * call us about payment X?" needs an answer that survives that. The queue
 * drives the retry schedule; this table is the audit trail.
 */
export class WebhookDeliveries1740000000002 implements MigrationInterface {
  name = 'WebhookDeliveries1740000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO payhub, public`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id            uuid PRIMARY KEY,
        merchant_id   uuid         NOT NULL,
        event_id      uuid         NOT NULL,
        event_type    varchar(128) NOT NULL,
        endpoint_url  text         NOT NULL,
        payload       jsonb        NOT NULL,
        status        varchar(16)  NOT NULL DEFAULT 'pending',
        attempts      integer      NOT NULL DEFAULT 0,
        max_attempts  integer      NOT NULL DEFAULT 8,
        next_attempt_at timestamptz,
        last_status_code integer,
        last_error    text,
        response_body text,
        duration_ms   integer,
        delivered_at  timestamptz,
        created_at    timestamptz  NOT NULL DEFAULT now(),
        updated_at    timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT ck_webhook_status CHECK (status IN ('pending','delivering','delivered','failed','dead'))
      )
    `);

    // One delivery per (merchant, event): a Kafka redelivery of the same
    // payment event must not produce a second webhook.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_merchant_event
        ON webhook_deliveries (merchant_id, event_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_webhook_pending
        ON webhook_deliveries (next_attempt_at)
        WHERE status IN ('pending', 'delivering')
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_webhook_merchant_created
        ON webhook_deliveries (merchant_id, created_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO payhub, public`);
    await queryRunner.query(`DROP TABLE IF EXISTS webhook_deliveries`);
  }
}
