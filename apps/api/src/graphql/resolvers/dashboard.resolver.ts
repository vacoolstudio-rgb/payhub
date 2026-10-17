import { Args, Context, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { QueryBus } from '@nestjs/cqrs';
import { Money } from '@payhub/kernel';
import { type AuthenticatedPrincipal, CurrentUser, RequirePermissions } from '@payhub/shared';
import { Permission } from '../../modules/identity/domain/role.vo.js';
import {
  GetPaymentStats,
  ListPayments,
} from '../../modules/payment/application/queries/payment.queries.js';
import type { PaymentView } from '../../modules/payment/application/payment.view.js';
import { WalletReadService } from '../../modules/wallet/application/wallet-read.service.js';
import type { GraphQLLoaders } from '../loaders/graphql.loaders.js';
import { PaymentStatsArgs, PaymentsArgs, StatementArgs } from '../models/dashboard.args.js';
import { MoneyModel, PaymentStatsModel } from '../models/common.model.js';
import {
  MerchantModel,
  PaymentModel,
  PaymentPageModel,
  StatementEntryModel,
  WalletModel,
} from '../models/payment.model.js';

interface GraphQLContext {
  req: { user?: AuthenticatedPrincipal };
  loaders: GraphQLLoaders;
}

/**
 * The dashboard's read API.
 *
 * This is the case GraphQL actually wins: one screen needs balances, the
 * last payments, each payment's merchant and a statistics tile. Over REST
 * that is four round trips plus an N+1 on merchants, and every new widget
 * either adds an endpoint or bloats an existing one. Here the client asks
 * for the shape it needs, once.
 *
 * Writes stay on REST — see `PaymentController` for why.
 */
@Resolver(() => PaymentModel)
export class DashboardResolver {
  constructor(
    private readonly queries: QueryBus,
    private readonly wallets: WalletReadService,
  ) {}

  @Query(() => [WalletModel], {
    name: 'wallets',
    description: 'Balances for the authenticated user',
  })
  @RequirePermissions(Permission.WalletRead)
  async myWallets(@CurrentUser() principal: AuthenticatedPrincipal): Promise<WalletModel[]> {
    const balances = await this.wallets.balances(principal.id);

    return balances.map((wallet) => ({
      id: wallet.id,
      currency: wallet.currency,
      available: money(wallet.available.minor, wallet.currency),
      pending: money(wallet.pending.minor, wallet.currency),
      total: money(wallet.total.minor, wallet.currency),
      status: wallet.status,
    }));
  }

  @Query(() => PaymentPageModel)
  @RequirePermissions(Permission.PaymentRead)
  async payments(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Args() args: PaymentsArgs,
  ): Promise<PaymentPageModel> {
    const page = await this.queries.execute<ListPayments, { items: PaymentView[]; nextCursor: string | null; hasMore: boolean }>(
      new ListPayments({
        userId: principal.kind === 'user' ? principal.id : undefined,
        merchantId: principal.kind === 'merchant' ? principal.merchantId : undefined,
        status: args.status,
        limit: args.limit ?? 25,
        cursor: args.cursor,
      }),
    );

    return {
      items: page.items.map(toPaymentModel),
      pageInfo: { nextCursor: page.nextCursor, hasMore: page.hasMore },
    };
  }

  @Query(() => PaymentStatsModel)
  @RequirePermissions(Permission.PaymentRead)
  async paymentStats(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Args() args: PaymentStatsArgs,
  ): Promise<PaymentStatsModel> {
    const to = new Date();
    const from = new Date(to.getTime() - args.days * 86_400_000);

    const stats = await this.queries.execute<
      GetPaymentStats,
      {
        totalCount: number;
        capturedCount: number;
        failedCount: number;
        volumeMinor: string;
        feeMinor: string;
      }
    >(
      new GetPaymentStats({
        merchantId: principal.merchantId,
        userId: principal.kind === 'user' ? principal.id : undefined,
        currency: args.currency,
        from,
        to,
      }),
    );

    return {
      totalCount: stats.totalCount,
      capturedCount: stats.capturedCount,
      failedCount: stats.failedCount,
      volume: money(stats.volumeMinor, args.currency),
      fees: money(stats.feeMinor, args.currency),
    };
  }

  @Query(() => [StatementEntryModel])
  @RequirePermissions(Permission.WalletRead)
  async statement(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Args() args: StatementArgs,
  ): Promise<StatementEntryModel[]> {
    const page = await this.wallets.statement({
      userId: principal.id,
      ...(args.currency ? { currency: args.currency } : {}),
      limit: args.limit ?? 50,
    });

    return page.items.map((entry) => ({
      transferId: entry.transferId,
      purpose: entry.purpose,
      description: entry.description,
      direction: entry.direction,
      amount: {
        minor: entry.amount.minor,
        major: entry.amount.major,
        currency: entry.amount.currency,
      },
      postedAt: new Date(entry.postedAt),
      paymentId: entry.paymentId,
    }));
  }

  /**
   * The field that would otherwise be an N+1. The loader lives on the
   * per-request context, so fifty payments cost exactly one extra query.
   */
  @ResolveField(() => MerchantModel, { nullable: true })
  async merchant(
    @Parent() payment: PaymentModel,
    @Context() context: GraphQLContext,
  ): Promise<MerchantModel | null> {
    return context.loaders.merchant.load(payment.merchantId);
  }
}

function money(minor: string, currency: string): MoneyModel {
  const value = Money.fromMinor(minor, currency);
  return { minor, major: value.toMajorString(), currency };
}

function toPaymentModel(view: PaymentView): PaymentModel {
  return {
    id: view.id,
    status: view.status as PaymentModel['status'],
    direction: view.direction as PaymentModel['direction'],
    amount: { minor: view.amount.minor, major: view.amount.major, currency: view.amount.currency },
    fee: { minor: view.fee.minor, major: view.fee.major, currency: view.fee.currency },
    netAmount: {
      minor: view.netAmount.minor,
      major: view.netAmount.major,
      currency: view.netAmount.currency,
    },
    method: view.method,
    reference: view.reference,
    failureReason: view.failureReason,
    createdAt: new Date(view.createdAt),
    capturedAt: view.capturedAt ? new Date(view.capturedAt) : null,
    merchantId: view.merchantId,
  };
}
