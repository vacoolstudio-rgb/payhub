import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ClsService } from 'nestjs-cls';
import { type AuthConfig, authConfig } from '@payhub/config';
import { UnauthorizedError } from '@payhub/kernel';
import { type AuthenticatedPrincipal, IS_PUBLIC_KEY, type PayHubClsStore, hashApiKey } from '@payhub/shared';
import { TOKEN_ISSUER, type TokenIssuer } from '../../application/token-issuer.port.js';
import { ApiKeyAuthenticator } from '../../application/api-key-authenticator.service.js';
import { API_KEY_REPOSITORY, type ApiKeyRepository } from '../../domain/identity.ports.js';
import { Role, permissionsFor } from '../../domain/role.vo.js';
import { RedisService } from '@payhub/redis';
import { ApiKeyId } from '../../domain/api-key.aggregate.js';
import { TokenRevocationService } from '../../infrastructure/security/token-revocation.service.js';

/** How stale `lastUsedAt` is allowed to be. */
const API_KEY_TOUCH_INTERVAL_SEC = 300;

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedPrincipal;
}

/**
 * One guard, two credential types.
 *
 * Humans arrive with a short-lived bearer JWT; merchant servers arrive with a
 * long-lived API key. Both end up as the same `AuthenticatedPrincipal`, so
 * every downstream guard, controller and resolver is written once rather
 * than twice.
 *
 * Registered globally via `APP_GUARD` — which also means it is constructed
 * by the DI container and can inject repositories, unlike a guard attached
 * with `app.useGlobalGuards(new …)`.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuer,
    @Inject(API_KEY_REPOSITORY) private readonly apiKeys: ApiKeyRepository,
    private readonly apiKeyAuth: ApiKeyAuthenticator,
    private readonly revocations: TokenRevocationService,
    private readonly redis: RedisService,
    private readonly cls: ClsService<PayHubClsStore>,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = this.requestOf(context);

    if (isPublic) {
      // Still resolve the principal when a token happens to be present, so
      // public endpoints can personalise without requiring authentication.
      await this.tryAttach(request);
      return true;
    }

    const principal = await this.tryAttach(request);
    if (!principal) {
      throw new UnauthorizedError('Authentication required');
    }

    return true;
  }

  private async tryAttach(request: RequestLike | undefined): Promise<AuthenticatedPrincipal | null> {
    if (!request) {
      return null;
    }

    const principal =
      (await this.fromBearerToken(request)) ?? (await this.fromApiKey(request)) ?? null;

    if (principal) {
      request.user = principal;
      if (this.cls.isActive()) {
        this.cls.set('principal', principal);
      }
    }

    return principal;
  }

  private async fromBearerToken(request: RequestLike): Promise<AuthenticatedPrincipal | null> {
    const header = single(request.headers['authorization']);
    if (!header?.toLowerCase().startsWith('bearer ')) {
      return null;
    }

    const claims = await this.tokens.verifyAccessToken(header.slice(7).trim());

    if (await this.revocations.isRevoked(claims)) {
      throw new UnauthorizedError('Session has been revoked', 'SESSION_REVOKED');
    }

    return {
      id: claims.sub,
      kind: 'user',
      email: claims.email,
      roles: claims.roles,
      permissions: claims.permissions,
      sessionId: claims.jti,
    };
  }

  private async fromApiKey(request: RequestLike): Promise<AuthenticatedPrincipal | null> {
    const presented = single(request.headers['x-api-key']);
    if (!presented) {
      return null;
    }

    const key = await this.apiKeyAuth.resolve(hashApiKey(presented, this.config.apiKeyPepper));
    if (!key) {
      throw new UnauthorizedError('API key is not recognised', 'API_KEY_INVALID');
    }

    const usable = key.assertUsable();
    if (usable.isErr()) {
      throw usable.error;
    }

    // Fire-and-forget, and throttled — see `recordUsage`.
    void this.recordUsage(key.id);

    return {
      id: key.id,
      kind: 'merchant',
      roles: [Role.Service],
      permissions: [...permissionsFor([Role.Service]), ...key.scopes],
      merchantId: key.merchantId,
    };
  }

  /**
   * Records "this key was used", at most once every five minutes per key.
   *
   * The naive version loaded the aggregate and saved it on *every*
   * authenticated request: a SELECT plus an UPDATE, which under load means
   * every request from one merchant queues on the same row. A Redis `SET
   * NX EX` is the throttle, and the write itself is a single UPDATE.
   *
   * The resolution of the field is five minutes either way — nothing reads
   * it synchronously, and "last used today" is the question it answers.
   */
  private async recordUsage(keyId: string): Promise<void> {
    try {
      const claimed = await this.redis.client.set(
        `apikey:touched:${keyId}`,
        '1',
        'EX',
        API_KEY_TOUCH_INTERVAL_SEC,
        'NX',
      );

      if (claimed) {
        await this.apiKeys.touchLastUsed(ApiKeyId.of(keyId), new Date());
      }
    } catch {
      // Usage tracking is telemetry, never a reason to fail a request.
    }
  }

  private requestOf(context: ExecutionContext): RequestLike | undefined {
    switch (context.getType<'http' | 'ws' | 'rpc' | 'graphql'>()) {
      case 'graphql':
        return GqlExecutionContext.create(context).getContext<{ req?: RequestLike }>().req;
      case 'ws': {
        const client = context.switchToWs().getClient<{
          handshake?: { headers: Record<string, string | string[] | undefined> };
          data?: { user?: AuthenticatedPrincipal };
        }>();
        if (!client.handshake) {
          return undefined;
        }
        const socketUser = client.data?.user;
        return {
          headers: client.handshake.headers,
          ...(socketUser ? { user: socketUser } : {}),
        };
      }
      case 'rpc':
        return undefined;
      default:
        return context.switchToHttp().getRequest<RequestLike>();
    }
  }
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
