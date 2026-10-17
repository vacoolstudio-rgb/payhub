import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '@payhub/kernel';
import { Transactional } from '@payhub/persistence';
import { OutboxPublisher } from '@payhub/messaging';
import { UserRegistered as UserRegisteredContract } from '@payhub/contracts';
import { sha256 } from '@payhub/shared';
import { Email } from '../domain/email.vo.js';
import {
  PASSWORD_HASHER,
  type PasswordHasher,
  SESSION_REPOSITORY,
  type RefreshSessionRepository,
  USER_REPOSITORY,
  type UserRepository,
} from '../domain/identity.ports.js';
import {
  InvalidRefreshTokenError,
  RefreshSession,
  RefreshTokenReuseError,
  SessionId,
  TokenFamilyId,
} from '../domain/refresh-session.aggregate.js';
import { InvalidCredentialsError, User, UserId } from '../domain/user.aggregate.js';
import { TOKEN_ISSUER, type TokenIssuer, type TokenPair } from './token-issuer.port.js';

export interface RegisterCommand {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly userAgent?: string | undefined;
  readonly ip?: string | undefined;
}

export interface LoginCommand {
  readonly email: string;
  readonly password: string;
  readonly userAgent?: string | undefined;
  readonly ip?: string | undefined;
}

export interface AuthResult {
  readonly tokens: TokenPair;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly roles: readonly string[];
  };
}

