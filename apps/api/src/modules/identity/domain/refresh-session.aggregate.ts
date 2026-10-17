import { AggregateRoot, type Brand, UnauthorizedError, uuidBrand } from '@payhub/kernel';

export type SessionId = Brand<string, 'SessionId'>;
export const SessionId = uuidBrand<SessionId>('SessionId');

export type TokenFamilyId = Brand<string, 'TokenFamilyId'>;
export const TokenFamilyId = uuidBrand<TokenFamilyId>('TokenFamilyId');

interface RefreshSessionProps {
  readonly userId: string;
  readonly familyId: TokenFamilyId;
  /** SHA-256 of the token. The raw token exists only in the client's hands. */
  readonly tokenHash: string;
  usedAt: Date | null;
  revokedAt: Date | null;
  replacedBy: SessionId | null;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly createdAt: Date;
}

/**
 * One link in a refresh-token chain.
 *
 * **Rotation**: every refresh call invalidates the presented token and issues
 * a new one. A stolen refresh token is therefore usable at most once.
 *
 * **Reuse detection**: if an already-used token is presented again, either
 * the legitimate client replayed it or an attacker is using a copy — and we
 * cannot tell which. The safe response is to kill the whole family, which
 * logs out both parties and forces a fresh login. This is the standard
 * mitigation from OAuth 2.0 BCP (RFC 9700).
 */
export class RefreshSession extends AggregateRoot<SessionId> {
  private constructor(
    id: SessionId,
    private readonly props: RefreshSessionProps,
  ) {
    super(id);
  }

  static issue(input: {
    id: SessionId;
    userId: string;
    familyId: TokenFamilyId;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
    ip?: string | null;
    now?: Date;
  }): RefreshSession {
    return new RefreshSession(input.id, {
      userId: input.userId,
      familyId: input.familyId,
      tokenHash: input.tokenHash,
      usedAt: null,
      revokedAt: null,
      replacedBy: null,
      expiresAt: input.expiresAt,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
      createdAt: input.now ?? new Date(),
    });
  }

  static rehydrate(id: SessionId, props: RefreshSessionProps): RefreshSession {
    return new RefreshSession(id, props);
  }

  /** `true` means the caller must revoke the entire family. */
  get isReplay(): boolean {
    return this.props.usedAt !== null;
  }

  isUsable(now = new Date()): boolean {
    return (
      this.props.usedAt === null && this.props.revokedAt === null && this.props.expiresAt > now
    );
  }

  consume(successorId: SessionId, now = new Date()): void {
    this.props.usedAt = now;
    this.props.replacedBy = successorId;
  }

  revoke(now = new Date()): void {
    if (this.props.revokedAt === null) {
      this.props.revokedAt = now;
    }
  }

  get userId(): string {
    return this.props.userId;
  }

  get familyId(): TokenFamilyId {
    return this.props.familyId;
  }

  get tokenHash(): string {
    return this.props.tokenHash;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  get usedAt(): Date | null {
    return this.props.usedAt;
  }

  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  get replacedBy(): SessionId | null {
    return this.props.replacedBy;
  }

  get userAgent(): string | null {
    return this.props.userAgent;
  }

  get ip(): string | null {
    return this.props.ip;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}

export class RefreshTokenReuseError extends UnauthorizedError {
  constructor(familyId: string) {
    super(
      'Refresh token was already used — all sessions in this family have been revoked',
      'REFRESH_TOKEN_REUSED',
      { familyId },
    );
  }
}

export class InvalidRefreshTokenError extends UnauthorizedError {
  constructor() {
    super('Refresh token is invalid or expired', 'INVALID_REFRESH_TOKEN');
  }
}
