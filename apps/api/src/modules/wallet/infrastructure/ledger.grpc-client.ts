import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, timeout } from 'rxjs';
import { type GrpcConfig, grpcConfig } from '@payhub/config';
import { DependencyFailureError, NotFoundError } from '@payhub/kernel';
import type { PayHubClsStore } from '@payhub/shared';

export const LEDGER_GRPC_CLIENT = Symbol.for('payhub:LedgerGrpcClient');

/** How long the local backstop waits past the deadline before giving up. */
const GRACE_MS = 500;

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

/**
 * Nest forwards every argument straight to the grpc-js client method, whose
 * unary signature is `(request, metadata, options, callback)` — so the third
 * parameter is where a real deadline goes.
 */
interface CallOptions {
  deadline: Date;
}

interface LedgerServiceClient {
  getBalances(request: { userId: string }, metadata?: Metadata, options?: CallOptions): unknown;
  getWallet(request: { walletId: string }, metadata?: Metadata, options?: CallOptions): unknown;
  getStatement(
    request: { userId: string; currency?: string; limit?: number; cursor?: string },
    metadata?: Metadata,
    options?: CallOptions,
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
      this.service.getBalances({ userId }, this.metadata(), this.callOptions()),
    );
    return response.wallets ?? [];
  }

  async getWallet(walletId: string): Promise<WalletMessage> {
    return this.call<WalletMessage>(() =>
      this.service.getWallet({ walletId }, this.metadata(), this.callOptions()),
    );
  }

  async getStatement(input: {
    userId: string;
    currency?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ rows: StatementRowMessage[]; nextCursor: string; hasMore: boolean }> {
    return this.call(() => this.service.getStatement(input, this.metadata(), this.callOptions()));
  }

  /**
   * A real gRPC deadline, not a local timer.
   *
   * This used to rely on RxJS `timeout()` alone, under a comment claiming
   * the deadline propagated to the server. It did not: the client gave up
   * while the ledger kept working on a request nobody was waiting for,
   * still holding its database connection. Three things change with an
   * actual deadline:
   *
   * - it travels in the `grpc-timeout` header, so the server knows the
   *   budget from the first byte and can pass it to its own downstream
   *   calls;
   * - grpc-js enforces it on the HTTP/2 layer rather than through a
   *   JavaScript timer, so it still fires when the event loop is busy —
   *   which is precisely when a timeout matters;
   * - it fails with `DEADLINE_EXCEEDED`, a code the retry classification
   *   below already understands, instead of an RxJS error with no code.
   */
  private callOptions(): CallOptions {
    return { deadline: new Date(Date.now() + this.config.deadlineMs) };
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
        // The deadline above is the real bound. This is a backstop a little
        // beyond it, for the case where the call never resolves at all —
        // unsubscribing cancels the underlying stream.
        (invoke() as import('rxjs').Observable<T>).pipe(
          timeout(this.config.deadlineMs + GRACE_MS),
        ),
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
