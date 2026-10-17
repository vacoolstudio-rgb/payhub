export const TOKEN_ISSUER = Symbol.for('payhub:TokenIssuer');

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
  readonly tokenType: 'Bearer';
}

export interface AccessTokenClaims {
  /** Subject — the user id. */
  readonly sub: string;
  /** JWT id — the session this token belongs to, so a single device can be cut off. */
  readonly jti: string;
  readonly email: string;
  readonly roles: string[];
  readonly permissions: string[];
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
  readonly aud: string;
}

export interface IssueTokensInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly roles: string[];
  readonly permissions: string[];
}

export interface TokenIssuer {
  issue(input: IssueTokensInput): Promise<TokenPair>;
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
}
