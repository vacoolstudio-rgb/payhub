import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PaymentModule } from '../payment/payment.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AssistantService } from './application/assistant.service.js';
import { TokenBudgetService } from './application/token-budget.service.js';
import { LLM_PROVIDER } from './domain/llm.port.js';
import { AnthropicProvider } from './infrastructure/anthropic.provider.js';
import { AssistantController } from './presentation/assistant.controller.js';

@Module({
  imports: [CqrsModule, PaymentModule, WalletModule],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    TokenBudgetService,
    { provide: LLM_PROVIDER, useClass: AnthropicProvider },
  ],
  exports: [AssistantService],
})
export class AssistantModule {}
