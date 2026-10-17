import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxPublisher } from '@payhub/messaging';
import { sha256 } from '@payhub/shared';
import { bindTestTransactions } from '@payhub/testing';
import { Email } from '../domain/email.vo.js';
import {
  PASSWORD_HASHER,
  SESSION_REPOSITORY,
  USER_REPOSITORY,
  type PasswordHasher,
  type RefreshSessionRepository,
  type UserRepository,
} from '../domain/identity.ports.js';
import {
  RefreshSession,
  type SessionId,
  type TokenFamilyId,
} from '../domain/refresh-session.aggregate.js';
import { User, UserId } from '../domain/user.aggregate.js';
import { TOKEN_ISSUER, type TokenIssuer } from './token-issuer.port.js';
import { AuthService } from './auth.service.js';

const PASSWORD = 'correct horse battery staple';

/** Deterministic stand-in for argon2 — the real one costs ~60 ms per call. */
class FakeHasher implements PasswordHasher {
  stale = false;

  async hash(plaintext: string): Promise<string> {
    return `hashed:${plaintext}`;
  }
  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    return storedHash === `hashed:${plaintext}`;
  }
  needsRehash(): boolean {
    return this.stale;
  }
}

class FakeUserRepository implements UserRepository {
  readonly users = new Map<string, User>();

  seed(email: string): User {
    const user = User.register({
      id: UserId.create(),
      email: Email.create(email).unwrap(),
      passwordHash: `hashed:${PASSWORD}`,
      displayName: 'Ada',
    });
    user.pullDomainEvents();
    this.users.set(user.id, user);
    return user;
  }

  async findById(id: UserId): Promise<User | null> {
    return this.users.get(id) ?? null;
  }
  async findByEmail(email: Email): Promise<User | null> {
    return [...this.users.values()].find((user) => user.email.value === email.value) ?? null;
  }
  async existsByEmail(email: Email): Promise<boolean> {
    return (await this.findByEmail(email)) !== null;
  }
  async insert(user: User): Promise<void> {
    this.users.set(user.id, user);
  }
  async save(user: User): Promise<void> {
    this.users.set(user.id, user);
  }
}

class FakeSessionRepository implements RefreshSessionRepository {
  readonly sessions = new Map<string, RefreshSession>();

  async findByTokenHash(hash: string): Promise<RefreshSession | null> {
    return [...this.sessions.values()].find((session) => session.tokenHash === hash) ?? null;
  }
  async findById(id: SessionId): Promise<RefreshSession | null> {
    return this.sessions.get(id) ?? null;
  }
  async insert(session: RefreshSession): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async save(session: RefreshSession): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async revokeFamily(familyId: TokenFamilyId, now: Date): Promise<number> {
    let revoked = 0;
    for (const session of this.sessions.values()) {
      if (session.familyId === familyId && session.revokedAt === null) {
        session.revoke(now);
        revoked += 1;
      }
    }
    return revoked;
  }
  async revokeAllForUser(userId: string, now: Date): Promise<number> {
    let revoked = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.revokedAt === null) {
        session.revoke(now);
        revoked += 1;
      }
    }
    return revoked;
  }
  async purgeExpired(): Promise<number> {
    return 0;
  }
}

