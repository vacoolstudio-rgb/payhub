import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiStandardErrors,
  type AuthenticatedPrincipal,
  CurrentUser,
  RequirePermissions,
} from '@payhub/shared';
import { ForbiddenError } from '@payhub/kernel';
import { HttpCache } from '@payhub/redis';
import { WalletScopes } from '../application/wallet.cache-scopes.js';
import { SetWalletHoldDto, StatementQueryDto } from './dto/wallet.dto.js';
import {
  StatementPageDto,
  WalletBalanceResponseDto,
  WalletHoldAcceptedDto,
} from './dto/wallet-response.dto.js';
import { Permission } from '../../identity/domain/role.vo.js';
import { WalletHoldService } from '../application/wallet-hold.service.js';
import {
  type StatementEntryView,
  type WalletBalanceView,
  WalletReadService,
} from '../application/wallet-read.service.js';

@ApiTags('wallets')
@Controller({ path: 'wallets', version: '1' })
export class WalletController {
  constructor(
    private readonly wallets: WalletReadService,
    private readonly holds: WalletHoldService,
  ) {}

  @Get()
  @ApiOkResponse({ type: [WalletBalanceResponseDto] })
  // Polled by the dashboard and pushed to over WebSocket, so almost every
  // poll finds nothing new: the ideal shape for a conditional GET.
  @HttpCache({ scopes: (ctx) => [WalletScopes.ofUser(ctx.principalId)] })
  @RequirePermissions(Permission.WalletRead)
  @ApiOperation({ summary: 'Balances across every currency you hold' })
  @ApiStandardErrors()
  async balances(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<WalletBalanceView[]> {
    return this.wallets.balances(principal.id);
  }

  @Get('statement')
  @ApiOkResponse({ type: StatementPageDto })
  // The expensive one — a keyset page over the ledger. Same version scope
  // as the balances: both change exactly when a posting lands.
  @HttpCache({ scopes: (ctx) => [WalletScopes.ofUser(ctx.principalId)] })
  @RequirePermissions(Permission.WalletRead)
  @ApiOperation({ summary: 'Ledger statement (keyset paginated)' })
  @ApiStandardErrors()
  async statement(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: StatementQueryDto,
  ): Promise<{ items: StatementEntryView[]; nextCursor: string | null; hasMore: boolean }> {
    return this.wallets.statement({
      userId: principal.id,
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  }

  @Get('users/:userId')
  @ApiOkResponse({ type: [WalletBalanceResponseDto] })
  // Scoped to the user being looked at, not the one looking: the
  // representation changes when *their* balance moves.
  @HttpCache({ scopes: (ctx) => [WalletScopes.ofUser(ctx.params['userId'] ?? '')] })
  @RequirePermissions(Permission.WalletReadAny)
  @ApiOperation({ summary: 'Support view of another user’s balances' })
  @ApiStandardErrors(403)
  async balancesFor(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<WalletBalanceView[]> {
    if (
      !principal.permissions.includes(Permission.WalletReadAny) &&
      !principal.permissions.includes(Permission.AdminAll)
    ) {
      throw new ForbiddenError('Not allowed to read other users’ wallets', 'WALLET_FORBIDDEN');
    }
    return this.wallets.balances(userId);
  }

  /**
   * Stops money leaving a user's wallets, or lets it leave again.
   *
   * Every part of this existed except the entry point. The ledger has
   * always refused a transfer out of a frozen wallet, the aggregate has
   * always had `freeze()`, the `WalletFrozen` event has always been
   * defined, the status column has always permitted it, and
   * `wallet:freeze` has always sat in the permission matrix — granted
   * to no role and required by no route. So the one control a payments
   * platform reaches for during a fraud alert could not be reached.
   *
   * Asynchronous by design: the command goes through the outbox, so the
   * decision and the message commit together and the ledger applies it
   * on consumption. 202 rather than 200 says so honestly instead of
   * implying the wallet is already frozen.
   */
  @Post('users/:userId/freeze')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(Permission.WalletFreeze)
  @ApiOperation({ summary: 'Freeze a user’s wallets pending investigation' })
  @ApiAcceptedResponse({ type: WalletHoldAcceptedDto })
  @ApiStandardErrors(403)
  async freeze(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetWalletHoldDto,
  ): Promise<WalletHoldAcceptedDto> {
    const { commandId } = await this.holds.request({
      userId,
      ...(dto.currency ? { currency: dto.currency } : {}),
      frozen: true,
      reason: dto.reason,
      actorUserId: principal.id,
    });

    return { commandId, accepted: true };
  }

  /** The other half: a hold nobody can lift is a hold nobody should place. */
  @Post('users/:userId/release')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(Permission.WalletFreeze)
  @ApiOperation({ summary: 'Release a freeze' })
  @ApiAcceptedResponse({ type: WalletHoldAcceptedDto })
  @ApiStandardErrors(403)
  async release(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetWalletHoldDto,
  ): Promise<WalletHoldAcceptedDto> {
    const { commandId } = await this.holds.request({
      userId,
      ...(dto.currency ? { currency: dto.currency } : {}),
      frozen: false,
      reason: dto.reason,
      actorUserId: principal.id,
    });

    return { commandId, accepted: true };
  }
}
