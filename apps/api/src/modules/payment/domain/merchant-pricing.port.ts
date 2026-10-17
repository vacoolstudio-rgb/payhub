import type { Money, Result } from '@payhub/kernel';
import type { DomainError } from '@payhub/kernel';

export const MERCHANT_PRICING = Symbol.for('payhub:MerchantPricing');

export interface MerchantPricingSnapshot {
  readonly merchantId: string;
  readonly feeFor: (amount: Money) => Money;
  readonly webhookConfigured: boolean;
}

/**
 * Anti-corruption layer towards the merchant context.
 *
 * The payment domain needs two facts about a merchant — may it take this
 * payment, and what does it charge — and nothing else. Expressing that as a
 * narrow port (rather than importing `Merchant`) keeps the contexts
 * independent: when the merchant context eventually becomes its own service,
 * only the adapter behind this interface changes.
 */
export interface MerchantPricing {
  resolve(
    merchantId: string,
    currency: string,
  ): Promise<Result<MerchantPricingSnapshot, DomainError>>;
}
