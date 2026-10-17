import {
  AggregateRoot,
  type Brand,
  DomainEvent,
  ForbiddenError,
  InvalidStateError,
  type Result,
  UnauthorizedError,
  err,
  ok,
  uuidBrand,
} from '@payhub/kernel';
import { Email } from './email.vo.js';
import { type Permission, type Role, permissionsFor } from './role.vo.js';

export type UserId = Brand<string, 'UserId'>;
export const UserId = uuidBrand<UserId>('UserId');

export const UserStatus = {
  Active: 'active',
  /** Too many failed logins — temporary, self-healing. */
  Locked: 'locked',
  /** Compliance or abuse — permanent until an admin lifts it. */
  Suspended: 'suspended',
  Deleted: 'deleted',
} as const;

export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

interface UserProps {
  readonly email: Email;
  passwordHash: string;
  displayName: string;
  roles: Role[];
  status: UserStatus;
  emailVerified: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  /**
   * Any token issued before this instant is invalid. Bumping it is how a
   * password change or a "log out everywhere" revokes access tokens that
   * are, by design, not stored anywhere.
   */
  tokensValidFrom: Date;
  readonly createdAt: Date;
  updatedAt: Date;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1_000;

export class User extends AggregateRoot<UserId> {
  private constructor(
    id: UserId,
    private readonly props: UserProps,
  ) {
    super(id);
  }

  static register(input: {
    id: UserId;
    email: Email;
    passwordHash: string;
    displayName: string;
    roles?: Role[];
    now?: Date;
  }): User {
    const now = input.now ?? new Date();

    const user = new User(input.id, {
      email: input.email,
      passwordHash: input.passwordHash,
      displayName: input.displayName.trim(),
      roles: input.roles ?? ['user'],
      status: UserStatus.Active,
      emailVerified: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      tokensValidFrom: now,
      createdAt: now,
      updatedAt: now,
    });

    user.raise(new UserRegistered(user));
    return user;
  }

  static rehydrate(id: UserId, props: UserProps, version: number): User {
    const user = new User(id, props);
    user.setVersion(version);
    return user;
  }

  // --- authentication -----------------------------------------------------

  /**
   * Called *after* the password has been verified by the hashing service.
   *
   * The aggregate never sees the plaintext password: hashing is a technical
   * concern injected as a port, so the domain stays free of argon2 and the
   * algorithm can be upgraded without touching this file.
   */
  recordSuccessfulLogin(now = new Date()): Result<void, InvalidStateError> {
    const usable = this.assertCanAuthenticate(now);
    if (usable.isErr()) {
      return usable;
    }

    this.props.failedLoginAttempts = 0;
    this.props.lockedUntil = null;
    this.props.lastLoginAt = now;
    this.props.status = UserStatus.Active;
    this.touch(now);
    return ok(undefined);
  }

  /**
   * Progressive lockout. Counting failures on the account (not just the IP)
   * is what stops a slow distributed password spray; the lock is temporary
   * so a competitor cannot lock a user out permanently for free.
   */
  recordFailedLogin(now = new Date()): void {
    this.props.failedLoginAttempts += 1;

    if (this.props.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
      this.props.status = UserStatus.Locked;
      this.props.lockedUntil = new Date(now.getTime() + LOCK_DURATION_MS);
      this.raise(new UserLocked(this, this.props.lockedUntil));
    }

    this.touch(now);
  }

  assertCanAuthenticate(now = new Date()): Result<void, InvalidStateError> {
    if (this.props.status === UserStatus.Suspended) {
      return err(new InvalidStateError('Account is suspended', 'ACCOUNT_SUSPENDED'));
    }
    if (this.props.status === UserStatus.Deleted) {
      return err(new InvalidStateError('Account no longer exists', 'ACCOUNT_DELETED'));
    }
    if (this.props.lockedUntil && this.props.lockedUntil > now) {
      return err(
        new InvalidStateError('Account is temporarily locked', 'ACCOUNT_LOCKED', {
          lockedUntil: this.props.lockedUntil.toISOString(),
        }),
      );
    }
    return ok(undefined);
  }

  changePassword(newHash: string, now = new Date()): void {
    this.props.passwordHash = newHash;
    // Invalidate every access token minted before this moment.
    this.props.tokensValidFrom = now;
    this.props.failedLoginAttempts = 0;
    this.props.lockedUntil = null;
    this.touch(now);
    this.raise(new UserPasswordChanged(this));
  }

