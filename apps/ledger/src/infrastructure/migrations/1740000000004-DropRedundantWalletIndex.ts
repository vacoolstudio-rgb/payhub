import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes an index that another index already covers.
 *
 * `ix_wallets_user (user_id)` is a strict prefix of
 * `uq_wallets_user_currency (user_id, currency)`, so every lookup the
 * narrow index could serve, the composite one serves too. A redundant
 * index is not free: it is maintained on every insert and update of the
 * table, occupies its own share of the buffer cache, and gives the
 * planner one more path to cost out for no gain.
 */
export class DropRedundantWalletIndex1740000000004 implements MigrationInterface {
  name = 'DropRedundantWalletIndex1740000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO ledger, public`);
    await queryRunner.query(`DROP INDEX IF EXISTS ix_wallets_user`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO ledger, public`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS ix_wallets_user ON wallets (user_id)`);
  }
}
