import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { type AuthConfig, authConfig } from '@payhub/config';
import { UnauthorizedError } from '@payhub/kernel';
import type {
  AccessTokenClaims,
  IssueTokensInput,
  TokenIssuer,
  TokenPair,
} from '../../application/token-issuer.port.js';

/**
 * JWT access tokens + opaque refresh tokens.
 *
 * The access token is a short-lived (15 min) self-contained JWT so the API
 * can authorise without a database round-trip. The refresh token is **not** a
 * JWT: it is 256 bits of randomness stored (hashed) server-side. That
 * asymmetry is deliberate — a long-lived JWT cannot be revoked, while an
 * opaque token is revoked by deleting a row.
 *
 * Access and refresh are signed/derived from different secrets so that
 * leaking one does not let an attacker mint the other.
 */
@Injectable()
export class JwtTokenIssuer implements TokenIssuer {
  constructor(
    private readonly jwt: JwtService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
  ) {}

  async issue(input: IssueTokensInput): Promise<TokenPair> {
    const issuedAt = Math.floor(Date.now() / 1000);

    const accessToken = await this.jwt.signAsync(
      {
        sub: input.userId,
        jti: input.sessionId,
        email: input.email,
        roles: input.roles,
        permissions: input.permissions,
      },
      {
        secret: this.config.accessSecret,
        expiresIn: this.config.accessTtlSec,
        issuer: this.config.issuer,
        audience: this.config.audience,
      },
    );

    return {
      accessToken,
      refreshToken: randomBytes(32).toString('base64url'),
      accessExpiresAt: new Date((issuedAt + this.config.accessTtlSec) * 1000),
      refreshExpiresAt: new Date((issuedAt + this.config.refreshTtlSec) * 1000),
      tokenType: 'Bearer',
    };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.accessSecret,
        issuer: this.config.issuer,
        audience: this.config.audience,
        // Clock skew between pods should not reject a freshly minted token.
        clockTolerance: 5,
      });
    } catch (error) {
      throw new UnauthorizedError(
        error instanceof Error && error.name === 'TokenExpiredError'
          ? 'Access token has expired'
          : 'Access token is invalid',
        error instanceof Error && error.name === 'TokenExpiredError'
          ? 'TOKEN_EXPIRED'
          : 'TOKEN_INVALID',
      );
    }
  }
}
