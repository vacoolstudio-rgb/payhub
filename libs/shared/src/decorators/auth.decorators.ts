import { type ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { UnauthorizedError } from '@payhub/kernel';
import type { AuthenticatedPrincipal } from '../types/request-context.js';

export const IS_PUBLIC_KEY = 'payhub:is-public';
export const ROLES_KEY = 'payhub:roles';
export const PERMISSIONS_KEY = 'payhub:permissions';
export const API_KEY_SCOPES_KEY = 'payhub:api-key-scopes';

/** Opts a route out of the globally registered authentication guard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Coarse-grained RBAC: the principal must hold at least one of these roles. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/** Fine-grained check: the principal must hold *every* listed permission. */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Scopes an endpoint to merchant API keys carrying these scopes. */
export const RequireApiScopes = (...scopes: string[]) => SetMetadata(API_KEY_SCOPES_KEY, scopes);

/**
 * Pulls the authenticated principal out of whichever execution context we are
 * in (HTTP, GraphQL or WebSocket), so handlers never touch `req.user`.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedPrincipal | undefined, context: ExecutionContext) => {
    const principal = extractPrincipal(context);

    if (!principal) {
      throw new UnauthorizedError('No authenticated principal on this request');
    }

    return field ? principal[field] : principal;
  },
);

/** Same as `CurrentUser` but returns `undefined` on anonymous requests. */
export const OptionalUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => extractPrincipal(context),
);

function extractPrincipal(context: ExecutionContext): AuthenticatedPrincipal | undefined {
  switch (context.getType<'http' | 'ws' | 'rpc' | 'graphql'>()) {
    case 'graphql': {
      const gqlContext = GqlExecutionContext.create(context).getContext<{
        req?: { user?: AuthenticatedPrincipal };
      }>();
      return gqlContext.req?.user;
    }
    case 'ws':
      return context.switchToWs().getClient<{ data?: { user?: AuthenticatedPrincipal } }>().data
        ?.user;
    default:
      return context.switchToHttp().getRequest<{ user?: AuthenticatedPrincipal }>().user;
  }
}
