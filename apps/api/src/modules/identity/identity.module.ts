import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyService } from './application/api-key.service.js';
import { ApiKeyAuthenticator } from './application/api-key-authenticator.service.js';
import { AuthService } from './application/auth.service.js';
import { TOKEN_ISSUER } from './application/token-issuer.port.js';
import {
  API_KEY_REPOSITORY,
  PASSWORD_HASHER,
  SESSION_REPOSITORY,
  USER_REPOSITORY,
} from './domain/identity.ports.js';
import { Argon2PasswordHasher } from './infrastructure/security/argon2-password.hasher.js';
import { JwtTokenIssuer } from './infrastructure/security/jwt-token.issuer.js';
import { TokenRevocationService } from './infrastructure/security/token-revocation.service.js';
import {
  TypeOrmApiKeyRepository,
  TypeOrmRefreshSessionRepository,
  TypeOrmUserRepository,
} from './infrastructure/persistence/repositories/typeorm-identity.repositories.js';
import { AuthController } from './presentation/auth.controller.js';
import { AuthenticationGuard } from './presentation/guards/authentication.guard.js';
import { AuthorizationGuard } from './presentation/guards/authorization.guard.js';

/**
 * Identity bounded context.
 *
 * Exports the two guards and `ApiKeyService` because other modules compose
 * with them; everything else — repositories, hashers, the token issuer —
 * stays private. A module's `exports` list is its published API, and
 * exporting a repository would let another context reach into this one's
 * tables.
 */
@Module({
  imports: [
    JwtModule.register({
      // Secrets are passed per-call in JwtTokenIssuer so access and refresh
      // can use different keys; nothing is registered globally here.
      global: false,
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    ApiKeyService,
    ApiKeyAuthenticator,
    TokenRevocationService,
    AuthenticationGuard,
    AuthorizationGuard,

    /**
     * The global auth guards are registered **here**, not in AppModule.
     *
     * An `APP_GUARD` provider is instantiated in the injector of the module
     * that declares it, so a guard registered in AppModule can only see what
     * AppModule imports — and these need the identity repositories, which
     * are private to this context. Declaring them here keeps the
     * repositories unexported and the guards global; Nest applies an
     * `APP_GUARD` from any module to every route.
     *
     * Order matters: authentication answers "who are you" (401) before
     * authorisation answers "may you" (403).
     */
    { provide: APP_GUARD, useExisting: AuthenticationGuard },
    { provide: APP_GUARD, useExisting: AuthorizationGuard },

    { provide: USER_REPOSITORY, useClass: TypeOrmUserRepository },
    { provide: SESSION_REPOSITORY, useClass: TypeOrmRefreshSessionRepository },
    { provide: API_KEY_REPOSITORY, useClass: TypeOrmApiKeyRepository },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: TOKEN_ISSUER, useClass: JwtTokenIssuer },
  ],
  // `TOKEN_ISSUER` is exported because the WebSocket gateway authenticates
  // the handshake itself — it is outside the HTTP guard chain, so it needs
  // the verifier directly.
  exports: [
    ApiKeyService,
    AuthenticationGuard,
    AuthorizationGuard,
    TokenRevocationService,
    TOKEN_ISSUER,
  ],
})
export class IdentityModule {}
