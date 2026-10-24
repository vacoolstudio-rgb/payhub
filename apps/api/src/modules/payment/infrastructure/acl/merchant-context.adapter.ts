import { Injectable } from '@nestjs/common';
import { type DomainError, type Money, type Result, err, ok } from '@payhub/kernel';
import { MerchantService } from '../../../merchant/application/merchant.service.js';
import type {
  MerchantPricing,
  MerchantPricingSnapshot,
} from '../../domain/merchant-pricing.port.js';
import type { MerchantAuthority } from '../../domain/merchant-authority.port.js';

/**
 * Anti-corruption layer between the payment and merchant contexts.
 *
 * This is the only file in the payment module that knows the merchant
 * context exists. It translates `Merchant` into the facts payments care
 * about and converts a merchant-context failure into a payment-context
 * failure, so `MerchantNotActive` does not leak upward as a surprise.
 *
 * It implements both narrow ports rather than letting a second class
 * reach into the merchant context, which is what keeps that sentence
 * true. The ports stay separate so callers depend on one question each.
 *
 * When the merchant context moves to its own service, this class swaps a
 * method call for a gRPC call and nothing else changes.
 */
@Injectable()
export class MerchantContextAdapter implements MerchantPricing, MerchantAuthority {
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

  async mayActFor(merchantId: string, userId: string): Promise<boolean> {
    return this.merchants.mayActFor(merchantId, userId);
  }
}
