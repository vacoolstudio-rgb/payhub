import {
  Body,
  Inject,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  ApiStandardErrors,
  type AuthenticatedPrincipal,
  CurrentUser,
  Public,
} from '@payhub/shared';
import { UnauthorizedError } from '@payhub/kernel';
import { AuthService } from '../application/auth.service.js';
import type { TokenPair } from '../application/token-issuer.port.js';
import { AuthResponseDto, LoginDto, RefreshDto, RegisterDto } from './dto/auth.dto.js';
import { type AppConfig, appConfig } from '@payhub/config';

const REFRESH_COOKIE = 'payhub_rt';

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    // The validated value, not `process.env`. Everything else in the
    // service reads configuration through this; a cookie losing
    // `secure` because two readings of the environment disagreed is
    // not a failure anyone would notice until it mattered.
    @Inject(appConfig.KEY) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  // Registration is the one endpoint that has to leak whether an address is
  // taken, so it gets the tightest budget in the service.
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'Create an account and start a session' })
  @ApiStandardErrors(409)
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponseDto> {
    const result = await this.auth.register({
      // Fields are copied explicitly rather than spread: a DTO is a class
      // instance, and spreading one quietly drops its prototype.
      email: dto.email,
      password: dto.password,
      displayName: dto.displayName,
      userAgent: request.get('user-agent'),
      ip: request.ip,
    });

    return this.respond(result.tokens, result.user, response);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 900_000, blockDuration: 900_000 } })
  @ApiOperation({ summary: 'Exchange credentials for a token pair' })
  @ApiStandardErrors(401)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponseDto> {
    const result = await this.auth.login({
      email: dto.email,
      password: dto.password,
      userAgent: request.get('user-agent'),
      ip: request.ip,
    });

    return this.respond(result.tokens, result.user, response);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 900_000 } })
  @ApiOperation({
    summary: 'Rotate the refresh token',
    description:
      'Each refresh invalidates the presented token. Presenting a token twice is treated as theft and revokes the whole family.',
  })
  @ApiStandardErrors(401)
  async refresh(
    @Body() dto: Partial<RefreshDto>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponseDto> {
    const token = dto.refreshToken ?? (request.cookies as Record<string, string>)?.[REFRESH_COOKIE];

    if (!token) {
      throw new UnauthorizedError('No refresh token supplied', 'REFRESH_TOKEN_MISSING');
    }

    const result = await this.auth.refresh(token, {
      userAgent: request.get('user-agent'),
      ip: request.ip,
    });

    return this.respond(result.tokens, result.user, response);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current refresh-token family' })
  async logout(
    @Body() dto: Partial<RefreshDto>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const token = dto.refreshToken ?? (request.cookies as Record<string, string>)?.[REFRESH_COOKIE];
    if (token) {
      await this.auth.logout(token);
    }
    response.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  @Delete('sessions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out of every device' })
  @ApiStandardErrors()
  async logoutEverywhere(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<{ revokedSessions: number }> {
    return { revokedSessions: await this.auth.logoutEverywhere(principal.id) };
  }

  @Get('me')
  @ApiOperation({ summary: 'Inspect the authenticated principal' })
  @ApiStandardErrors()
  me(@CurrentUser() principal: AuthenticatedPrincipal): AuthenticatedPrincipal {
    return principal;
  }

  /**
   * The refresh token also goes out as an httpOnly cookie.
   *
   * A browser client should never see it from JavaScript — that is the whole
   * XSS mitigation — while a server-to-server client reads it from the body.
   * `SameSite=strict` plus a path scoped to the auth routes keeps it out of
   * cross-site requests entirely, which is why no CSRF token is needed on
   * top.
   */
  private respond(
    tokens: TokenPair,
    user: AuthResponseDto['user'],
    response: Response,
  ): AuthResponseDto {
    response.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'strict',
      path: '/api/v1/auth',
      expires: tokens.refreshExpiresAt,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType,
      expiresIn: Math.max(0, Math.floor((tokens.accessExpiresAt.getTime() - Date.now()) / 1000)),
      user,
    };
  }
}