/**
 * Authentication use cases.
 *
 * Every branch that depends on whether an account exists takes roughly the
 * same amount of work, so the endpoint cannot be used to enumerate users —
 * the most commonly shipped bug in a hand-written login flow.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * A real argon2 hash of a random value, verified against whenever the
   * email does not exist. Without it, "unknown email" answers in 1 ms and
   * "wrong password" in 60 ms, which is a perfectly usable oracle.
   */
  private decoyHash?: string;

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: RefreshSessionRepository,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuer,
    private readonly outbox: OutboxPublisher,
  ) {}

  @Transactional()
  async register(command: RegisterCommand): Promise<AuthResult> {
    const email = Email.create(command.email);
    if (email.isErr()) {
      throw email.error;
    }

    if (await this.users.existsByEmail(email.value)) {
      // Registration genuinely has to leak existence (the address is taken),
      // so this endpoint is rate limited harder than the rest.
      throw new ConflictError('This email is already registered', 'EMAIL_TAKEN');
    }

    const user = User.register({
      id: UserId.create(),
      email: email.value,
      passwordHash: await this.passwords.hash(command.password),
      displayName: command.displayName,
    });

    await this.users.insert(user);

    await this.outbox.publish(
      UserRegisteredContract,
      {
        userId: user.id,
        email: user.email.value,
        displayName: user.displayName,
        registeredAt: user.createdAt.toISOString(),
      },
      { aggregateType: 'User', aggregateId: user.id },
    );

    const tokens = await this.startSession(user, command.userAgent, command.ip);
    this.logger.log(`Registered user ${user.id} (${user.email.masked()})`);

    return { tokens, user: toPublicUser(user) };
  }

  /**
   * Records a failed attempt on its own transaction.
   *
   * `login` is `@Transactional`, and a rejected login *throws* — which
   * rolls the whole thing back, including the increment. The counter
   * stayed at zero however many passwords were tried: the threshold, the
   * `UserLocked` event and both columns were dead code, and brute-force
   * protection existed only on paper. The unit tests could not see it
   * either, because the test transaction manager runs the callback
   * directly and never rolls anything back.
   *
   * `REQUIRES_NEW` is the point: this write has to survive the failure
   * of the transaction that caused it.
   */
  @Transactional({ propagation: 'REQUIRES_NEW' })
  private async countFailedAttempt(user: User): Promise<void> {
    user.recordFailedLogin();
    await this.users.save(user);
  }

  @Transactional()
  async login(command: LoginCommand): Promise<AuthResult> {
    const email = Email.create(command.email);
    if (email.isErr()) {
      await this.burnTime(command.password);
      throw new InvalidCredentialsError();
    }

    const user = await this.users.findByEmail(email.value);
    if (!user) {
      await this.burnTime(command.password);
      throw new InvalidCredentialsError();
    }

    const usable = user.assertCanAuthenticate();
    if (usable.isErr()) {
      throw usable.error;
    }

    const matches = await this.passwords.verify(user.passwordHash, command.password);

    if (!matches) {
      await this.countFailedAttempt(user);
      throw new InvalidCredentialsError();
    }

    // Transparent upgrade: if the stored hash used weaker parameters, we now
    // have the plaintext in hand and can re-hash it at the current cost.
    if (this.passwords.needsRehash(user.passwordHash)) {
      user.changePassword(await this.passwords.hash(command.password));
    }

    const recorded = user.recordSuccessfulLogin();
    if (recorded.isErr()) {
      throw recorded.error;
    }

    await this.users.save(user);
    const tokens = await this.startSession(user, command.userAgent, command.ip);

    return { tokens, user: toPublicUser(user) };
  }

  /**
   * Refresh with rotation and reuse detection.
   *
   * SERIALIZABLE is justified here and nowhere else in the service: two
   * concurrent refreshes with the same token must not both succeed, and the
   * check-then-consume sequence is exactly the read-write skew that weaker
   * isolation permits.
   */
  @Transactional({ isolation: 'SERIALIZABLE', retries: 3 })
  async refresh(
    presentedToken: string,
    context: { userAgent?: string | undefined; ip?: string | undefined } = {},
  ): Promise<AuthResult> {
    const session = await this.sessions.findByTokenHash(sha256(presentedToken));

    if (!session) {
      throw new InvalidRefreshTokenError();
    }

    if (session.isReplay) {
      // Either the client retried or the token leaked. We cannot tell, so we
      // assume the worst and invalidate the entire chain.
      const revoked = await this.sessions.revokeFamily(session.familyId, new Date());
      this.logger.warn(
        `Refresh token reuse detected for user ${session.userId}; revoked ${revoked} session(s)`,
      );
      throw new RefreshTokenReuseError(session.familyId);
    }

    if (!session.isUsable()) {
      throw new InvalidRefreshTokenError();
    }

    const user = await this.users.findById(UserId.of(session.userId));
    if (!user) {
      throw new NotFoundError('User', session.userId);
    }

    const usable = user.assertCanAuthenticate();
    if (usable.isErr()) {
      throw usable.error;
    }

    const successorId = SessionId.create();
    session.consume(successorId);
    await this.sessions.save(session);

    const tokens = await this.issuePair(user, {
      sessionId: successorId,
      familyId: session.familyId,
      userAgent: context.userAgent,
      ip: context.ip,
    });

    return { tokens, user: toPublicUser(user) };
  }

  @Transactional()
  async logout(refreshToken: string): Promise<void> {
    const session = await this.sessions.findByTokenHash(sha256(refreshToken));
    if (!session) {
      return; // Idempotent: logging out twice is not an error.
    }
    await this.sessions.revokeFamily(session.familyId, new Date());
  }

  @Transactional()
  async logoutEverywhere(userId: string): Promise<number> {
    const user = await this.users.findById(UserId.of(userId));
    if (!user) {
      throw new NotFoundError('User', userId);
    }

    user.revokeAllSessions();
    await this.users.save(user);
    return this.sessions.revokeAllForUser(userId, new Date());
  }

  // --- helpers ------------------------------------------------------------

  private async startSession(
    user: User,
    userAgent?: string,
    ip?: string,
  ): Promise<TokenPair> {
    return this.issuePair(user, {
      sessionId: SessionId.create(),
      familyId: TokenFamilyId.create(),
      userAgent,
      ip,
    });
  }

  private async issuePair(
    user: User,
    context: {
      sessionId: SessionId;
      familyId: TokenFamilyId;
      userAgent?: string | undefined;
      ip?: string | undefined;
    },
  ): Promise<TokenPair> {
    const pair = await this.tokens.issue({
      userId: user.id,
      sessionId: context.sessionId,
      email: user.email.value,
      roles: [...user.roles],
      permissions: user.permissions,
    });

    await this.sessions.insert(
      RefreshSession.issue({
        id: context.sessionId,
        userId: user.id,
        familyId: context.familyId,
        tokenHash: sha256(pair.refreshToken),
        expiresAt: pair.refreshExpiresAt,
        userAgent: context.userAgent ?? null,
        ip: context.ip ?? null,
      }),
    );

    return pair;
  }

  /** Equalises the response time of the "unknown user" branch. */
  private async burnTime(password: string): Promise<void> {
    this.decoyHash ??= await this.passwords.hash(randomUUID());
    await this.passwords.verify(this.decoyHash, password);
  }
}

function toPublicUser(user: User): AuthResult['user'] {
  return {
    id: user.id,
    email: user.email.value,
    displayName: user.displayName,
    roles: [...user.roles],
  };
}
