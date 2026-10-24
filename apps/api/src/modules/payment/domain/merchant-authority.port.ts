export const MERCHANT_AUTHORITY = Symbol.for('payhub:MerchantAuthority');

/**
 * Anti-corruption layer towards the merchant context, for authority.
 *
 * Separate from `MerchantPricing` because it answers a different kind of
 * question. Pricing is about the payment being created; this is about who
 * is allowed to act on one that already exists. Keeping them apart means
 * a handler asks for exactly the one it needs, and the day the merchant
 * context becomes its own service the authority check can be cached or
 * batched without touching the pricing path.
 *
 * Deliberately a boolean rather than a `Merchant`: the payment context has
 * no business reading an owner id, only acting on the answer.
 */
export interface MerchantAuthority {
  /**
   * Whether this user may act on behalf of the merchant — currently its
   * owner, and whatever "operator" grows into (staff, delegated roles)
   * without any caller having to learn about it.
   */
  mayActFor(merchantId: string, userId: string): Promise<boolean>;
}
