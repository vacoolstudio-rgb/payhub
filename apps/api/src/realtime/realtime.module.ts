import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { EventsGateway } from './events.gateway.js';

@Module({
  imports: [IdentityModule],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class RealtimeModule {}
