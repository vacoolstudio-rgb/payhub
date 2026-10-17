import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { DomainError, Money, NotFoundError } from '@payhub/kernel';
import { WalletQueryService, type WalletView } from '../../application/queries/wallet-query.service.js';

interface MoneyMessage {
  amountMinor: string;
  currency: string;
}

interface WalletMessage {
  id: string;
  userId: string;
  currency: string;
  available: MoneyMessage;
  pending: MoneyMessage;
  status: string;
  version: number;
  updatedAt: string;
}

/**
 * gRPC surface of the ledger, consumed by the API service.
 *
 * Errors are translated into gRPC status codes here rather than leaking
 * `DomainError` across the wire: the caller gets `NOT_FOUND` /
 * `FAILED_PRECONDITION` with a machine-readable code in the metadata, which
 * is the RPC equivalent of the HTTP problem-details mapping.
 */
@Controller()
export class LedgerGrpcController {
  constructor(private readonly wallets: WalletQueryService) {}

  @GrpcMethod('LedgerService', 'GetBalances')
  async getBalances(request: { userId: string }): Promise<{ wallets: WalletMessage[] }> {
    return this.guard(async () => {
      const views = await this.wallets.getBalances(request.userId);
      return { wallets: views.map(toMessage) };
    });
  }

  @GrpcMethod('LedgerService', 'GetWallet')
  async getWallet(request: { walletId: string }): Promise<WalletMessage> {
    return this.guard(async () => toMessage(await this.wallets.getWallet(request.walletId)));
  }

  @GrpcMethod('LedgerService', 'GetStatement')
  async getStatement(request: {
    userId: string;
    currency?: string;
    limit?: number;
    cursor?: string;
  }) {
    return this.guard(async () => {
      const page = await this.wallets.getStatement({
        userId: request.userId,
        currency: request.currency || undefined,
        limit: request.limit && request.limit > 0 ? request.limit : 50,
        cursor: request.cursor || undefined,
      });

      return {
        rows: page.items.map((row) => ({
          transferId: row.transferId,
          purpose: row.purpose,
          description: row.description,
          account: row.account,
          direction: row.direction,
          amount: { amountMinor: row.amountMinor, currency: row.currency },
          postedAt: new Date(row.postedAt).toISOString(),
          paymentId: row.paymentId ?? '',
        })),
        nextCursor: page.nextCursor ?? '',
        hasMore: page.hasMore,
      };
    });
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: error.message });
      }
      if (error instanceof DomainError) {
        throw new RpcException({
          code:
            error.kind === 'validation'
              ? GrpcStatus.INVALID_ARGUMENT
              : GrpcStatus.FAILED_PRECONDITION,
          message: `${error.code}: ${error.message}`,
        });
      }
      throw new RpcException({ code: GrpcStatus.INTERNAL, message: 'Internal ledger error' });
    }
  }
}

function toMessage(view: WalletView): WalletMessage {
  return {
    id: view.id,
    userId: view.userId,
    currency: view.currency,
    available: toMoney(view.available, view.currency),
    pending: toMoney(view.pending, view.currency),
    status: view.status,
    version: view.version,
    updatedAt: view.updatedAt,
  };
}

function toMoney(major: string, currency: string): MoneyMessage {
  return { amountMinor: Money.fromMajor(major, currency).amount.toString(), currency };
}
