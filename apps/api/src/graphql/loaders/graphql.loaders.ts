import { Inject, Injectable } from '@nestjs/common';
import DataLoader from 'dataloader';
import {
  MERCHANT_REPOSITORY,
  type MerchantRepository,
} from '../../modules/merchant/domain/merchant.repository.js';
import { MerchantId } from '../../modules/merchant/domain/merchant.aggregate.js';
import type { MerchantModel } from '../models/payment.model.js';

export interface GraphQLLoaders {
  readonly merchant: DataLoader<string, MerchantModel | null>;
}

/**
 * DataLoader factory.
 *
 * The N+1 problem in GraphQL is structural, not accidental: a query for 50
 * payments calls the `merchant` field resolver 50 times, and a naive
 * implementation issues 50 `SELECT … WHERE id = $1`. DataLoader batches every
 * call made within one tick of the event loop into a single
 * `WHERE id IN (…)` and memoises the result for the rest of the request.
 *
 * Loaders must be created **per request**: a process-wide loader would serve
 * one user's merchant from another user's cache and never see an update.
 */
@Injectable()
export class LoaderFactory {
  constructor(
    @Inject(MERCHANT_REPOSITORY) private readonly merchants: MerchantRepository,
  ) {}

  create(): GraphQLLoaders {
    return {
      merchant: new DataLoader<string, MerchantModel | null>(
        async (ids) => {
          const found = await this.merchants.findManyByIds(ids.map((id) => MerchantId.of(id)));

          // DataLoader contract: the result array must be the same length as
          // the key array and in the same order. Missing keys become `null`,
          // never a shorter array.
          return ids.map((id) => {
            const merchant = found.get(MerchantId.of(id));
            return merchant
              ? { id: merchant.id, name: merchant.name, status: merchant.status }
              : null;
          });
        },
        { maxBatchSize: 200, cache: true },
      ),
    };
  }
}
