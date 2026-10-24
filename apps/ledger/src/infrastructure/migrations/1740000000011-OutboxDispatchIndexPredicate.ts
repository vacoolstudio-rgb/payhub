import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The ledger's copy of the same fix.
 *
 * Each context owns its own outbox table in its own schema, so the
 * index exists twice and has to be corrected twice. See the api
 * migration of the same name for the measurement: the poll reads
 * `status IN ('pending', 'publishing')` and the old partial index was
 * restricted to `status = 'pending'`, which a query predicate of `IN`
 * does not imply — so the planner could never use it.
 */
export class OutboxDispatchIndexPredicate1740000000011 implements MigrationInterface {
  name = 'OutboxDispatchIndexPredicate1740000000011';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO ledger, public`);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_outbox_dispatch_v2
        ON outbox_messages (available_at, created_at)
        WHERE status IN ('pending', 'publishing')
    `);

    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS ix_outbox_dispatch`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO ledger, public`);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_outbox_dispatch
        ON outbox_messages (available_at, created_at)
        WHERE status = 'pending'
    `);

    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS ix_outbox_dispatch_v2`);
  }
}
