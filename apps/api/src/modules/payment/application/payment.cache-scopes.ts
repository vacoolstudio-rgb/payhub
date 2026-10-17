/**
 * Version scopes for the payment context's cacheable reads.
 *
 * Shared by the endpoints that *derive* an `ETag` from a scope and the
 * invalidator that *bumps* it. A scope string duplicated across those two
 * sides is the classic way to ship a cache that never invalidates — or one
 * that never hits — so there is exactly one definition of each name.
 */
export const PaymentScopes = {
  /** One payment's representation. */
  one: (paymentId: string) => `payment:${paymentId}`,

  /** Every list and aggregate a user sees of their own payments. */
  ofUser: (userId: string) => `payments:user:${userId}`,

  /** Every list and aggregate scoped to one merchant. */
  ofMerchant: (merchantId: string) => `payments:merchant:${merchantId}`,

  /**
   * The unfiltered admin view. Bumped by every payment anywhere, which is
   * correct: that listing really does change every time.
   */
  all: () => 'payments:all',
} as const;
