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
  UseInterceptors,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { CursorPage } from '@payhub/kernel';
import { HttpCache, IdempotencyInterceptor, PrincipalQuota } from '@payhub/redis';
import {
  ApiIdempotent,
  ApiStandardErrors,
  type AuthenticatedPrincipal,
  CurrentUser,
  IdempotencyKey,
  Idempotent,
  RequirePermissions,
} from '@payhub/shared';
import { Permission } from '../../../identity/domain/role.vo.js';
import { PaymentScopes } from '../../application/payment.cache-scopes.js';
import {
  CancelPayment,
  CreatePayment,
  RefundPayment,
} from '../../application/commands/payment.commands.js';
import {
  GetPayment,
  GetPaymentStats,
  ListPayments,
} from '../../application/queries/payment.queries.js';
import type { PaymentView } from '../../application/payment.view.js';
import type { PaymentStats } from '../../domain/payment.repository.js';
import {
  CreatePaymentDto,
  ListPaymentsQueryDto,
  PaymentStatsQueryDto,
  RefundPaymentDto,
} from './dto/payment.dto.js';
import {
  PaymentPageDto,
  PaymentResponseDto,
  PaymentStatsResponseDto,
} from './dto/payment-response.dto.js';

/**
 * Public REST surface for payments.
 *
 * REST and not GraphQL for the write path, on purpose: money commands want
 * an `Idempotency-Key` header, precise status codes, a signed request body
 * and a contract a third-party integrator can call with `curl`. The
 * dashboard's *read* path goes through GraphQL, where one round trip beats
 * six.
 */
