import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { type CursorPage, ForbiddenError, NotFoundError } from '@payhub/kernel';
import { CacheService } from '@payhub/redis';
import {
  PaymentId,
  type PaymentDirection,
  type PaymentStatus,
} from '../../domain/payment.aggregate.js';
import {
  PAYMENT_REPOSITORY,
  type PaymentRepository,
  type PaymentStats,
} from '../../domain/payment.repository.js';
import { type PaymentView, toPaymentView } from '../payment.view.js';

export class GetPayment {
  constructor(
    readonly input: {
      readonly paymentId: string;
      readonly actor: { id: string; merchantId?: string | undefined; canReadAny: boolean };
    },
  ) {}
}

export class ListPayments {
  constructor(
    readonly input: {
      readonly userId?: string | undefined;
      readonly merchantId?: string | undefined;
      readonly status?: PaymentStatus | undefined;
      readonly direction?: PaymentDirection | undefined;
      readonly currency?: string | undefined;
      readonly from?: Date | undefined;
      readonly to?: Date | undefined;
      readonly limit: number;
      readonly cursor?: string | undefined;
    },
  ) {}
}

export class GetPaymentStats {
  constructor(
    readonly input: {
      readonly merchantId?: string | undefined;
      readonly userId?: string | undefined;
      readonly currency: string;
      readonly from: Date;
      readonly to: Date;
    },
  ) {}
}

@QueryHandler(GetPayment)
export class GetPaymentHandler implements IQueryHandler<GetPayment, PaymentView> {
  constructor(@Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository) {}

  async execute(query: GetPayment): Promise<PaymentView> {
    const payment = await this.payments.findById(PaymentId.of(query.input.paymentId));

    if (!payment) {
      throw new NotFoundError('Payment', query.input.paymentId);
    }

    const { actor } = query.input;
    const visible =
      actor.canReadAny || payment.userId === actor.id || payment.merchantId === actor.merchantId;

    if (!visible) {
      // 404 rather than 403: confirming that an id exists is itself a leak
      // when the caller has no relationship to the resource.
      throw new NotFoundError('Payment', query.input.paymentId);
    }

    return toPaymentView(payment);
  }
}

@QueryHandler(ListPayments)
export class ListPaymentsHandler
  implements IQueryHandler<ListPayments, CursorPage<PaymentView>>
{
  constructor(@Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository) {}

  async execute(query: ListPayments): Promise<CursorPage<PaymentView>> {
    if (!query.input.userId && !query.input.merchantId) {
      throw new ForbiddenError('A payment listing must be scoped', 'UNSCOPED_QUERY');
    }

    const page = await this.payments.list({
      ...query.input,
      limit: Math.min(Math.max(query.input.limit, 1), 100),
    });

    return { ...page, items: page.items.map(toPaymentView) };
  }
}

/**
 * Aggregated statistics for the dashboard.
 *
 * Cached for a minute: this is a `GROUP BY` over a potentially large range
 * that half a dozen widgets request at once, and a 60-second-old revenue
 * figure is not a correctness problem the way a stale balance would be.
 */
@QueryHandler(GetPaymentStats)
export class GetPaymentStatsHandler implements IQueryHandler<GetPaymentStats, PaymentStats> {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    private readonly cache: CacheService,
  ) {}

  async execute(query: GetPaymentStats): Promise<PaymentStats> {
    const { input } = query;

    // The same rule `ListPaymentsHandler` applies, for the same reason.
    // With neither filter set the SQL's `$4 IS NULL OR …` guards fall
    // away and the aggregate covers every merchant and every user —
    // platform-wide volume and fee totals.
    //
    // Nothing reaches that today: both transports take the scope from
    // the principal and never from the request, and the one principal
    // kind that would leave both empty — `service` — is declared in the
    // type and constructed nowhere. That is the trap. Whoever adds
    // service-to-service authentication inherits a money-revealing query
    // that answers, rather than one that refuses.
    if (!input.userId && !input.merchantId) {
      throw new ForbiddenError('Payment statistics must be scoped', 'UNSCOPED_QUERY');
    }

    const key = [
      'payment:stats',
      input.merchantId ?? 'all',
      input.userId ?? 'all',
      input.currency,
      input.from.toISOString().slice(0, 13),
      input.to.toISOString().slice(0, 13),
    ].join(':');

    const stats = await this.cache.getOrSet<PaymentStats>(
      key,
      () =>
        this.payments.stats({
          ...(input.merchantId ? { merchantId: input.merchantId } : {}),
          ...(input.userId ? { userId: input.userId } : {}),
          currency: input.currency,
          from: input.from,
          to: input.to,
        }),
      { ttlSec: 60, jitterRatio: 0.25 },
    );

    return (
      stats ?? {
        totalCount: 0,
        capturedCount: 0,
        failedCount: 0,
        volumeMinor: '0',
        feeMinor: '0',
        currency: input.currency,
      }
    );
  }
}
