import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DependencyFailureError, type Money, type Result, err, ok } from '@payhub/kernel';
import type {
  AuthorizationRequest,
  AuthorizationResult,
  PaymentProvider,
  PayoutRequest,
  ProviderSettlementLine,
} from '../../domain/payment-provider.port.js';

/**
 * Bank rail (SEPA-style).
 *
 * A second strategy with genuinely different semantics: a bank transfer is
 * *not* authorised instantly — the money appears in a settlement file later.
 * Modelling it as a separate adapter is the point: the saga stays the same,
 * the rail's quirks stay behind the port.
 */
@Injectable()
export class BankTransferProvider implements PaymentProvider {
  readonly name = 'bank-rail';
  readonly methods = ['bank_transfer', 'sepa'] as const;

  private readonly settlements: ProviderSettlementLine[] = [];

  async authorize(
    request: AuthorizationRequest,
  ): Promise<Result<AuthorizationResult, DependencyFailureError>> {
    await delay(10);

    // Banks have cut-off times. Outside the window the transfer is accepted
    // but will not settle today — the domain only cares that it was accepted.
    const providerReference = `sepa_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    this.settlements.push({
      providerReference,
      amountMinor: request.amount.amount.toString(),
      currency: request.currency,
      settledAt: nextBusinessSettlement(),
      status: 'pending',
    });

    return ok({
      providerReference,
      approved: true,
      raw: { rail: 'sepa', expectedSettlement: nextBusinessSettlement().toISOString() },
    });
  }

  async capture(providerReference: string): Promise<Result<void, DependencyFailureError>> {
    const index = this.settlements.findIndex(
      (line) => line.providerReference === providerReference,
    );

    if (index === -1) {
      return err(new DependencyFailureError(this.name, 'Unknown transfer', { retryable: false }));
    }

    this.settlements[index] = { ...this.settlements[index]!, status: 'settled' };
    return ok(undefined);
  }

  async refund(
    _providerReference: string,
    amount: Money,
  ): Promise<Result<string, DependencyFailureError>> {
    const reference = `sepa_rfnd_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.settlements.push({
      providerReference: reference,
      amountMinor: `-${amount.amount.toString()}`,
      currency: amount.currencyCode,
      settledAt: nextBusinessSettlement(),
      status: 'reversed',
    });
    return ok(reference);
  }

  async payout(
    request: PayoutRequest,
  ): Promise<Result<AuthorizationResult, DependencyFailureError>> {
    const providerReference = `sepa_po_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.settlements.push({
      providerReference,
      amountMinor: `-${request.amount.amount.toString()}`,
      currency: request.amount.currencyCode,
      settledAt: nextBusinessSettlement(),
      status: 'pending',
    });
    return ok({ providerReference, approved: true, raw: { rail: 'sepa' } });
  }

  async fetchSettlements(from: Date, to: Date): Promise<ProviderSettlementLine[]> {
    return this.settlements.filter((line) => line.settledAt >= from && line.settledAt < to);
  }
}

function nextBusinessSettlement(now = new Date()): Date {
  const settlement = new Date(now.getTime() + 60_000);
  const day = settlement.getUTCDay();
  if (day === 6) settlement.setUTCDate(settlement.getUTCDate() + 2);
  if (day === 0) settlement.setUTCDate(settlement.getUTCDate() + 1);
  return settlement;
}
