import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { OnEvent } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type GrpcConfig, grpcConfig } from '@payhub/config';
import {
  WALLET_UPDATED_EVENT,
  type WalletUpdatedEvent,
} from '../payment/application/payment.events.js';
import { ResourceVersionService } from '@payhub/redis';
import { WalletReadService } from './application/wallet-read.service.js';
import { WalletScopes } from './application/wallet.cache-scopes.js';
import { LEDGER_GRPC_CLIENT, LedgerGrpcClient } from './infrastructure/ledger.grpc-client.js';
import { WalletController } from './presentation/wallet.controller.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Invalidates the API-side balance cache the moment the ledger says the
 * balance moved. Without this the dashboard would show a stale balance for
 * up to the cache TTL right after a payment — exactly when the user is
 * looking at it.
 */
@Injectable()
class WalletCacheInvalidator {
  constructor(
    private readonly wallets: WalletReadService,
    private readonly versions: ResourceVersionService,
  ) {}

  @OnEvent(WALLET_UPDATED_EVENT, { async: true })
  async onWalletUpdated(event: WalletUpdatedEvent): Promise<void> {
    // Two tiers, invalidated together: the server-side value cache, and
    // the client-side validator that decides whether a poll gets a body.
    await Promise.all([
      this.wallets.invalidate(event.userId),
      this.versions.bump(WalletScopes.ofUser(event.userId)),
    ]);
  }
}

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: LEDGER_GRPC_CLIENT,
        inject: [grpcConfig.KEY],
        useFactory: (config: GrpcConfig) => ({
          transport: Transport.GRPC,
          options: {
            package: 'payhub.ledger.v1',
            protoPath: join(here, '../../../../ledger/proto/ledger.proto'),
            url: config.ledgerUrl,
            loader: { keepCase: false, longs: String, defaults: true, oneofs: true },
            // Keepalive matters behind a load balancer: without it an idle
            // HTTP/2 connection is silently dropped and the next call fails.
            keepalive: {
              keepaliveTimeMs: 30_000,
              keepaliveTimeoutMs: 5_000,
              keepalivePermitWithoutCalls: 1,
            },
          },
        }),
      },
    ]),
  ],
  controllers: [WalletController],
  providers: [LedgerGrpcClient, WalletReadService, WalletCacheInvalidator],
  exports: [WalletReadService, LedgerGrpcClient],
})
export class WalletModule {}
