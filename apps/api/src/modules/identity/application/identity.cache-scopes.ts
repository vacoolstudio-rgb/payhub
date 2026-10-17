/**
 * Version scopes for identity reads.
 *
 * API keys belong to this context; a merchant id is only the owner they
 * hang off. Keeping the scope here rather than borrowing the merchant
 * context's own naming is what stops a cache key from quietly becoming a
 * dependency between two bounded contexts.
 */
export const IdentityScopes = {
  apiKeysOf: (merchantId: string) => `identity:apikeys:${merchantId}`,
} as const;
