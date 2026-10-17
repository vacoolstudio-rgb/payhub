import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the counterparty side of a payment listing index-ordered.
 *
 * A user's listing has to include transfers where they are the
 * *destination*, which was expressed as
 * `WHERE user_id = $1 OR counterparty_user_id = $1`. An `OR` across two
 * columns cannot be served by either column's index, so Postgres fell back
 * to a parallel sequential scan of the whole table plus a top-N sort —
 * measured at 9 839 buffers and 40 ms for one 25-row page over 400 000
 * payments, against 29 buffers and 0.24 ms for the merchant listing, which
 * is the same query without the `OR`. Worse, the cost grew with the size of
 * the table rather than with the size of the page, which is the one thing
 * keyset pagination exists to prevent.
 *
 * The query becomes a `UNION ALL` of two index-ordered branches (see
 * `TypeOrmPaymentRepository.list`), and this is the index the second branch
 * needs. It replaces `ix_payments_counterparty`, whose single column is a
 * prefix of this one and which is therefore redundant once this exists.
 *
 * Still partial: a counterparty is only set on internal transfers, so the
 * index covers a small fraction of the rows and stays out of the way of
 * every ordinary deposit.
 */
export class CounterpartyKeysetIndex1740000000003 implements MigrationInterface {
  name = 'CounterpartyKeysetIndex1740000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO payhub, public`);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_payments_counterparty_created
        ON payments (counterparty_user_id, created_at DESC, id DESC)
        WHERE counterparty_user_id IS NOT NULL
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS ix_payments_counterparty`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO payhub, public`);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_payments_counterparty
        ON payments (counterparty_user_id)
        WHERE counterparty_user_id IS NOT NULL
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS ix_payments_counterparty_created`);
  }
}
