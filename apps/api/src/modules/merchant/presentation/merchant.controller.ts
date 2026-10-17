import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiStandardErrors,
  type AuthenticatedPrincipal,
  CurrentUser,
  RequirePermissions,
} from '@payhub/shared';
import { ForbiddenError } from '@payhub/kernel';
import { ApiKeyService } from '../../identity/application/api-key.service.js';
import type { ApiScope } from '../../identity/domain/api-key.aggregate.js';
import { HttpCache } from '@payhub/redis';
import { Permission } from '../../identity/domain/role.vo.js';
import { MerchantScopes } from '../application/merchant.cache-scopes.js';
import { IdentityScopes } from '../../identity/application/identity.cache-scopes.js';
import { MerchantService, type MerchantView } from '../application/merchant.service.js';
import {
  ConfigureWebhookDto,
  CreateApiKeyDto,
  OnboardMerchantDto,
  UpdateFeePolicyDto,
} from './dto/merchant.dto.js';

@ApiTags('merchants')
@Controller({ path: 'merchants', version: '1' })
export class MerchantController {
  constructor(
    private readonly merchants: MerchantService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post()
  @RequirePermissions(Permission.MerchantManage)
  @ApiOperation({ summary: 'Onboard a merchant (starts in `pending`)' })
  @ApiStandardErrors()
  async onboard(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: OnboardMerchantDto,
  ): Promise<MerchantView> {
    return this.merchants.onboard({
      ownerUserId: principal.id,
      name: dto.name,
      ...(dto.supportedCurrencies ? { supportedCurrencies: dto.supportedCurrencies } : {}),
    });
  }

  @Get()
  @HttpCache({ scopes: (ctx) => [MerchantScopes.ofOwner(ctx.principalId)] })
  @RequirePermissions(Permission.MerchantManage)
  @ApiOperation({ summary: 'List the merchants you own' })
  async list(@CurrentUser() principal: AuthenticatedPrincipal): Promise<MerchantView[]> {
    return this.merchants.listForOwner(principal.id);
  }

  @Get(':merchantId')
  @HttpCache({ scopes: (ctx) => [MerchantScopes.one(ctx.params['merchantId'] ?? '')] })
  @ApiOperation({ summary: 'Fetch one merchant' })
  @ApiStandardErrors(404)
  async get(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('merchantId', ParseUUIDPipe) merchantId: string,
  ): Promise<MerchantView> {
    const merchant = await this.merchants.get(merchantId);
    this.assertVisible(merchant, principal);
    return merchant;
  }

  @Post(':merchantId/activate')
  @RequirePermissions(Permission.AdminAll)
  @ApiOperation({
    summary: 'Activate a merchant',
    description: 'Admin-only: in a real platform this is the output of a KYC review.',
  })
  @ApiStandardErrors(404, 412)
  async activate(
    @Param('merchantId', ParseUUIDPipe) merchantId: string,
  ): Promise<MerchantView> {
    return this.merchants.activate(merchantId);
  }

  @Patch(':merchantId/webhook')
  @RequirePermissions(Permission.MerchantManage)
  @ApiOperation({
    summary: 'Configure the webhook endpoint',
    description: 'Returns the signing secret once; store it, it cannot be retrieved again.',
  })
  @ApiStandardErrors(404, 422)
  async configureWebhook(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('merchantId', ParseUUIDPipe) merchantId: string,
    @Body() dto: ConfigureWebhookDto,
  ): Promise<{ merchant: MerchantView; signingSecret: string }> {
    return this.merchants.configureWebhook({
      merchantId,
      actorUserId: principal.id,
      url: dto.url,
      ...(dto.events ? { events: dto.events } : {}),
      ...(dto.allowInsecure !== undefined ? { allowInsecure: dto.allowInsecure } : {}),
    });
  }

  @Patch(':merchantId/fee-policy')
  @RequirePermissions(Permission.MerchantManage)
  @ApiOperation({ summary: 'Update pricing' })
  @ApiStandardErrors(404, 422)
  async updateFeePolicy(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('merchantId', ParseUUIDPipe) merchantId: string,
    @Body() dto: UpdateFeePolicyDto,
  ): Promise<MerchantView> {
    return this.merchants.updateFeePolicy({
      merchantId,
      actorUserId: principal.id,
      basisPoints: dto.basisPoints,
      ...(dto.fixedMinor !== undefined ? { fixedMinor: dto.fixedMinor } : {}),
      ...(dto.minimumMinor !== undefined ? { minimumMinor: dto.minimumMinor } : {}),
      ...(dto.maximumMinor !== undefined ? { maximumMinor: dto.maximumMinor } : {}),
    });
  }

  // --- API keys -----------------------------------------------------------

  @Post(':merchantId/api-keys')
  @RequirePermissions(Permission.ApiKeyManage)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Issue an API key',
    description: 'The plaintext key is returned once and never stored.',
  })
  @ApiStandardErrors(404)
  async createApiKey(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('merchantId', ParseUUIDPipe) merchantId: string,
    @Body() dto: CreateApiKeyDto,
  ) {
    const merchant = await this.merchants.get(merchantId);
    this.assertOwner(merchant, principal);

    return this.apiKeys.create({
      merchantId,
      name: dto.name,
      scopes: dto.scopes as ApiScope[],
      environment: dto.environment ?? 'test',
    });
  }

  @Get(':merchantId/api-keys')
  @HttpCache({ scopes: (ctx) => [IdentityScopes.apiKeysOf(ctx.params['merchantId'] ?? '')] })
  @RequirePermissions(Permission.ApiKeyManage)
  @ApiOperation({ summary: 'List API keys (masked)' })
  async listApiKeys(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('merchantId', ParseUUIDPipe) merchantId: string,
  ) {
    const merchant = await this.merchants.get(merchantId);
    this.assertOwner(merchant, principal);
    return this.apiKeys.list(merchantId);
  }

  @Delete(':merchantId/api-keys/:keyId')
  @RequirePermissions(Permission.ApiKeyManage)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiStandardErrors(404)
  async revokeApiKey(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('merchantId', ParseUUIDPipe) merchantId: string,
    @Param('keyId', ParseUUIDPipe) keyId: string,
  ): Promise<void> {
    const merchant = await this.merchants.get(merchantId);
    this.assertOwner(merchant, principal);
    await this.apiKeys.revoke(merchantId, keyId);
  }

  // --- guards -------------------------------------------------------------

  private assertOwner(merchant: MerchantView, principal: AuthenticatedPrincipal): void {
    if (
      merchant.ownerUserId !== principal.id &&
      !principal.permissions.includes(Permission.AdminAll)
    ) {
      throw new ForbiddenError('You do not own this merchant', 'MERCHANT_FOREIGN');
    }
  }

  private assertVisible(merchant: MerchantView, principal: AuthenticatedPrincipal): void {
    const canSeeAny =
      principal.permissions.includes(Permission.MerchantReadAny) ||
      principal.permissions.includes(Permission.AdminAll);

    if (!canSeeAny && merchant.ownerUserId !== principal.id && principal.merchantId !== merchant.id) {
      throw new ForbiddenError('You cannot view this merchant', 'MERCHANT_FOREIGN');
    }
  }
}
