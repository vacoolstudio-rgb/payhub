import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the relay's index usable by the relay's query.
 *
 * `ix_outbox_dispatch` was partial on `status = 'pending'`. The poll it
 * exists for reads `status IN ('pending', 'publishing')` — it has to,
 * because a row left in `publishing` by a crashed relay must be picked
 * up again. A partial index is only usable when the query's predicate
 * implies the index's, and `IN ('pending','publishing')` does not imply
 * `= 'pending'`, so the index was never used at all.
 *
 * Measured on 201 814 rows with a 1 600-row backlog, the two plans for
 * the same query on the same data:
 *
 *   predicate `status = 'pending'`   6 731 buffers   28.4 ms   Seq Scan
 *   predicate matching the query       123 buffers    0.26 ms   Index Scan
 *
 * The ratio is not the point. The point is what each plan scales with:
 * the sequential scan grows with everything the table has ever held,
 * and the relay runs this query continuously, so a table that grows
 * faster than the cleanup job trims it ends with a relay that cannot
 * keep up — which is the failure mode the outbox pattern exists to
 * avoid. The index scan grows with the size of the backlog, which is
 * the thing actually being worked through.
 *
 * `dead` stays out: those rows are not dispatchable and are the reason
 * the predicate is not simply `status <> 'published'`.
 */
export class OutboxDispatchIndexPredicate1740000000010 implements MigrationInterface {
  name = 'OutboxDispatchIndexPredicate1740000000010';

  /** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO payhub, public`);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_outbox_dispatch_v2
        ON outbox_messages (available_at, created_at)
        WHERE status IN ('pending', 'publishing')
    `);

    // Only once the replacement exists: dropping first would leave the
    // relay without an index for the length of the build.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS ix_outbox_dispatch`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO payhub, public`);

    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_outbox_dispatch
        ON outbox_messages (available_at, created_at)
        WHERE status = 'pending'
    `);

    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS ix_outbox_dispatch_v2`);
  }
}