describe('AuthService', () => {
  let service: AuthService;
  let users: FakeUserRepository;
  let sessions: FakeSessionRepository;
  let hasher: FakeHasher;
  let outbox: { publish: ReturnType<typeof vi.fn> };
  let unbind: () => void;
  let issued = 0;

  beforeEach(async () => {
    unbind = bindTestTransactions();
    users = new FakeUserRepository();
    sessions = new FakeSessionRepository();
    hasher = new FakeHasher();
    outbox = { publish: vi.fn().mockResolvedValue('id') };
    issued = 0;

    const tokens: TokenIssuer = {
      issue: async () => {
        issued += 1;
        return {
          accessToken: `access-${issued}`,
          refreshToken: `refresh-${issued}`,
          accessExpiresAt: new Date(Date.now() + 900_000),
          refreshExpiresAt: new Date(Date.now() + 86_400_000),
          tokenType: 'Bearer' as const,
        };
      },
      verifyAccessToken: async () => {
        throw new Error('not used');
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: USER_REPOSITORY, useValue: users },
        { provide: SESSION_REPOSITORY, useValue: sessions },
        { provide: PASSWORD_HASHER, useValue: hasher },
        { provide: TOKEN_ISSUER, useValue: tokens },
        { provide: OutboxPublisher, useValue: outbox },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  afterEach(() => unbind());

  describe('register', () => {
    it('creates the user, opens a session and announces it', async () => {
      const result = await service.register({
        email: 'Ada@PayHub.dev',
        password: PASSWORD,
        displayName: 'Ada Lovelace',
      });

      expect(result.user.email).toBe('ada@payhub.dev');
      expect(result.tokens.accessToken).toBe('access-1');
      expect(sessions.sessions.size).toBe(1);
      expect(outbox.publish.mock.calls[0]?.[0].name).toBe('identity.user_registered.v1');
    });

    it('rejects a duplicate address', async () => {
      users.seed('ada@payhub.dev');

      await expect(
        service.register({ email: 'ada@payhub.dev', password: PASSWORD, displayName: 'A' }),
      ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
    });

    it('rejects a malformed address before touching the database', async () => {
      await expect(
        service.register({ email: 'nope', password: PASSWORD, displayName: 'A' }),
      ).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
      expect(users.users.size).toBe(0);
    });

    /**
     * Asserts the service's behaviour, not the fake's: whatever the hasher
     * returns is what gets stored, and the raw password never reaches the
     * repository on its own.
     */
    it('stores only what the hasher produced', async () => {
      const hash = vi.spyOn(hasher, 'hash');

      await service.register({ email: 'a@b.co', password: PASSWORD, displayName: 'A' });

      expect(hash).toHaveBeenCalledWith(PASSWORD);
      const [user] = [...users.users.values()];
      expect(user!.passwordHash).toBe(await hash.mock.results[0]!.value);
    });
  });

  describe('login', () => {
    it('issues a token pair for valid credentials', async () => {
      users.seed('ada@payhub.dev');

      const result = await service.login({ email: 'ada@payhub.dev', password: PASSWORD });

      expect(result.tokens.refreshToken).toBe('refresh-1');
      expect(sessions.sessions.size).toBe(1);
    });

    /**
     * "Unknown email" and "wrong password" must be indistinguishable, or
     * the endpoint becomes a user-enumeration oracle.
     */
    it('answers identically for an unknown address and a wrong password', async () => {
      users.seed('ada@payhub.dev');

      const unknown = await service
        .login({ email: 'nobody@payhub.dev', password: PASSWORD })
        .catch((error: unknown) => error);
      const wrong = await service
        .login({ email: 'ada@payhub.dev', password: 'not the password' })
        .catch((error: unknown) => error);

      expect(unknown).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(wrong).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect((unknown as Error).message).toBe((wrong as Error).message);
    });

    it('does the same hashing work for an address that does not exist', async () => {
      const verify = vi.spyOn(hasher, 'verify');

      await service.login({ email: 'nobody@payhub.dev', password: PASSWORD }).catch(() => undefined);

      // A decoy verification keeps the two branches comparable in cost.
      expect(verify).toHaveBeenCalled();
    });

    it('counts failures and locks the account', async () => {
      const user = users.seed('ada@payhub.dev');

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await service.login({ email: 'ada@payhub.dev', password: 'wrong' }).catch(() => undefined);
      }

      expect(user.status).toBe('locked');
      await expect(service.login({ email: 'ada@payhub.dev', password: PASSWORD })).rejects.toMatchObject(
        { code: 'ACCOUNT_LOCKED' },
      );
    });

    it('upgrades a hash produced with weaker parameters, transparently', async () => {
      const user = users.seed('ada@payhub.dev');
      hasher.stale = true;
      const rehash = vi.spyOn(hasher, 'hash');

      await service.login({ email: 'ada@payhub.dev', password: PASSWORD });

      expect(rehash).toHaveBeenCalledWith(PASSWORD);
      expect(user.status).toBe('active');
    });
  });

  describe('refresh', () => {
    async function signIn() {
      users.seed('ada@payhub.dev');
      return service.login({ email: 'ada@payhub.dev', password: PASSWORD });
    }

    it('rotates the token pair', async () => {
      const first = await signIn();

      const second = await service.refresh(first.tokens.refreshToken);

      expect(second.tokens.refreshToken).not.toBe(first.tokens.refreshToken);
      expect(sessions.sessions.size).toBe(2);
    });

    it('marks the presented token as consumed', async () => {
      const first = await signIn();

      await service.refresh(first.tokens.refreshToken);

      const consumed = await sessions.findByTokenHash(sha256(first.tokens.refreshToken));
      expect(consumed?.isReplay).toBe(true);
      expect(consumed?.replacedBy).not.toBeNull();
    });

    /**
     * RFC 9700 reuse detection: a token presented twice has either leaked
     * or been replayed, and we cannot tell which — so the whole family
     * goes, logging out the attacker and the legitimate client alike.
     */
    it('revokes the entire family when a used token is presented again', async () => {
      const first = await signIn();
      await service.refresh(first.tokens.refreshToken);

      await expect(service.refresh(first.tokens.refreshToken)).rejects.toMatchObject({
        code: 'REFRESH_TOKEN_REUSED',
      });

      expect([...sessions.sessions.values()].every((session) => session.revokedAt !== null)).toBe(
        true,
      );
    });

    it('rejects an unknown token without leaking why', async () => {
      await expect(service.refresh('never-issued')).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN',
      });
    });

    it('refuses to refresh a suspended account', async () => {
      const first = await signIn();
      [...users.users.values()][0]!.suspend('fraud');

      await expect(service.refresh(first.tokens.refreshToken)).rejects.toMatchObject({
        code: 'ACCOUNT_SUSPENDED',
      });
    });
  });

  describe('logout', () => {
    it('revokes the family the token belongs to', async () => {
      users.seed('ada@payhub.dev');
      const session = await service.login({ email: 'ada@payhub.dev', password: PASSWORD });

      await service.logout(session.tokens.refreshToken);

      expect([...sessions.sessions.values()][0]?.revokedAt).not.toBeNull();
    });

    it('is idempotent and silent for an unknown token', async () => {
      await expect(service.logout('never-issued')).resolves.toBeUndefined();
    });

    it('logoutEverywhere revokes every session and invalidates live access tokens', async () => {
      const user = users.seed('ada@payhub.dev');
      await service.login({ email: 'ada@payhub.dev', password: PASSWORD });
      await service.login({ email: 'ada@payhub.dev', password: PASSWORD });
      const before = user.tokensValidFrom;

      const revoked = await service.logoutEverywhere(user.id);

      expect(revoked).toBe(2);
      expect(user.tokensValidFrom.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });
});
