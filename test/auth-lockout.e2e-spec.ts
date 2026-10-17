import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { TransactionManager, TransactionalContext, createDataSource } from '@payhub/persistence';
import { OutboxPublisher } from '@payhub/messaging';
import { AuthService } from '../apps/api/src/modules/identity/application/auth.service.js';
import {
  PASSWORD_HASHER,
  SESSION_REPOSITORY,
  USER_REPOSITORY,
} from '../apps/api/src/modules/identity/domain/identity.ports.js';
import { TOKEN_ISSUER } from '../apps/api/src/modules/identity/application/token-issuer.port.js';
import {
  TypeOrmRefreshSessionRepository,
  TypeOrmUserRepository,
} from '../apps/api/src/modules/identity/infrastructure/persistence/repositories/typeorm-identity.repositories.js';
import { UserEntity } from '../apps/api/src/modules/identity/infrastructure/persistence/entities/user.entity.js';
import { RefreshSessionEntity } from '../apps/api/src/modules/identity/infrastructure/persistence/entities/refresh-session.entity.js';
import { apiMigrations } from '../apps/api/src/database/migrations/index.js';

const EMAIL = 'victim@payhub.test';
const PASSWORD = 'correct horse battery staple';

/**
 * Brute-force protection, against a real transaction.
 *
 * This suite exists because the unit tests could not have caught the bug
 * it covers. `bindTestTransactions` runs the callback directly — it does
 * not roll back — so a failed login that increments the counter and then
 * throws looks perfectly correct there, and is silently undone in
 * production. The transaction boundary is the behaviour under test, so it
 * has to be a real one.
 */
describe('Login lockout (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let moduleRef: TestingModule;
  let auth: AuthService;

  /** Real argon2 would make this suite minutes long for no extra coverage. */
  const hasher = {
    hash: async (plaintext: string) => `hashed:${plaintext}`,
    verify: async (stored: string, plaintext: string) => stored === `hashed:${plaintext}`,
    needsRehash: () => false,
  };

  const counters = async (): Promise<{ attempts: number; lockedUntil: Date | null; status: string }> => {
    const [row] = (await dataSource.query(
      'SELECT failed_login_attempts, locked_until, status FROM payhub.users WHERE email = $1',
      [EMAIL],
    )) as Array<{ failed_login_attempts: number; locked_until: Date | null; status: string }>;

    return {
      attempts: row!.failed_login_attempts,
      lockedUntil: row!.locked_until,
      status: row!.status,
    };
  };

  const failLogin = () =>
    auth.login({ email: EMAIL, password: 'not the password', userAgent: 'test', ip: '10.0.0.1' });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('payhub')
      .withUsername('payhub')
      .withPassword('payhub')
      .start();

    dataSource = createDataSource({
      config: {
        url: container.getConnectionUri(),
        schema: 'payhub',
        poolMax: 10,
        poolMin: 1,
        ssl: false,
        logging: false,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 5_000,
        runMigrations: false,
      },
      schema: 'payhub',
      entities: [UserEntity, RefreshSessionEntity],
      migrations: apiMigrations,
      applicationName: 'payhub-lockout-test',
    });

    await dataSource.initialize();
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS payhub');
    await dataSource.runMigrations({ transaction: 'each' });

    moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } })],
      providers: [
        AuthService,
        { provide: DataSource, useValue: dataSource },
        {
          provide: TransactionManager,
          inject: [DataSource, ClsService],
          useFactory: (ds: DataSource, cls: ClsService) => new TransactionManager(ds, cls),
        },
        { provide: USER_REPOSITORY, useClass: TypeOrmUserRepository },
        { provide: SESSION_REPOSITORY, useClass: TypeOrmRefreshSessionRepository },
        { provide: PASSWORD_HASHER, useValue: hasher },
        {
          provide: TOKEN_ISSUER,
          useValue: {
            issue: async () => ({
              accessToken: 'access',
              refreshToken: randomUUID(),
              accessExpiresAt: new Date(Date.now() + 900_000),
              refreshExpiresAt: new Date(Date.now() + 86_400_000),
              tokenType: 'Bearer',
            }),
            verifyAccessToken: vi.fn(),
          },
        },
        { provide: OutboxPublisher, useValue: { publish: vi.fn().mockResolvedValue('id') } },
      ],
    }).compile();

    TransactionalContext.bind(moduleRef.get(TransactionManager));
    auth = moduleRef.get(AuthService);
  }, 180_000);

  afterAll(async () => {
    TransactionalContext.reset();
    await moduleRef?.close();
    await dataSource?.destroy();
    await container?.stop();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE payhub.refresh_sessions, payhub.users CASCADE');
    await auth.register({
      email: EMAIL,
      password: PASSWORD,
      displayName: 'Victim',
      userAgent: 'test',
      ip: '10.0.0.1',
    });
  });

  /**
   * Regression. `login` is `@Transactional`, and the failure path reads
   *
   *   user.recordFailedLogin(); await users.save(user); throw …
   *
   * The throw rolls the transaction back, taking the increment with it.
   * Six wrong passwords left the counter at zero: the threshold, the
   * `UserLocked` event and both database columns were dead code, and an
   * attacker had unlimited guesses per account.
   */
  it('counts a failed attempt even though the request fails', async () => {
    await expect(failLogin()).rejects.toThrow();

    expect((await counters()).attempts).toBe(1);
  });

  it('keeps counting across attempts', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(failLogin()).rejects.toThrow();
    }

    expect((await counters()).attempts).toBe(3);
  });

  it('locks the account once the threshold is reached', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(failLogin()).rejects.toThrow();
    }

    const { attempts, lockedUntil, status } = await counters();

    expect(attempts).toBe(5);
    expect(status).toBe('locked');
    expect(lockedUntil?.getTime()).toBeGreaterThan(Date.now());
  });

  /** A locked account refuses the *right* password too, or it is not a lock. */
  it('refuses the correct password while locked', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(failLogin()).rejects.toThrow();
    }

    await expect(
      auth.login({ email: EMAIL, password: PASSWORD, userAgent: 'test', ip: '10.0.0.1' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
  });

  it('clears the counter after a successful login', async () => {
    await expect(failLogin()).rejects.toThrow();

    await auth.login({ email: EMAIL, password: PASSWORD, userAgent: 'test', ip: '10.0.0.1' });

    expect((await counters()).attempts).toBe(0);
  });

  /** An unknown address must not be distinguishable from a wrong password. */
  it('does not create or lock anything for an unknown account', async () => {
    await expect(
      auth.login({ email: 'nobody@payhub.test', password: PASSWORD, userAgent: 't', ip: '10.0.0.1' }),
    ).rejects.toThrow();

    const rows = (await dataSource.query(
      'SELECT count(*)::int AS count FROM payhub.users',
    )) as Array<{ count: number }>;

    expect(rows[0]?.count).toBe(1);
  });
});
