import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records the transfer a refund in flight will be posted under.
 *
 * The capture path has always stored its `transfer_id`, which is what
 * lets the stuck-payment sweep re-issue the *same* ledger command
 * idempotently. The refund path minted its id inside the handler, sent
 * it to the outbox and forgot it — so a payment left in `refunding` by a
 * crash had nothing to retry by, and no sweep could touch it without
 * risking a second refund.
 *
 * Nullable rather than conditionally required: unlike `capturing`, the
 * state is cleared on both exits (completed and cancelled), and back-
 * filling a value for rows stranded before this migration is not
 * possible — those are exactly the ones needing a human.
 */
export class RefundTransferId1740000000007 implements MigrationInterface {
  name = 'RefundTransferId1740000000007';

  /** See the index below: `CONCURRENTLY` cannot run inside a transaction. */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO payhub, public`);
    await queryRunner.query(`SET lock_timeout = '3s'`);

    // Nullable and without a default, so this is a catalogue-only change:
    // instant on PostgreSQL 11+, no table rewrite.
    await queryRunner.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_transfer_id uuid`);
    // The amount too: the ledger ignores it on a duplicate, but if the
    // transfer never posted the retry must be for the amount originally
    // requested, which a partial refund makes different from the
    // outstanding balance.
    await queryRunner.query(
      `ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_amount_minor bigint`,
    );

    // The sweep looks for refunds that have been in flight too long.
    // Concurrently: `payments` is live by now, and a plain CREATE INDEX
    // would block every write to it for the duration of the build.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_payments_stalled_refunds
        ON payments (updated_at)
        WHERE status = 'refunding'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO payhub, public`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS ix_payments_stalled_refunds`);
    await queryRunner.query(`ALTER TABLE payments DROP COLUMN IF EXISTS refund_amount_minor`);
    await queryRunner.query(`ALTER TABLE payments DROP COLUMN IF EXISTS refund_transfer_id`);
  }
}
