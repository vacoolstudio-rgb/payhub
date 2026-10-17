import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the append-only guarantee from the postings to the entries.
 *
 * `postings` — the amounts — were already protected by a trigger, and the
 * foreign key is `ON DELETE RESTRICT`, so no entry with postings could be
 * removed. But the entry row itself stayed writable, and the entry is
 * what records *why* the money moved: its purpose, its description, the
 * payment it belongs to. An `UPDATE ledger.journal_entries SET
 * description = …` succeeded, which means the amounts were immutable
 * while the narrative explaining them was not.
 *
 * That is the half of an audit trail an auditor actually asks about. The
 * ledger never updates an entry in code — it only appends — so making the
 * database enforce it costs nothing and removes the gap.
 *
 * The trigger function is shared with the postings, so its message is
 * generalised here rather than duplicated.
 */
export class JournalEntriesAppendOnly1740000000005 implements MigrationInterface {
  name = 'JournalEntriesAppendOnly1740000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO ledger, public`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ledger_forbid_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only (attempted %)', TG_TABLE_NAME, TG_OP
          USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE OR REPLACE TRIGGER trg_journal_entries_append_only
        BEFORE UPDATE OR DELETE ON journal_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO ledger, public`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_journal_entries_append_only ON journal_entries`);
  }
}
