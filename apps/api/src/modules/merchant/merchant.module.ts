import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { MerchantService } from './application/merchant.service.js';
import { MERCHANT_REPOSITORY } from './domain/merchant.repository.js';
import { TypeOrmMerchantRepository } from './infrastructure/persistence/repositories/typeorm-merchant.repository.js';
import { MerchantController } from './presentation/merchant.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [MerchantController],
  providers: [
    MerchantService,
    { provide: MERCHANT_REPOSITORY, useClass: TypeOrmMerchantRepository },
  ],
  exports: [MerchantService, MERCHANT_REPOSITORY],
})
export class MerchantModule {}
