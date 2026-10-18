import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the two reversal foreign keys.
 *
 * A foreign key creates an index on the *parent* side only. The child
 * columns — here `journal_entries.reverses` and `.reversed_by`, which
 * point at other journal entries — had none, so every check of that
 * constraint, and every join that follows a reversal, scans the whole
 * journal. On an append-only table that grows forever, that is the one
 * scan nobody notices until it is slow.
 *
 * Both are partial: a reversal is rare, so the index covers the handful
 * of rows that have one rather than a null for every entry ever written.
 */
export class ReversalForeignKeyIndexes1740000000009 implements MigrationInterface {
  name = 'ReversalForeignKeyIndexes1740000000009';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO ledger, public`);
    await queryRunner.query(`SET lock_timeout = '3s'`);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_journal_reverses
        ON journal_entries (reverses) WHERE reverses IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_journal_reversed_by
        ON journal_entries (reversed_by) WHERE reversed_by IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO ledger, public`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS ix_journal_reversed_by`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS ix_journal_reverses`);
  }
}
