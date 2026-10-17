import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiStandardErrors,
  type AuthenticatedPrincipal,
  CurrentUser,
  RequirePermissions,
} from '@payhub/shared';
import { ForbiddenError } from '@payhub/kernel';
import { HttpCache } from '@payhub/redis';
import { WalletScopes } from '../application/wallet.cache-scopes.js';
import { StatementQueryDto } from './dto/wallet.dto.js';
import { Permission } from '../../identity/domain/role.vo.js';
import {
  type StatementEntryView,
  type WalletBalanceView,
  WalletReadService,
} from '../application/wallet-read.service.js';

@ApiTags('wallets')
@Controller({ path: 'wallets', version: '1' })
export class WalletController {
  constructor(private readonly wallets: WalletReadService) {}

  @Get()
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
}
