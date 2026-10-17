import type { Money, Result } from '@payhub/kernel';
import type { DependencyFailureError } from '@payhub/kernel';

export const PAYMENT_PROVIDER_REGISTRY = Symbol.for('payhub:PaymentProviderRegistry');

export interface AuthorizationRequest {
  readonly paymentId: string;
  readonly userId: string;
  readonly amount: Money;
  readonly currency: string;
  readonly reference: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface AuthorizationResult {
  readonly providerReference: string;
  readonly approved: boolean;
  readonly declineReason?: string;
  /** Raw provider payload kept for reconciliation and disputes. */
  readonly raw: Record<string, unknown>;
}

export interface PayoutRequest {
  readonly paymentId: string;
  readonly userId: string;
  readonly amount: Money;
  readonly destination: string;
}

export interface ProviderSettlementLine {
  readonly providerReference: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly settledAt: Date;
  readonly status: 'settled' | 'reversed' | 'pending';
}

/**
 * Payment provider port — one implementation per rail.
 *
 * Strategy pattern: `method` on the payment selects the adapter, so adding
 * SEPA or a new card acquirer is a new class and a registry entry, not a
 * `switch` statement growing inside the command handler.
 */
export interface PaymentProvider {
  readonly name: string;
  /** Which payment methods this adapter serves, e.g. `card`, `sepa`. */
  readonly methods: readonly string[];

  authorize(request: AuthorizationRequest): Promise<Result<AuthorizationResult, DependencyFailureError>>;
  capture(providerReference: string, amount: Money): Promise<Result<void, DependencyFailureError>>;
  refund(providerReference: string, amount: Money): Promise<Result<string, DependencyFailureError>>;
  payout(request: PayoutRequest): Promise<Result<AuthorizationResult, DependencyFailureError>>;

  /** Statement used by the reconciliation job. */
  fetchSettlements(from: Date, to: Date): Promise<ProviderSettlementLine[]>;
}

export interface PaymentProviderRegistry {
  /** Resolves the adapter for a payment method, or throws for an unknown one. */
  forMethod(method: string): PaymentProvider;
  all(): readonly PaymentProvider[];
}
