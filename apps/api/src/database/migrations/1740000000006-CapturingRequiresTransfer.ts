import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A capturing payment must carry the transfer id it is capturing under.
 *
 * `Payment.beginCapture` sets the status and the id in the same step, so
 * the invariant has always held — in code. Nothing enforced it in the
 * database, and the stuck-payment sweep quietly depended on it: finding
 * a `capturing` row with no id, it generated a fresh one and re-issued
 * the ledger command. The ledger deduplicates on `transferId`, so a new
 * id is not a retry, it is a second transfer — and the cron would mint
 * another one every five minutes.
 *
 * The sweep now refuses such a row and alerts instead. This constraint is
 * the other half: the state it refuses to act on can no longer be
 * written in the first place.
 */
export class CapturingRequiresTransfer1740000000006 implements MigrationInterface {
  name = 'CapturingRequiresTransfer1740000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO payhub, public`);

    await queryRunner.query(`
      ALTER TABLE payments
        ADD CONSTRAINT ck_payments_capturing_has_transfer
        CHECK (status <> 'capturing' OR transfer_id IS NOT NULL)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO payhub, public`);
    await queryRunner.query(
      `ALTER TABLE payments DROP CONSTRAINT IF EXISTS ck_payments_capturing_has_transfer`,
    );
  }
}
