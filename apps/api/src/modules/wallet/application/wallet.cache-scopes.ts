/**
 * Version scopes for wallet reads.
 *
 * Balances and the statement share one scope because they change together:
 * a posting lands, and both representations are stale in the same instant.
 * Splitting them would buy nothing and give two chances to forget a bump.
 */
export const WalletScopes = {
  ofUser: (userId: string) => `wallets:${userId}`,
} as const;
