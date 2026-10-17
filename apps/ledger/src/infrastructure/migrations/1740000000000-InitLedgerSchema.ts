import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial ledger schema.
 *
 * Written as explicit SQL rather than generated from the entities: a
 * migration is a production change record, and hand-written DDL lets us add
 * the things the generator does not know about — CHECK constraints that
 * encode domain invariants, partial indexes, and an append-only trigger.
 */
export class InitLedgerSchema1740000000000 implements MigrationInterface {
  name = 'InitLedgerSchema1740000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO ledger, public`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        id              uuid PRIMARY KEY,
        user_id         uuid        NOT NULL,
        currency        varchar(4)  NOT NULL,
        available_minor bigint      NOT NULL DEFAULT 0,
        pending_minor   bigint      NOT NULL DEFAULT 0,
        status          varchar(16) NOT NULL DEFAULT 'active',
        version         integer     NOT NULL DEFAULT 1,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        -- A user wallet is a liability account: it can never go negative.
        -- Enforced in the database as well as in the aggregate, because a
        -- bug in one new code path must not be able to create money.
        CONSTRAINT ck_wallets_no_overdraft CHECK (available_minor >= 0 AND pending_minor >= 0),
        CONSTRAINT ck_wallets_status CHECK (status IN ('active', 'frozen', 'closed'))
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_wallets_user_currency ON wallets (user_id, currency)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS ix_wallets_user ON wallets (user_id)`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id          uuid PRIMARY KEY,
        payment_id  uuid,
        user_id     uuid,
        purpose     varchar(24) NOT NULL,
        description text        NOT NULL,
        posted_at   timestamptz NOT NULL,
        reversed_by uuid REFERENCES journal_entries (id),
        reverses    uuid REFERENCES journal_entries (id),
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_journal_payment ON journal_entries (payment_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_journal_user_posted ON journal_entries (user_id, posted_at DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS postings (
        id           bigserial PRIMARY KEY,
        entry_id     uuid        NOT NULL REFERENCES journal_entries (id) ON DELETE RESTRICT,
        account      varchar(128) NOT NULL,
        account_kind varchar(24)  NOT NULL,
        owner_id     varchar(64),
        currency     varchar(4)   NOT NULL,
        direction    varchar(6)   NOT NULL,
        amount_minor bigint       NOT NULL,
        posted_at    timestamptz  NOT NULL,
        payment_id   uuid,
        CONSTRAINT ck_postings_direction CHECK (direction IN ('debit', 'credit')),
        -- Direction carries the sign; a negative amount would double-negate.
        CONSTRAINT ck_postings_positive CHECK (amount_minor > 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_postings_account_posted ON postings (account, posted_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_postings_owner_posted ON postings (owner_id, currency, posted_at DESC, id DESC)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS ix_postings_entry ON postings (entry_id)`);

    // Append-only enforcement. Application code is not the last line of
    // defence for an audit trail; the database is.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ledger_forbid_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'postings are append-only (attempted %)', TG_OP
          USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_postings_append_only
        BEFORE UPDATE OR DELETE ON postings
        FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation()
    `);

    await this.createOutboxTables(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO ledger, public`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_postings_append_only ON postings`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS ledger_forbid_mutation()`);
    await queryRunner.query(`DROP TABLE IF EXISTS postings`);
    await queryRunner.query(`DROP TABLE IF EXISTS journal_entries`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallets`);
    await queryRunner.query(`DROP TABLE IF EXISTS processed_messages`);
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_messages`);
  }

  private async createOutboxTables(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS outbox_messages (
        id             uuid PRIMARY KEY,
        aggregate_type varchar(64)  NOT NULL,
        aggregate_id   varchar(64)  NOT NULL,
        event_type     varchar(128) NOT NULL,
        topic          varchar(255) NOT NULL,
        partition_key  varchar(128) NOT NULL,
        payload        jsonb        NOT NULL,
        headers        jsonb        NOT NULL DEFAULT '{}'::jsonb,
        status         varchar(16)  NOT NULL DEFAULT 'pending',
        attempts       integer      NOT NULL DEFAULT 0,
        available_at   timestamptz  NOT NULL DEFAULT now(),
        occurred_at    timestamptz  NOT NULL,
        created_at     timestamptz  NOT NULL DEFAULT now(),
        published_at   timestamptz,
        last_error     text
      )
    `);

    // Partial index: the relay only ever reads pending rows, and published
    // ones (the vast majority) stay out of the index entirely.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_outbox_dispatch
        ON outbox_messages (available_at, created_at)
        WHERE status = 'pending'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_outbox_aggregate
        ON outbox_messages (aggregate_type, aggregate_id)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id     uuid         NOT NULL,
        consumer_group varchar(128) NOT NULL,
        event_type     varchar(128) NOT NULL,
        processed_at   timestamptz  NOT NULL DEFAULT now(),
        result         jsonb,
        PRIMARY KEY (message_id, consumer_group)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_processed_messages_processed_at
        ON processed_messages (processed_at)
    `);
  }
}
