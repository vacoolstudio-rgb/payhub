import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial schema for the API service: identity, merchants and payments.
 *
 * These three contexts share a database because they are deployed together
 * and a payment's authorisation genuinely needs the merchant row in the same
 * transaction. The ledger does not, which is why it lives in its own schema
 * behind an event contract.
 */
export class InitApiSchema1740000000001 implements MigrationInterface {
  name = 'InitApiSchema1740000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO payhub, public`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // --- identity ---------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                    uuid PRIMARY KEY,
        email                 varchar(254) NOT NULL,
        password_hash         varchar(255) NOT NULL,
        display_name          varchar(120) NOT NULL,
        roles                 text[]       NOT NULL DEFAULT ARRAY['user']::text[],
        status                varchar(16)  NOT NULL DEFAULT 'active',
        email_verified        boolean      NOT NULL DEFAULT false,
        failed_login_attempts integer      NOT NULL DEFAULT 0,
        locked_until          timestamptz,
        last_login_at         timestamptz,
        tokens_valid_from     timestamptz  NOT NULL DEFAULT now(),
        version               integer      NOT NULL DEFAULT 1,
        created_at            timestamptz  NOT NULL DEFAULT now(),
        updated_at            timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT ck_users_status CHECK (status IN ('active','locked','suspended','deleted')),
        CONSTRAINT ck_users_roles_not_empty CHECK (cardinality(roles) > 0)
      )
    `);

    // Case-insensitive uniqueness as a second line of defence: the domain
    // lowercases on construction, but a direct SQL insert would not.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (lower(email))`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS refresh_sessions (
        id          uuid PRIMARY KEY,
        user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        family_id   uuid        NOT NULL,
        token_hash  char(64)    NOT NULL,
        used_at     timestamptz,
        revoked_at  timestamptz,
        replaced_by uuid,
        expires_at  timestamptz NOT NULL,
        user_agent  varchar(255),
        ip          inet,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_refresh_token_hash ON refresh_sessions (token_hash)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_refresh_family ON refresh_sessions (family_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_refresh_user ON refresh_sessions (user_id)`,
    );
    // Partial index: the cleanup job only ever scans live sessions.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_refresh_expires
        ON refresh_sessions (expires_at)
        WHERE revoked_at IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id           uuid PRIMARY KEY,
        merchant_id  uuid        NOT NULL,
        name         varchar(80) NOT NULL,
        key_hash     char(64)    NOT NULL,
        prefix       varchar(16) NOT NULL,
        last4        char(4)     NOT NULL,
        environment  varchar(8)  NOT NULL,
        scopes       text[]      NOT NULL DEFAULT ARRAY[]::text[],
        last_used_at timestamptz,
        revoked_at   timestamptz,
        expires_at   timestamptz,
        created_at   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_api_keys_env CHECK (environment IN ('live','test'))
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_api_key_hash ON api_keys (key_hash)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_api_keys_merchant ON api_keys (merchant_id)`,
    );

    // --- merchants --------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS merchants (
        id                   uuid PRIMARY KEY,
        owner_user_id        uuid         NOT NULL REFERENCES users (id),
        name                 varchar(160) NOT NULL,
        status               varchar(16)  NOT NULL DEFAULT 'pending',
        fee_basis_points     integer      NOT NULL DEFAULT 290,
        fee_fixed_minor      bigint       NOT NULL DEFAULT 30,
        fee_minimum_minor    bigint       NOT NULL DEFAULT 0,
        fee_maximum_minor    bigint,
        webhook_url          text,
        webhook_secret       text,
        webhook_events       text[]       NOT NULL DEFAULT ARRAY['*']::text[],
        webhook_active       boolean      NOT NULL DEFAULT true,
        supported_currencies text[]       NOT NULL DEFAULT ARRAY['USD','EUR']::text[],
        version              integer      NOT NULL DEFAULT 1,
        created_at           timestamptz  NOT NULL DEFAULT now(),
        updated_at           timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT ck_merchants_status CHECK (status IN ('pending','active','suspended')),
        CONSTRAINT ck_merchants_fee_bps CHECK (fee_basis_points BETWEEN 0 AND 10000)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_merchants_owner ON merchants (owner_user_id)`,
    );

    // --- payments ---------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id                   uuid PRIMARY KEY,
        merchant_id          uuid         NOT NULL REFERENCES merchants (id),
        user_id              uuid         NOT NULL REFERENCES users (id),
        counterparty_user_id uuid REFERENCES users (id),
        direction            varchar(16)  NOT NULL,
        status               varchar(16)  NOT NULL DEFAULT 'pending',
        amount_minor         bigint       NOT NULL,
        fee_minor            bigint       NOT NULL DEFAULT 0,
        refunded_minor       bigint       NOT NULL DEFAULT 0,
        currency             varchar(4)   NOT NULL,
        method               varchar(32)  NOT NULL,
        reference            varchar(64)  NOT NULL,
        provider_reference   varchar(128),
        transfer_id          uuid,
        idempotency_key      varchar(255),
        failure_reason       varchar(32),
        failure_detail       text,
        metadata             jsonb        NOT NULL DEFAULT '{}'::jsonb,
        authorized_at        timestamptz,
        captured_at          timestamptz,
        settled_at           timestamptz,
        expires_at           timestamptz  NOT NULL,
        version              integer      NOT NULL DEFAULT 1,
        created_at           timestamptz  NOT NULL DEFAULT now(),
        updated_at           timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT ck_payments_amount_positive CHECK (amount_minor > 0),
        CONSTRAINT ck_payments_fee_non_negative CHECK (fee_minor >= 0),
        -- A refund can never exceed what was charged. Enforced here because
        -- "we refunded more than they paid" is unrecoverable in accounting.
        CONSTRAINT ck_payments_refund_bounded CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
        CONSTRAINT ck_payments_direction CHECK (direction IN ('deposit','withdrawal','transfer')),
        CONSTRAINT ck_payments_status CHECK (
          status IN ('pending','authorized','capturing','captured','refunding','refunded','cancelled','failed')
        ),
        CONSTRAINT ck_payments_transfer_needs_counterparty CHECK (
          direction <> 'transfer' OR counterparty_user_id IS NOT NULL
        )
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_payments_user_created ON payments (user_id, created_at DESC, id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_payments_merchant_created ON payments (merchant_id, created_at DESC, id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_payments_counterparty ON payments (counterparty_user_id) WHERE counterparty_user_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_transfer ON payments (transfer_id) WHERE transfer_id IS NOT NULL`,
    );
    // Drives the expiry cron: only non-terminal payments are ever scanned.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_payments_pending_expiry
        ON payments (expires_at)
        WHERE status IN ('pending','authorized','capturing')
    `);

    await this.createOutboxTables(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path TO payhub, public`);
    for (const table of [
      'payments',
      'merchants',
      'api_keys',
      'refresh_sessions',
      'users',
      'processed_messages',
      'outbox_messages',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${table}`);
    }
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
