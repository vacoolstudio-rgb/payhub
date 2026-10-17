import { Injectable, Logger } from '@nestjs/common';
import { ValidationError } from '@payhub/kernel';
import type {
  PaymentProvider,
  PaymentProviderRegistry,
} from '../../domain/payment-provider.port.js';
import { BankTransferProvider } from './bank-transfer.provider.js';
import { CardPaymentProvider } from './card.provider.js';

/**
 * Strategy selector.
 *
 * Adapters register the methods they serve; the registry builds the lookup
 * once at construction. Supporting a new rail means writing one class and
 * adding it to the constructor — no `switch` anywhere in the domain or the
 * handlers, which is the whole point of the pattern.
 */
@Injectable()
export class ProviderRegistry implements PaymentProviderRegistry {
  private readonly logger = new Logger(ProviderRegistry.name);
  private readonly byMethod = new Map<string, PaymentProvider>();
  private readonly providers: PaymentProvider[];

  constructor(card: CardPaymentProvider, bank: BankTransferProvider) {
    this.providers = [card, bank];

    for (const provider of this.providers) {
      for (const method of provider.methods) {
        if (this.byMethod.has(method)) {
          throw new Error(
            `Payment method "${method}" is claimed by two providers: ${
              this.byMethod.get(method)?.name
            } and ${provider.name}`,
          );
        }
        this.byMethod.set(method, provider);
      }
    }

    this.logger.log(
      `Registered ${this.providers.length} provider(s) for methods: ${[...this.byMethod.keys()].join(', ')}`,
    );
  }

  forMethod(method: string): PaymentProvider {
    const provider = this.byMethod.get(method);

    if (!provider) {
      throw new ValidationError(
        `Unsupported payment method: ${method}`,
        { method, supported: [...this.byMethod.keys()] },
        'UNSUPPORTED_PAYMENT_METHOD',
      );
    }

    return provider;
  }

  all(): readonly PaymentProvider[] {
    return this.providers;
  }

  supportedMethods(): string[] {
    return [...this.byMethod.keys()];
  }
}
