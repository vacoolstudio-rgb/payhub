import { Injectable } from '@nestjs/common';
import { Money } from '@payhub/kernel';
import { CacheService } from '@payhub/redis';
import { LedgerGrpcClient, type WalletMessage } from '../infrastructure/ledger.grpc-client.js';

export interface WalletBalanceView {
  readonly id: string;
  readonly currency: string;
  readonly available: { minor: string; major: string };
  readonly pending: { minor: string; major: string };
  readonly total: { minor: string; major: string };
  readonly status: string;
  readonly updatedAt: string;
}

export interface StatementEntryView {
  readonly transferId: string;
  readonly purpose: string;
  readonly description: string;
  readonly direction: string;
  readonly amount: { minor: string; major: string; currency: string };
  readonly postedAt: string;
  readonly paymentId: string | null;
}

/**
 * Read model for wallets, assembled from the ledger service.
 *
 * The API owns no wallet data: it is a consumer of another bounded context.
 * The cache here is a *client-side* cache of a remote call, with a short TTL
 * and explicit invalidation on the WebSocket balance push — deliberately
 * separate from the ledger's own cache, which it cannot see.
 */
@Injectable()
export class WalletReadService {
  constructor(
    private readonly ledger: LedgerGrpcClient,
    private readonly cache: CacheService,
  ) {}

  async balances(userId: string): Promise<WalletBalanceView[]> {
    const cached = await this.cache.getOrSet<WalletBalanceView[]>(
      `api:wallets:${userId}`,
      async () => (await this.ledger.getBalances(userId)).map(toView),
      { ttlSec: 10, negativeTtlSec: 5, l1: true },
    );

    return cached ?? [];
  }

  async invalidate(userId: string): Promise<void> {
    await this.cache.del(`api:wallets:${userId}`);
  }

  async statement(input: {
    userId: string;
    currency?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  }): Promise<{ items: StatementEntryView[]; nextCursor: string | null; hasMore: boolean }> {
    const response = await this.ledger.getStatement({
      userId: input.userId,
      ...(input.currency ? { currency: input.currency } : {}),
      limit: input.limit ?? 50,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });

    return {
      items: response.rows.map((row) => ({
        transferId: row.transferId,
        purpose: row.purpose,
        description: row.description,
        direction: row.direction,
        amount: {
          minor: row.amount.amountMinor,
          major: Money.fromMinor(row.amount.amountMinor, row.amount.currency).toMajorString(),
          currency: row.amount.currency,
        },
        postedAt: row.postedAt,
        paymentId: row.paymentId || null,
      })),
      nextCursor: response.nextCursor || null,
      hasMore: response.hasMore,
    };
  }
}

function toView(message: WalletMessage): WalletBalanceView {
  const available = Money.fromMinor(message.available.amountMinor, message.available.currency);
  const pending = Money.fromMinor(message.pending.amountMinor, message.pending.currency);
  const total = available.add(pending);

  return {
    id: message.id,
    currency: message.currency,
    available: { minor: available.amount.toString(), major: available.toMajorString() },
    pending: { minor: pending.amount.toString(), major: pending.toMajorString() },
    total: { minor: total.amount.toString(), major: total.toMajorString() },
    status: message.status,
    updatedAt: message.updatedAt,
  };
}