@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentController {
  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ type: PaymentResponseDto })
  // Per caller, not per address. The global throttle is a flood guard
  // that runs before authentication; this is the merchant's own budget,
  // and a bucket lets them settle a batch in a burst without being
  // refused for the shape of their traffic.
  @PrincipalQuota({ name: 'payment-create', capacity: 120, refillPerSecond: 2 })
  @RequirePermissions(Permission.PaymentCreate)
  @Idempotent({ required: true })
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Create a payment',
    description:
      'Retrying with the same Idempotency-Key replays the original response instead of creating a second payment.',
  })
  @ApiIdempotent()
  @ApiStandardErrors(404, 409, 412)
  async create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: CreatePaymentDto,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<PaymentView> {
    return this.commands.execute(
      new CreatePayment({
        merchantId: dto.merchantId,
        // An API-key principal acts on behalf of its merchant; a human acts
        // as themselves. Letting a client choose the user id would be an
        // authorisation hole.
        userId: principal.kind === 'merchant' ? dto.counterpartyUserId ?? principal.id : principal.id,
        direction: dto.direction,
        amountMajor: dto.amount,
        currency: dto.currency,
        method: dto.method,
        ...(dto.counterpartyUserId ? { counterpartyUserId: dto.counterpartyUserId } : {}),
        ...(dto.reference ? { reference: dto.reference } : {}),
        ...(dto.metadata ? { metadata: dto.metadata } : {}),
        idempotencyKey,
      }),
    );
  }

  @Get()
  @ApiOkResponse({ type: PaymentPageDto })
  // Scoped to whatever the caller is actually allowed to see, so one
  // merchant's traffic never invalidates another's validator.
  @HttpCache({
    scopes: (ctx) => [
      ctx.merchantId
        ? PaymentScopes.ofMerchant(ctx.merchantId)
        : typeof ctx.query['merchantId'] === 'string'
          ? PaymentScopes.ofMerchant(ctx.query['merchantId'])
          : PaymentScopes.ofUser(ctx.principalId),
    ],
  })
  @RequirePermissions(Permission.PaymentRead)
  @ApiOperation({ summary: 'List payments (keyset pagination)' })
  @ApiStandardErrors()
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: ListPaymentsQueryDto,
  ): Promise<CursorPage<PaymentView>> {
    const canReadAny =
      principal.permissions.includes(Permission.PaymentReadAny) ||
      principal.permissions.includes(Permission.AdminAll);

    return this.queries.execute(
      new ListPayments({
        // Non-privileged callers are always scoped to themselves or their
        // merchant, whatever the query string says.
        userId: canReadAny ? undefined : principal.kind === 'user' ? principal.id : undefined,
        merchantId:
          principal.kind === 'merchant'
            ? principal.merchantId
            : canReadAny
              ? query.merchantId
              : undefined,
        status: query.status,
        direction: query.direction,
        currency: query.currency,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        limit: query.limit ?? 25,
        cursor: query.cursor,
      }),
    );
  }

  @Get('stats')
  @ApiOkResponse({ type: PaymentStatsResponseDto })
  // A `GROUP BY` over a month that a dashboard asks for on every render.
  // The figures only move when a payment does, so a poll that finds
  // nothing new costs one Redis read instead of the aggregate.
  @HttpCache({
    scopes: (ctx) => [
      ctx.merchantId
        ? PaymentScopes.ofMerchant(ctx.merchantId)
        : PaymentScopes.ofUser(ctx.principalId),
    ],
  })
  @RequirePermissions(Permission.PaymentRead)
  @ApiOperation({ summary: 'Aggregated volume and fees for a window' })
  async stats(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: PaymentStatsQueryDto,
  ): Promise<PaymentStats> {
    const now = new Date();

    return this.queries.execute(
      new GetPaymentStats({
        merchantId: principal.merchantId,
        userId: principal.kind === 'user' ? principal.id : undefined,
        currency: query.currency ?? 'USD',
        from: query.from ? new Date(query.from) : new Date(now.getTime() - 30 * 86_400_000),
        to: query.to ? new Date(query.to) : now,
      }),
    );
  }

  @Get(':paymentId')
  @ApiOkResponse({ type: PaymentResponseDto })
  // The canonical poll: an integrator asks "has it settled yet?" in a
  // loop. Until it has, every answer is a 304 that never reaches Postgres.
  @HttpCache({ scopes: (ctx) => [PaymentScopes.one(ctx.params['paymentId'] ?? '')] })
  @RequirePermissions(Permission.PaymentRead)
  @ApiOperation({ summary: 'Fetch one payment' })
  @ApiStandardErrors(404)
  async get(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<PaymentView> {
    return this.queries.execute(
      new GetPayment({
        paymentId,
        actor: {
          id: principal.id,
          merchantId: principal.merchantId,
          canReadAny:
            principal.permissions.includes(Permission.PaymentReadAny) ||
            principal.permissions.includes(Permission.AdminAll),
        },
      }),
    );
  }

  // Tighter than creating one: a refund moves money back out, and no
  // legitimate integration issues them in bursts.
  @PrincipalQuota({ name: 'payment-refund', capacity: 20, refillPerSecond: 0.2 })
  @ApiOkResponse({ type: PaymentResponseDto })
  @Post(':paymentId/refund')
  @RequirePermissions(Permission.PaymentRefund)
  @Idempotent({ required: true })
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary: 'Refund a captured payment',
    description: 'Partial refunds are allowed; the payment stays captured until fully refunded.',
  })
  @ApiIdempotent()
  @ApiStandardErrors(404, 409, 412)
  async refund(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: RefundPaymentDto,
  ): Promise<PaymentView> {
    return this.commands.execute(
      new RefundPayment({
        paymentId,
        actorUserId: principal.id,
        ...(dto.amount ? { amountMajor: dto.amount } : {}),
        reason: dto.reason,
      }),
    );
  }

  @ApiOkResponse({ type: PaymentResponseDto })
  @Post(':paymentId/cancel')
  @RequirePermissions(Permission.PaymentCancel)
  @ApiOperation({ summary: 'Cancel a payment that has not been captured yet' })
  @ApiStandardErrors(404, 412)
  async cancel(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<PaymentView> {
    return this.commands.execute(
      new CancelPayment({ paymentId, actorUserId: principal.id }),
    );
  }
}
