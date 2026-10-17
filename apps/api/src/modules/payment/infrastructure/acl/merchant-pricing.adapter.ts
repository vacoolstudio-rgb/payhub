import { Injectable } from '@nestjs/common';
import { type DomainError, type Money, type Result, err, ok } from '@payhub/kernel';
import { MerchantService } from '../../../merchant/application/merchant.service.js';
import type {
  MerchantPricing,
  MerchantPricingSnapshot,
} from '../../domain/merchant-pricing.port.js';

/**
 * Anti-corruption layer between the payment and merchant contexts.
 *
 * This is the only file in the payment module that knows the merchant
 * context exists. It translates `Merchant` into the two facts payments
 * care about and converts a merchant-context failure into a payment-context
 * failure, so `MerchantNotActive` does not leak upward as a surprise.
 *
 * When the merchant context moves to its own service, this class swaps a
 * method call for a gRPC call and nothing else changes.
 */
@Injectable()
export class MerchantPricingAdapter implements MerchantPricing {
  constructor(private readonly merchants: MerchantService) {}

  async resolve(
    merchantId: string,
    currency: string,
  ): Promise<Result<MerchantPricingSnapshot, DomainError>> {
    const merchant = await this.merchants.loadAggregate(merchantId);

    const acceptable = merchant.assertCanAcceptPayments(currency);
    if (acceptable.isErr()) {
      return err(acceptable.error);
    }

    return ok({
      merchantId: merchant.id,
      // The fee policy is captured as a closure, so the payment context
      // never sees the `FeePolicy` class from another bounded context.
      feeFor: (amount: Money) => merchant.feePolicy.calculate(amount),
      webhookConfigured: merchant.webhook !== null,
    });
  }
}
