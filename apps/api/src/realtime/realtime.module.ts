import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { MerchantModule } from '../modules/merchant/merchant.module.js';
import { EventsGateway } from './events.gateway.js';

@Module({
  imports: [IdentityModule, MerchantModule],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class RealtimeModule {}
