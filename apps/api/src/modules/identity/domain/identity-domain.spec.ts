import { describe, expect, it } from 'vitest';
import { ApiKey, ApiKeyId, ApiScope } from './api-key.aggregate.js';
import { Email } from './email.vo.js';
import { RefreshSession, SessionId, TokenFamilyId } from './refresh-session.aggregate.js';
import { Permission, Role, hasPermission, isRole, permissionsFor } from './role.vo.js';
import { User, UserId, UserStatus } from './user.aggregate.js';

describe('Email', () => {
  it('normalises to one canonical form', () => {
    expect(Email.create('  Ada@PayHub.DEV ').unwrap().value).toBe('ada@payhub.dev');
  });

  /** Without normalisation, UNIQUE(email) stops meaning "one account". */
  it('treats differently-cased addresses as the same value', () => {
    expect(Email.create('A@b.co').unwrap().equals(Email.create('a@B.CO').unwrap())).toBe(true);
  });

  it('rejects malformed addresses', () => {
    for (const input of ['', 'no-at', 'a@b', 'a@@b.co', 'a b@c.co', `${'x'.repeat(250)}@b.co`]) {
      expect(Email.create(input).isErr()).toBe(true);
    }
  });

  it('exposes the domain and a masked form for logs', () => {
    const email = Email.create('ada@payhub.dev').unwrap();

    expect(email.domain).toBe('payhub.dev');
    expect(email.masked()).toBe('a***@payhub.dev');
    expect(email.masked()).not.toContain('ada');
  });
});

describe('RBAC matrix', () => {
  it('grants a plain user only their own actions', () => {
    const permissions = permissionsFor([Role.User]);

    expect(permissions).toContain(Permission.PaymentCreate);
    expect(permissions).not.toContain(Permission.PaymentRefund);
    expect(permissions).not.toContain(Permission.WalletReadAny);
  });

  it('lets support read across tenants but never move money', () => {
    const permissions = permissionsFor([Role.Support]);

    expect(permissions).toContain(Permission.PaymentReadAny);
    expect(permissions).not.toContain(Permission.PaymentCreate);
    expect(permissions).not.toContain(Permission.PaymentRefund);
  });

  it('unions the permissions of several roles without duplicates', () => {
    const permissions = permissionsFor([Role.User, Role.MerchantOwner]);

    expect(new Set(permissions).size).toBe(permissions.length);
    expect(permissions).toContain(Permission.MerchantManage);
  });

  it('treats the admin wildcard as covering everything', () => {
    expect(hasPermission([Permission.AdminAll], Permission.WalletFreeze)).toBe(true);
    expect(hasPermission([Permission.WalletRead], Permission.WalletFreeze)).toBe(false);
  });

  it('validates role strings coming from the database', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('wizard')).toBe(false);
  });
});

describe('User', () => {
  const build = () =>
    User.register({
      id: UserId.create(),
      email: Email.create('ada@payhub.dev').unwrap(),
      passwordHash: '$argon2id$...',
      displayName: 'Ada',
    });

  it('starts active and announces itself once', () => {
    const user = build();

    expect(user.status).toBe(UserStatus.Active);
    expect(user.pullDomainEvents().map((event) => event.eventName)).toEqual([
      'identity.user_registered.v1',
    ]);
  });

  /** Counting failures per account is what stops a slow password spray. */
  it('locks the account after five failed attempts', () => {
    const user = build();
    const start = new Date('2026-01-01T12:00:00Z');

    for (let attempt = 0; attempt < 4; attempt += 1) {
      user.recordFailedLogin(start);
      expect(user.assertCanAuthenticate(start).isOk()).toBe(true);
    }

    user.recordFailedLogin(start);

    expect(user.status).toBe(UserStatus.Locked);
    expect(user.assertCanAuthenticate(start).unwrapErr().code).toBe('ACCOUNT_LOCKED');
  });

  it('unlocks itself after the window, so nobody can lock a rival out for free', () => {
    const user = build();
    const start = new Date('2026-01-01T12:00:00Z');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      user.recordFailedLogin(start);
    }

    const later = new Date(start.getTime() + 16 * 60_000);

    expect(user.assertCanAuthenticate(later).isOk()).toBe(true);
    expect(user.recordSuccessfulLogin(later).isOk()).toBe(true);
    expect(user.failedLoginAttempts).toBe(0);
    expect(user.status).toBe(UserStatus.Active);
  });

  it('refuses suspended and deleted accounts outright', () => {
    const user = build();
    user.suspend('fraud');

    expect(user.assertCanAuthenticate().unwrapErr().code).toBe('ACCOUNT_SUSPENDED');
  });

  /** Access tokens are not stored, so revocation is a time cut-off. */
  it('moves the token cut-off forward on a password change', () => {
    const user = build();
    const before = user.tokensValidFrom;
    const now = new Date(before.getTime() + 60_000);

    user.changePassword('$argon2id$new', now);

    expect(user.tokensValidFrom.getTime()).toBe(now.getTime());
    expect(user.isTokenStale(before)).toBe(true);
    expect(user.isTokenStale(new Date(now.getTime() + 1_000))).toBe(false);
  });

  it('revokes every session on demand', () => {
    const user = build();
    const issued = new Date(user.tokensValidFrom.getTime() - 1_000);

    user.revokeAllSessions(new Date(user.tokensValidFrom.getTime() + 5_000));

    expect(user.isTokenStale(issued)).toBe(true);
  });

  it('keeps at least one role', () => {
    const user = build();

    expect(user.revokeRole(Role.User).unwrapErr().code).toBe('LAST_ROLE');

    user.grantRole(Role.Admin);
    expect(user.revokeRole(Role.User).isOk()).toBe(true);
    expect(user.roles).toEqual([Role.Admin]);
  });

  it('does not duplicate a role that is granted twice', () => {
    const user = build();
    user.grantRole(Role.Admin);
    user.grantRole(Role.Admin);

    expect(user.roles.filter((role) => role === Role.Admin)).toHaveLength(1);
  });

  it('derives permissions from its roles', () => {
    const user = build();
    user.grantRole(Role.MerchantOwner);

    expect(user.permissions).toContain(Permission.PaymentRefund);
  });
});

