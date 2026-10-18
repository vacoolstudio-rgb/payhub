import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A database-level guarantee that one idempotency key creates one payment.
 *
 * The key was stored on the row and enforced nowhere. The whole guarantee
 * lived in Redis — `IdempotencyInterceptor` claims `idem:<principal>:<route>:<key>`
 * with `SET NX` — which is fast and correct right up until Redis is
 * flushed, fails over, or evicts the key under memory pressure. Then two
 * retries of the same request become two payments, and nothing in
 * Postgres objects.
 *
 * Scoped to the user, not global. Redis scopes by principal, so a global
 * unique would be *stricter* than the behaviour it is backing: two
 * customers independently choosing the same key string is legitimate
 * traffic, and rejecting it would be a new bug rather than a backstop.
 *
 * Partial, because the column is null for anything created without a key
 * (internal flows, the seed), and several nulls must stay allowed.
 */
export class IdempotencyKeyUnique1740000000008 implements MigrationInterface {
  name = 'IdempotencyKeyUnique1740000000008';

  /** `CREATE UNIQUE INDEX CONCURRENTLY` cannot run inside a transaction. */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO payhub, public`);
    await queryRunner.query(`SET lock_timeout = '3s'`);

    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_payments_idempotency
        ON payments (user_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO payhub, public`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS ux_payments_idempotency`);
  }
}
