import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DependencyFailureError, type Money, type Result, err, ok } from '@payhub/kernel';
import { CircuitBreaker, retry } from '@payhub/shared';
import type {
  AuthorizationRequest,
  AuthorizationResult,
  PaymentProvider,
  PayoutRequest,
  ProviderSettlementLine,
} from '../../domain/payment-provider.port.js';

/**
 * Simulated card acquirer.
 *
 * Stands in for a real PSP so the whole saga — authorise, capture, refund,
 * reconcile — can be exercised end to end in tests and locally. The
 * *resilience* around it is not simulated: the retry ladder and the circuit
 * breaker below are exactly what a production adapter needs.
 *
 * Behaviour is driven by `metadata.simulate` so tests can force a decline, a
 * timeout or a 500 without monkey-patching the class.
 */
@Injectable()
export class CardPaymentProvider implements PaymentProvider {
  readonly name = 'card-acquirer';
  readonly methods = ['card', 'card_token', 'apple_pay'] as const;

  private readonly logger = new Logger(CardPaymentProvider.name);

  /**
   * One breaker per adapter instance. Opening it stops us from queueing
   * thousands of doomed requests against an acquirer that is already down —
   * the behaviour that turns a partial outage into a full one.
   */
  private readonly breaker = new CircuitBreaker({
    name: this.name,
    // Half the last twenty calls failing is already an outage worth
    // failing fast on; ten calls is enough to call it a trend.
    windowSize: 20,
    failureRateThreshold: 0.5,
    minimumCalls: 10,
    resetTimeoutMs: 30_000,
    successThreshold: 2,
  });

  private readonly settlements: ProviderSettlementLine[] = [];

  async authorize(
    request: AuthorizationRequest,
  ): Promise<Result<AuthorizationResult, DependencyFailureError>> {
    const scenario = request.metadata['simulate'] ?? 'approve';

    try {
      const result = await this.breaker.execute(() =>
        retry(
          async () => {
            await this.simulateLatency();

            if (scenario === 'provider_error') {
              throw new DependencyFailureError(this.name, 'Acquirer returned 503', {
                retryable: true,
              });
            }
            if (scenario === 'timeout') {
              throw new DependencyFailureError(this.name, 'Acquirer timed out', {
                retryable: true,
              });
            }

            const providerReference = `auth_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

            if (scenario === 'decline') {
              return {
                providerReference,
                approved: false,
                declineReason: 'do_not_honour',
                raw: { scenario, code: '05' },
              } satisfies AuthorizationResult;
            }

            this.settlements.push({
              providerReference,
              amountMinor: request.amount.amount.toString(),
              currency: request.currency,
              settledAt: new Date(),
              status: 'pending',
            });

            return {
              providerReference,
              approved: true,
              raw: { scenario, code: '00', network: 'visa' },
            } satisfies AuthorizationResult;
          },
          {
            attempts: 3,
            baseDelayMs: 100,
            maxDelayMs: 2_000,
            // Only network-shaped failures are retried. Retrying a decline
            // would be both useless and, on some networks, fraud-flagged.
            isRetryable: (error) =>
              error instanceof DependencyFailureError && error.retryable,
            onRetry: (_error, attempt, waitMs) =>
              this.logger.warn(`Authorisation retry ${attempt} in ${waitMs}ms`),
          },
        ),
      );

      return ok(result);
    } catch (error) {
      return err(
        error instanceof DependencyFailureError
          ? error
          : new DependencyFailureError(this.name, 'Authorisation failed', { cause: error }),
      );
    }
  }

  async capture(
    providerReference: string,
    amount: Money,
  ): Promise<Result<void, DependencyFailureError>> {
    await this.simulateLatency();

    const line = this.settlements.find((item) => item.providerReference === providerReference);
    if (!line) {
      return err(
        new DependencyFailureError(this.name, 'Unknown authorisation', { retryable: false }),
      );
    }

    this.settlements[this.settlements.indexOf(line)] = {
      ...line,
      status: 'settled',
      amountMinor: amount.amount.toString(),
      settledAt: new Date(),
    };

    return ok(undefined);
  }

  async refund(
    providerReference: string,
    amount: Money,
  ): Promise<Result<string, DependencyFailureError>> {
    await this.simulateLatency();

    const refundReference = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    this.settlements.push({
      providerReference: refundReference,
      amountMinor: `-${amount.amount.toString()}`,
      currency: amount.currencyCode,
      settledAt: new Date(),
      status: 'reversed',
    });

    this.logger.debug(`Refunded ${amount.toString()} against ${providerReference}`);
    return ok(refundReference);
  }

  async payout(
    request: PayoutRequest,
  ): Promise<Result<AuthorizationResult, DependencyFailureError>> {
    await this.simulateLatency();

    const providerReference = `po_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

    this.settlements.push({
      providerReference,
      amountMinor: `-${request.amount.amount.toString()}`,
      currency: request.amount.currencyCode,
      settledAt: new Date(),
      status: 'pending',
    });

    return ok({ providerReference, approved: true, raw: { destination: request.destination } });
  }

  async fetchSettlements(from: Date, to: Date): Promise<ProviderSettlementLine[]> {
    return this.settlements.filter((line) => line.settledAt >= from && line.settledAt < to);
  }

  get circuitState(): string {
    return this.breaker.currentState;
  }

  private async simulateLatency(): Promise<void> {
    await delay(5 + Math.floor(Math.random() * 15));
  }
}