describe('RefreshSession', () => {
  const build = () =>
    RefreshSession.issue({
      id: SessionId.create(),
      userId: UserId.create(),
      familyId: TokenFamilyId.create(),
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

  it('is usable once', () => {
    const session = build();

    expect(session.isUsable()).toBe(true);
    expect(session.isReplay).toBe(false);
  });

  /**
   * Rotation plus reuse detection: once consumed, presenting the same
   * token again is indistinguishable from theft, so the caller revokes the
   * whole family.
   */
  it('reports a replay after it has been consumed', () => {
    const session = build();
    const successor = SessionId.create();

    session.consume(successor);

    expect(session.isReplay).toBe(true);
    expect(session.isUsable()).toBe(false);
    expect(session.replacedBy).toBe(successor);
  });

  it('is unusable once revoked or expired', () => {
    const revoked = build();
    revoked.revoke();
    expect(revoked.isUsable()).toBe(false);

    const expired = RefreshSession.issue({
      id: SessionId.create(),
      userId: UserId.create(),
      familyId: TokenFamilyId.create(),
      tokenHash: 'b'.repeat(64),
      expiresAt: new Date(Date.now() - 1),
    });
    expect(expired.isUsable()).toBe(false);
    // An expired token is not a replay — it is simply too old.
    expect(expired.isReplay).toBe(false);
  });

  it('revoking twice keeps the first timestamp', () => {
    const session = build();
    session.revoke(new Date('2026-01-01T00:00:00Z'));
    session.revoke(new Date('2026-01-02T00:00:00Z'));

    expect(session.revokedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('ApiKey', () => {
  const build = (overrides: Partial<Parameters<typeof ApiKey.issue>[0]> = {}) =>
    ApiKey.issue({
      id: ApiKeyId.create(),
      merchantId: UserId.create(),
      name: 'server',
      keyHash: 'c'.repeat(64),
      prefix: 'ph_test_',
      last4: 'ab12',
      environment: 'test',
      scopes: [ApiScope.PaymentsRead, ApiScope.PaymentsWrite],
      ...overrides,
    });

  it('is usable while live', () => {
    expect(build().assertUsable().isOk()).toBe(true);
  });

  it('requires every listed scope, not just one', () => {
    const key = build();

    expect(key.hasScopes([ApiScope.PaymentsRead])).toBe(true);
    expect(key.hasScopes([ApiScope.PaymentsRead, ApiScope.PaymentsWrite])).toBe(true);
    expect(key.hasScopes([ApiScope.PaymentsRead, ApiScope.RefundsWrite])).toBe(false);
  });

  it('refuses a revoked or expired key', () => {
    const revoked = build();
    revoked.revoke();
    expect(revoked.assertUsable().unwrapErr().code).toBe('API_KEY_REVOKED');

    const expired = build({ expiresAt: new Date(Date.now() - 1) });
    expect(expired.assertUsable().unwrapErr().code).toBe('API_KEY_EXPIRED');
  });

  /** The hash must never reach a response body or a log line. */
  it('never serialises its hash', () => {
    const json = JSON.stringify(build().toPublicJSON());

    expect(json).not.toContain('c'.repeat(64));
    expect(JSON.parse(json)).toMatchObject({ maskedKey: 'ph_test_…ab12' });
  });
});