  /** "Sign out of all devices". */
  revokeAllSessions(now = new Date()): void {
    this.props.tokensValidFrom = now;
    this.touch(now);
  }

  /** A token minted before the cut-off is stale even if its signature is valid. */
  isTokenStale(issuedAt: Date): boolean {
    return issuedAt.getTime() < Math.floor(this.props.tokensValidFrom.getTime() / 1000) * 1000;
  }

  verifyEmail(now = new Date()): void {
    if (this.props.emailVerified) {
      return;
    }
    this.props.emailVerified = true;
    this.touch(now);
  }

  // --- authorisation ------------------------------------------------------

  grantRole(role: Role, now = new Date()): void {
    if (!this.props.roles.includes(role)) {
      this.props.roles = [...this.props.roles, role];
      this.touch(now);
    }
  }

  revokeRole(role: Role, now = new Date()): Result<void, ForbiddenError> {
    if (this.props.roles.length === 1 && this.props.roles[0] === role) {
      return err(new ForbiddenError('A user must keep at least one role', 'LAST_ROLE'));
    }
    this.props.roles = this.props.roles.filter((existing) => existing !== role);
    this.touch(now);
    return ok(undefined);
  }

  get permissions(): Permission[] {
    return permissionsFor(this.props.roles);
  }

  suspend(reason: string, now = new Date()): void {
    this.props.status = UserStatus.Suspended;
    this.props.tokensValidFrom = now;
    this.touch(now);
    this.raise(new UserSuspended(this, reason));
  }

  // --- accessors ----------------------------------------------------------

  get email(): Email {
    return this.props.email;
  }

  get passwordHash(): string {
    return this.props.passwordHash;
  }

  get displayName(): string {
    return this.props.displayName;
  }

  get roles(): readonly Role[] {
    return this.props.roles;
  }

  get status(): UserStatus {
    return this.props.status;
  }

  get emailVerified(): boolean {
    return this.props.emailVerified;
  }

  get failedLoginAttempts(): number {
    return this.props.failedLoginAttempts;
  }

  get lockedUntil(): Date | null {
    return this.props.lockedUntil;
  }

  get lastLoginAt(): Date | null {
    return this.props.lastLoginAt;
  }

  get tokensValidFrom(): Date {
    return this.props.tokensValidFrom;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  private touch(now: Date): void {
    this.props.updatedAt = now;
  }
}

/** Thrown by the application layer when credentials do not match. */
export class InvalidCredentialsError extends UnauthorizedError {
  constructor() {
    // Intentionally identical for "unknown email" and "wrong password":
    // a distinguishable message is a user-enumeration oracle.
    super('Invalid email or password', 'INVALID_CREDENTIALS');
  }
}

// --- domain events --------------------------------------------------------

export class UserRegistered extends DomainEvent {
  readonly eventName = 'identity.user_registered.v1';
  readonly aggregateType = 'User';

  constructor(private readonly user: User) {
    super();
  }

  get aggregateId(): string {
    return this.user.id;
  }

  payload(): Record<string, unknown> {
    return {
      userId: this.user.id,
      email: this.user.email.value,
      displayName: this.user.displayName,
      registeredAt: this.user.createdAt.toISOString(),
    };
  }
}

export class UserLocked extends DomainEvent {
  readonly eventName = 'identity.user_locked.v1';
  readonly aggregateType = 'User';

  constructor(
    private readonly user: User,
    private readonly until: Date,
  ) {
    super();
  }

  get aggregateId(): string {
    return this.user.id;
  }

  payload(): Record<string, unknown> {
    return { userId: this.user.id, lockedUntil: this.until.toISOString() };
  }
}

export class UserPasswordChanged extends DomainEvent {
  readonly eventName = 'identity.user_password_changed.v1';
  readonly aggregateType = 'User';

  constructor(private readonly user: User) {
    super();
  }

  get aggregateId(): string {
    return this.user.id;
  }

  payload(): Record<string, unknown> {
    return { userId: this.user.id, changedAt: this.user.updatedAt.toISOString() };
  }
}

export class UserSuspended extends DomainEvent {
  readonly eventName = 'identity.user_suspended.v1';
  readonly aggregateType = 'User';

  constructor(
    private readonly user: User,
    private readonly reason: string,
  ) {
    super();
  }

  get aggregateId(): string {
    return this.user.id;
  }

  payload(): Record<string, unknown> {
    return { userId: this.user.id, reason: this.reason };
  }
}
