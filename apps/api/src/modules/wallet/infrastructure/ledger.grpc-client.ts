import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, timeout } from 'rxjs';
import { type GrpcConfig, grpcConfig } from '@payhub/config';
import { DependencyFailureError, NotFoundError } from '@payhub/kernel';
import type { PayHubClsStore } from '@payhub/shared';

export const LEDGER_GRPC_CLIENT = Symbol.for('payhub:LedgerGrpcClient');

interface MoneyMessage {
  amountMinor: string;
  currency: string;
}

export interface WalletMessage {
  id: string;
  userId: string;
  currency: string;
  available: MoneyMessage;
  pending: MoneyMessage;
  status: string;
  version: number;
  updatedAt: string;
}

export interface StatementRowMessage {
  transferId: string;
  purpose: string;
  description: string;
  account: string;
  direction: string;
  amount: MoneyMessage;
  postedAt: string;
  paymentId: string;
}

interface LedgerServiceClient {
  getBalances(request: { userId: string }, metadata?: Metadata): unknown;
  getWallet(request: { walletId: string }, metadata?: Metadata): unknown;
  getStatement(
    request: { userId: string; currency?: string; limit?: number; cursor?: string },
    metadata?: Metadata,
  ): unknown;
}

/**
 * Typed client for the ledger's gRPC API.
 *
 * Three things a hand-rolled HTTP call would have to reinvent and gRPC gives
 * for free: a deadline that propagates to the server (so a slow ledger
 * cannot pin an API worker), a generated contract that breaks the build when
 * the proto changes, and HTTP/2 multiplexing so fifty dashboard requests
 * share one connection.
 *
 * The correlation id is forwarded in the metadata, so one trace spans both
 * services.
 */
@Injectable()
export class LedgerGrpcClient implements OnModuleInit {
  private service!: LedgerServiceClient;

  constructor(
    @Inject(LEDGER_GRPC_CLIENT) private readonly client: ClientGrpc,
    private readonly cls: ClsService<PayHubClsStore>,
    @Inject(grpcConfig.KEY) private readonly config: GrpcConfig,
  ) {}

  onModuleInit(): void {
    this.service = this.client.getService<LedgerServiceClient>('LedgerService');
  }

  async getBalances(userId: string): Promise<WalletMessage[]> {
    const response = await this.call<{ wallets?: WalletMessage[] }>(() =>
      this.service.getBalances({ userId }, this.metadata()),
    );
    return response.wallets ?? [];
  }

  async getWallet(walletId: string): Promise<WalletMessage> {
    return this.call<WalletMessage>(() => this.service.getWallet({ walletId }, this.metadata()));
  }

  async getStatement(input: {
    userId: string;
    currency?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ rows: StatementRowMessage[]; nextCursor: string; hasMore: boolean }> {
    return this.call(() => this.service.getStatement(input, this.metadata()));
  }

  private metadata(): Metadata {
    const metadata = new Metadata();
    const correlationId = this.cls.isActive() ? this.cls.get('correlationId') : undefined;
    if (correlationId) {
      metadata.set('x-correlation-id', correlationId);
    }
    return metadata;
  }

  private async call<T>(invoke: () => unknown): Promise<T> {
    try {
      return await firstValueFrom(
        (invoke() as import('rxjs').Observable<T>).pipe(timeout(this.config.deadlineMs)),
      );
    } catch (error) {
      const code = (error as { code?: number }).code;

      if (code === GrpcStatus.NOT_FOUND) {
        throw new NotFoundError('Wallet', (error as { details?: string }).details ?? 'unknown');
      }

      throw new DependencyFailureError('ledger', 'Ledger service is unavailable', {
        cause: error,
        // UNAVAILABLE and DEADLINE_EXCEEDED are worth another try;
        // INVALID_ARGUMENT never will be.
        retryable:
          code === GrpcStatus.UNAVAILABLE || code === GrpcStatus.DEADLINE_EXCEEDED || code === undefined,
      });
    }
  }
}
