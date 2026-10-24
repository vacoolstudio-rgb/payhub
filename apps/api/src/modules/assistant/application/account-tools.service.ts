import { Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { z } from 'zod';
import { CacheService } from '@payhub/redis';
import {
  GetPaymentStats,
  ListPayments,
} from '../../payment/application/queries/payment.queries.js';
import type { PaymentStats } from '../../payment/domain/payment.repository.js';
import type { PaymentView } from '../../payment/application/payment.view.js';
import { WalletReadService } from '../../wallet/application/wallet-read.service.js';
import type { AssistantTool } from '../domain/assistant-tool.port.js';

/**
 * How far back a single question may reach.
 *
 * A bound on the model's reach is not optional once it writes the query
 * itself: without one, "summarise everything" turns into an unbounded
 * aggregate that an unauthenticated-looking question can trigger as many
 * times as the loop allows.
 */
const MAX_WINDOW_DAYS = 366;

/** Rows a single tool call may return, before the model ever sees them. */
const MAX_ROWS = 50;

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((date) => !Number.isNaN(date.getTime()), 'not a real date');

const statsSchema = z.object({ from: DATE, to: DATE, currency: z.string().length(3) }).strict();

const searchSchema = z
  .object({
    from: DATE,
    to: DATE,
    status: z
      .enum(['pending', 'authorized', 'capturing', 'captured', 'failed', 'cancelled', 'refunded'])
      .optional(),
    direction: z.enum(['deposit', 'withdrawal', 'transfer']).optional(),
    limit: z.number().int().min(1).max(MAX_ROWS).optional(),
  })
  .strict();

/**
 * The window rules, checked after parsing rather than inside the schema.
 *
 * They were `.refine` calls, which looked tidier and were wrong: a
 * refinement still runs when an earlier field failed, so a date the
 * regex rejected reached a comparison expecting a `Date` and the caller
 * got `range.from.getTime is not a function` instead of "expected
 * YYYY-MM-DD". A plain function after a successful parse cannot be
 * reached with a half-parsed value.
 */
function assertWindow(range: { from: Date; to: Date }): void {
  if (range.from > range.to) {
    throw new Error('from must not be after to');
  }
  if (range.to.getTime() - range.from.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
    throw new Error(`the window may not exceed ${MAX_WINDOW_DAYS} days`);
  }
}

/**
 * What the assistant may look up on the asker's behalf.
 *
 * Before this, the context block was a fixed guess: balances plus the
 * last twenty payments, assembled on every question whether or not the
 * question needed them. That guess is wrong in both directions — "what
 * is my balance?" paid for twenty payments nobody read, and "how much
 * did I spend on transport in March?" could not be answered at all,
 * because March was not in the last twenty.
 *
 * These are the same read models the REST and GraphQL surfaces use. The
 * model picks the window and the filter; it never picks the account.
 */
@Injectable()
export class AccountToolsService {
  constructor(
    private readonly queries: QueryBus,
    private readonly wallets: WalletReadService,
    private readonly cache: CacheService,
  ) {}

  tools(): AssistantTool[] {
    return [this.balances(), this.stats(), this.search()];
  }

  private balances(): AssistantTool {
    return {
      definition: {
        name: 'get_balances',
        description:
          'Current wallet balances for the person asking, one line per currency. ' +
          'Use for "what is my balance" and before any question about affordability.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      run: async (_input, context) => {
        const balances = await this.wallets.balances(context.userId);

        if (balances.length === 0) {
          return 'The account has no wallets yet.';
        }

        return balances
          .map(
            (wallet) =>
              `${wallet.currency}: available ${wallet.available.major}, pending ${wallet.pending.major}`,
          )
          .join('\n');
      },
    };
  }

  private stats(): AssistantTool {
    return {
      definition: {
        name: 'get_payment_totals',
        description:
          'Totals over a date range: how many payments, how many captured or failed, ' +
          'the captured volume and the fees paid. Use for any "how much did I spend" ' +
          'question. Dates are YYYY-MM-DD and the range may not exceed a year.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'inclusive, YYYY-MM-DD' },
            to: { type: 'string', description: 'exclusive, YYYY-MM-DD' },
            currency: { type: 'string', description: 'ISO 4217, e.g. USD' },
          },
          required: ['from', 'to', 'currency'],
          additionalProperties: false,
        },
      },
      run: async (input, context) => {
        const { from, to, currency } = statsSchema.parse(input);
        assertWindow({ from, to });

        // Revalidating rather than plain cache-aside: a conversation
        // asks several overlapping questions in a row, and an aggregate
        // a minute out of date is a better answer than a slow one.
        const stats = await this.cache.getOrRevalidate<PaymentStats>(
          `assistant:totals:${context.userId}:${currency}:${iso(from)}:${iso(to)}`,
          () =>
            this.queries.execute<GetPaymentStats, PaymentStats>(
              new GetPaymentStats({ userId: context.userId, currency, from, to }),
            ),
          { freshSec: 60, staleSec: 600 },
        );

        if (!stats) {
          return `No payments in ${currency} between ${iso(from)} and ${iso(to)}.`;
        }

        return [
          `Window ${iso(from)} to ${iso(to)}, ${currency}:`,
          `  payments: ${stats.totalCount} (captured ${stats.capturedCount}, failed ${stats.failedCount})`,
          `  captured volume: ${major(stats.volumeMinor)} ${currency}`,
          `  fees paid: ${major(stats.feeMinor)} ${currency}`,
        ].join('\n');
      },
    };
  }

  private search(): AssistantTool {
    return {
      definition: {
        name: 'search_payments',
        description:
          'Individual payments in a date range, newest first, optionally narrowed by ' +
          'status or direction. Use when the question is about specific transactions ' +
          `rather than totals. Returns at most ${MAX_ROWS} rows.`,
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'inclusive, YYYY-MM-DD' },
            to: { type: 'string', description: 'exclusive, YYYY-MM-DD' },
            status: {
              type: 'string',
              enum: ['pending', 'authorized', 'capturing', 'captured', 'failed', 'cancelled', 'refunded'],
            },
            direction: { type: 'string', enum: ['deposit', 'withdrawal', 'transfer'] },
            limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        },
      },
      run: async (input, context) => {
        const args = searchSchema.parse(input);
        assertWindow(args);

        const page = await this.queries.execute<
          ListPayments,
          { items: PaymentView[]; nextCursor: string | null; hasMore: boolean }
        >(
          new ListPayments({
            userId: context.userId,
            from: args.from,
            to: args.to,
            ...(args.status ? { status: args.status as never } : {}),
            ...(args.direction ? { direction: args.direction as never } : {}),
            limit: args.limit ?? 20,
          }),
        );

        if (page.items.length === 0) {
          return `No payments between ${iso(args.from)} and ${iso(args.to)}.`;
        }

        const rows = page.items.map(
          (payment) =>
            `${payment.createdAt.slice(0, 10)} | ${payment.direction} | ` +
            `${payment.amount.major} ${payment.amount.currency} | fee ${payment.fee.major} | ` +
            `${payment.status}${payment.failureReason ? ` (${payment.failureReason})` : ''} | ` +
            `ref ${payment.reference}`,
        );

        return [
          ...rows,
          ...(page.hasMore ? [`(more rows exist; narrow the range or the filter)`] : []),
        ].join('\n');
      },
    };
  }
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Minor units to a readable string without importing a currency table. */
function major(minor: string): string {
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
