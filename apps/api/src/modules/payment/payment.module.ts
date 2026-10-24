import { Injectable, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { OnEvent } from '@nestjs/event-emitter';
import { ResourceVersionService } from '@payhub/redis';
import { MerchantModule } from '../merchant/merchant.module.js';
import { CancelPaymentHandler } from './application/commands/cancel-payment.handler.js';
import { CreatePaymentHandler } from './application/commands/create-payment.handler.js';
import { RefundPaymentHandler } from './application/commands/refund-payment.handler.js';
import {
  GetPaymentHandler,
  GetPaymentStatsHandler,
  ListPaymentsHandler,
} from './application/queries/payment.queries.js';
import { PaymentSaga } from './application/sagas/payment.saga.js';
import { MERCHANT_PRICING } from './domain/merchant-pricing.port.js';
import { MERCHANT_AUTHORITY } from './domain/merchant-authority.port.js';
import { PAYMENT_PROVIDER_REGISTRY } from './domain/payment-provider.port.js';
import { PAYMENT_REPOSITORY } from './domain/payment.repository.js';
import { MerchantContextAdapter } from './infrastructure/acl/merchant-context.adapter.js';
import { LedgerEventConsumer } from './infrastructure/messaging/ledger-event.consumer.js';
import { TypeOrmPaymentRepository } from './infrastructure/persistence/repositories/typeorm-payment.repository.js';
import { BankTransferProvider } from './infrastructure/providers/bank-transfer.provider.js';
import { CardPaymentProvider } from './infrastructure/providers/card.provider.js';
import { ProviderRegistry } from './infrastructure/providers/provider.registry.js';
import { PaymentController } from './presentation/http/payment.controller.js';
import { PaymentScopes } from './application/payment.cache-scopes.js';
import { PAYMENT_UPDATED_EVENT, type PaymentUpdatedEvent } from './application/payment.events.js';

/**
 * Expires the `ETag`s of everything a payment change can be seen through.
 *
 * Hooked onto the same in-process event that already drives the WebSocket
 * push, so there is one place that knows "a payment moved" and no write
 * path has to remember to invalidate anything.
 */
@Injectable()
class PaymentCacheInvalidator {
  constructor(private readonly versions: ResourceVersionService) {}

  @OnEvent(PAYMENT_UPDATED_EVENT, { async: true })
  async onPaymentUpdated(event: PaymentUpdatedEvent): Promise<void> {
    await this.versions.bump(
      PaymentScopes.one(event.payment.id),
      PaymentScopes.ofUser(event.userId),
      PaymentScopes.ofMerchant(event.merchantId),
      PaymentScopes.all(),
    );
  }
}

const commandHandlers = [CreatePaymentHandler, RefundPaymentHandler, CancelPaymentHandler];
const queryHandlers = [GetPaymentHandler, ListPaymentsHandler, GetPaymentStatsHandler];

/**
 * Payment bounded context.
 *
 * `CqrsModule` is used here and not in the ledger on purpose: payments have
 * four entry points (REST, GraphQL, the saga, the expiry cron) all issuing
 * the same commands, so a bus pays for itself. The ledger has exactly one
 * caller and a bus there would be indirection for its own sake.
 */
@Module({
  imports: [CqrsModule, MerchantModule],
  controllers: [PaymentController],
  providers: [
    ...commandHandlers,
    ...queryHandlers,
    PaymentSaga,
    LedgerEventConsumer,
    PaymentCacheInvalidator,

    // Strategies + their registry.
    CardPaymentProvider,
    BankTransferProvider,
    ProviderRegistry,
    { provide: PAYMENT_PROVIDER_REGISTRY, useExisting: ProviderRegistry },

    // Ports → adapters.
    { provide: PAYMENT_REPOSITORY, useClass: TypeOrmPaymentRepository },
    MerchantContextAdapter,
    { provide: MERCHANT_PRICING, useExisting: MerchantContextAdapter },
    { provide: MERCHANT_AUTHORITY, useExisting: MerchantContextAdapter },
  ],
  exports: [PAYMENT_REPOSITORY, PAYMENT_PROVIDER_REGISTRY, CqrsModule],
})
export class PaymentModule {}
