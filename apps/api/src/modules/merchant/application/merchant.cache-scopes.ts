/**
 * Version scopes for merchant reads.
 *
 * Merchant configuration is the opposite traffic shape to a payment: read
 * on every dashboard render, written a handful of times in a merchant's
 * entire life. That ratio is what makes a validator worth having.
 */
export const MerchantScopes = {
  one: (merchantId: string) => `merchant:${merchantId}`,
  ofOwner: (ownerUserId: string) => `merchants:owner:${ownerUserId}`,
} as const;
