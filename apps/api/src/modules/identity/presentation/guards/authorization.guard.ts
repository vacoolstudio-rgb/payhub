import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ForbiddenError, UnauthorizedError } from '@payhub/kernel';
import {
  API_KEY_SCOPES_KEY,
  type AuthenticatedPrincipal,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  ROLES_KEY,
} from '@payhub/shared';
import { Permission } from '../../domain/role.vo.js';

/**
 * Authorisation, split from authentication on purpose.
 *
 * Nest runs global guards in registration order, so this one always sees a
 * principal attached by `AuthenticationGuard`. Keeping them separate means
 * "who are you" and "may you" fail with different status codes (401 vs 403),
 * which is what clients need to decide between re-authenticating and giving
 * up.
 *
 * Semantics: `@Roles` is an OR (any of these roles), `@RequirePermissions`
 * is an AND (all of them). Permissions are the real check; roles exist for
 * coarse, readable rules.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])) {
      return true;
    }

    const roles = this.metadata<string[]>(ROLES_KEY, context);
    const permissions = this.metadata<string[]>(PERMISSIONS_KEY, context);
    const scopes = this.metadata<string[]>(API_KEY_SCOPES_KEY, context);

    if (!roles && !permissions && !scopes) {
      return true;
    }

    const principal = this.principalOf(context);
    if (!principal) {
      throw new UnauthorizedError('Authentication required');
    }

    const isAdmin = principal.permissions.includes(Permission.AdminAll);

    if (roles && !isAdmin && !roles.some((role) => principal.roles.includes(role))) {
      throw new ForbiddenError(
        `Requires one of the following roles: ${roles.join(', ')}`,
        'ROLE_REQUIRED',
        { required: roles, actual: principal.roles },
      );
    }

    if (
      permissions &&
      !isAdmin &&
      !permissions.every((permission) => principal.permissions.includes(permission))
    ) {
      throw new ForbiddenError(
        `Missing permission(s): ${permissions.filter((p) => !principal.permissions.includes(p)).join(', ')}`,
        'PERMISSION_REQUIRED',
        { required: permissions },
      );
    }

    if (scopes) {
      if (principal.kind !== 'merchant') {
        throw new ForbiddenError('This endpoint requires an API key', 'API_KEY_REQUIRED');
      }
      if (!scopes.every((scope) => principal.permissions.includes(scope))) {
        throw new ForbiddenError(
          `API key is missing scope(s): ${scopes.join(', ')}`,
          'SCOPE_REQUIRED',
          { required: scopes },
        );
      }
    }

    return true;
  }

  private metadata<T>(key: string, context: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);
  }

  private principalOf(context: ExecutionContext): AuthenticatedPrincipal | undefined {
    switch (context.getType<'http' | 'ws' | 'rpc' | 'graphql'>()) {
      case 'graphql':
        return GqlExecutionContext.create(context).getContext<{
          req?: { user?: AuthenticatedPrincipal };
        }>().req?.user;
      case 'ws':
        return context.switchToWs().getClient<{ data?: { user?: AuthenticatedPrincipal } }>().data
          ?.user;
      default:
        return context.switchToHttp().getRequest<{ user?: AuthenticatedPrincipal }>().user;
    }
  }
}
