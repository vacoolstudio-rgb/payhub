import { Module } from '@nestjs/common';
import { MerchantModule } from '../../modules/merchant/merchant.module.js';
import { LoaderFactory } from './graphql.loaders.js';

/**
 * Tiny module whose only job is to make `LoaderFactory` injectable inside
 * `GraphQLModule.forRootAsync`.
 *
 * `forRootAsync` resolves its factory in its **own** injector, not the one
 * of the module that calls it, so a provider declared next to the call is
 * invisible there. Importing a module that exports it is the supported way
 * across that boundary.
 */
@Module({
  imports: [MerchantModule],
  providers: [LoaderFactory],
  exports: [LoaderFactory],
})
export class GraphqlLoadersModule {}
