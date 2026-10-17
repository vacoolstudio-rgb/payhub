import type { Merchant, MerchantId } from './merchant.aggregate.js';

export const MERCHANT_REPOSITORY = Symbol.for('payhub:MerchantRepository');

export interface MerchantRepository {
  findById(id: MerchantId): Promise<Merchant | null>;
  findByOwner(ownerUserId: string): Promise<Merchant[]>;
  /** Loads several merchants in one query — the DataLoader batch function. */
  findManyByIds(ids: readonly MerchantId[]): Promise<Map<MerchantId, Merchant>>;
  insert(merchant: Merchant): Promise<void>;
  save(merchant: Merchant): Promise<void>;
}
