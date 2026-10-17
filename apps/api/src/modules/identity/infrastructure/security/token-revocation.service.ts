import { Inject, Injectable } from '@nestjs/common';
import { type AuthConfig, authConfig } from '@payhub/config';
import { RedisService } from '@payhub/redis';

/**
 * Revocation list for stateless access tokens.
 *
 * A JWT is valid until it expires — that is the whole point, and also the
 * whole problem. Checking the database on every request would throw away the
 * benefit; never checking anything means a compromised token stays live for
 * its full TTL.
 *
 * The compromise used here: a Redis denylist keyed by session id, plus a
 * per-user "not before" marker for "log out everywhere". Both entries expire
 * after the access-token TTL, so the list stays tiny (only tokens that are
 * still theoretically valid) and the lookup is a single O(1) GET on a
 * connection we already hold.
 */
@Injectable()
export class TokenRevocationService {
  constructor(
    private readonly redis: RedisService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
  ) {}

  async revokeSession(sessionId: string): Promise<void> {
    await this.redis.client.set(`revoked:session:${sessionId}`, '1', 'EX', this.config.accessTtlSec);
  }

  /** Every token issued before `at` becomes invalid for this user. */
  async revokeUserTokensBefore(userId: string, at: Date): Promise<void> {
    await this.redis.client.set(
      `revoked:user:${userId}`,
      Math.floor(at.getTime() / 1000).toString(),
      'EX',
      this.config.accessTtlSec,
    );
  }

  async isRevoked(claims: { sub: string; jti: string; iat: number }): Promise<boolean> {
    const [session, notBefore] = await this.redis.client.mget(
      `revoked:session:${claims.jti}`,
      `revoked:user:${claims.sub}`,
    );

    if (session !== null) {
      return true;
    }
    return notBefore !== null && claims.iat < Number(notBefore);
  }
}
