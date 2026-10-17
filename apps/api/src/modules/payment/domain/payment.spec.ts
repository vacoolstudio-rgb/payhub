import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Money } from '@payhub/kernel';
import { Payment, PaymentDirection, PaymentId, PaymentStatus } from './payment.aggregate.js';

const MERCHANT = '33333333-3333-4333-8333-333333333333';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function deposit(amount = '100.00', fee = '3.20'): Payment {
  return Payment.initiate({
    id: PaymentId.create(),
    merchantId: MERCHANT,
    userId: USER,
    direction: PaymentDirection.Deposit,
    amount: Money.fromMajor(amount, 'USD'),
    fee: Money.fromMajor(fee, 'USD'),
    method: 'card',
    reference: 'order-1',
  }).unwrap();
}

describe('Payment', () => {
  describe('creation', () => {
    it('starts pending and emits payment.initiated', () => {
      const payment = deposit();
      expect(payment.status).toBe(PaymentStatus.Pending);
      expect(payment.pullDomainEvents().map((e) => e.eventName)).toEqual(['payment.initiated.v1']);
    });

    it('rejects a non-positive amount', () => {
      const result = Payment.initiate({
        id: PaymentId.create(),
        merchantId: MERCHANT,
        userId: USER,
        direction: PaymentDirection.Deposit,
        amount: Money.zero('USD'),
        fee: Money.zero('USD'),
        method: 'card',
        reference: 'r',
      });
      expect(result.unwrapErr().code).toBe('INVALID_AMOUNT');
    });

    it('requires a counterparty for a transfer, and refuses a self-transfer', () => {
      const noCounterparty = Payment.initiate({
        id: PaymentId.create(),
        merchantId: MERCHANT,
        userId: USER,
        direction: PaymentDirection.Transfer,
        amount: Money.fromMajor('10.00', 'USD'),
        fee: Money.zero('USD'),
        method: 'internal',
        reference: 'r',
      });
      expect(noCounterparty.unwrapErr().code).toBe('COUNTERPARTY_REQUIRED');

      const self = Payment.initiate({
        id: PaymentId.create(),
        merchantId: MERCHANT,
        userId: USER,
        counterpartyUserId: USER,
        direction: PaymentDirection.Transfer,
        amount: Money.fromMajor('10.00', 'USD'),
        fee: Money.zero('USD'),
        method: 'internal',
        reference: 'r',
      });
      expect(self.unwrapErr().code).toBe('SELF_TRANSFER');
    });

    it('computes the net amount per direction', () => {
      expect(deposit().netAmount.toMajorString()).toBe('96.80');

      const withdrawal = Payment.initiate({
        id: PaymentId.create(),
        merchantId: MERCHANT,
        userId: USER,
        direction: PaymentDirection.Withdrawal,
        amount: Money.fromMajor('100.00', 'USD'),
        fee: Money.fromMajor('3.20', 'USD'),
        method: 'bank_transfer',
        reference: 'w-1',
      }).unwrap();

      // A withdrawal costs the user the fee on top of the amount.
      expect(withdrawal.netAmount.toMajorString()).toBe('103.20');
    });
  });

  describe('state machine', () => {
    let payment: Payment;

    beforeEach(() => {
      payment = deposit();
    });

    it('walks the happy path', () => {
      expect(payment.authorize('auth_1').isOk()).toBe(true);
      expect(payment.beginCapture('transfer-1').isOk()).toBe(true);
      expect(payment.completeCapture('transfer-1').isOk()).toBe(true);
      expect(payment.status).toBe(PaymentStatus.Captured);
      expect(payment.isTerminal).toBe(true);
    });

    it('refuses an illegal transition and says which ones are legal', () => {
      payment.authorize('auth_1');
      payment.beginCapture('t1');
      payment.completeCapture('t1');

      const cancelled = payment.cancel();
      expect(cancelled.unwrapErr().code).toBe('INVALID_TRANSITION');
      expect(cancelled.unwrapErr().details['from']).toBe(PaymentStatus.Captured);
    });

    /**
     * Kafka is at-least-once: the same confirmation can arrive twice. The
     * second call must report that nothing happened, because the caller
     * publishes an integration event — and a second `payment.captured`
     * means a second webhook to the merchant.
     */
    it('reports a repeated capture as already-captured', () => {
      payment.authorize('auth_1');
      payment.beginCapture('t1');

      expect(payment.completeCapture('t1').unwrap()).toBe('captured');
      expect(payment.completeCapture('t1').unwrap()).toBe('already-captured');
      expect(
        payment.pullDomainEvents().filter((e) => e.eventName === 'payment.captured.v1'),
      ).toHaveLength(1);
    });

    it('still refuses a capture that carries a different transfer id', () => {
      payment.authorize('auth_1');
      payment.beginCapture('t1');
      payment.completeCapture('t1');

      expect(payment.completeCapture('t2').isErr()).toBe(true);
    });

    it('is idempotent on failure too', () => {
      expect(payment.fail('provider_declined').isOk()).toBe(true);
      expect(payment.fail('provider_declined').isOk()).toBe(true);
      expect(payment.status).toBe(PaymentStatus.Failed);
    });

    it('expires only while non-terminal', () => {
      const captured = deposit();
      captured.authorize('a');
      captured.beginCapture('t');
      captured.completeCapture('t');

      expect(captured.expire().isOk()).toBe(true);
      expect(captured.status).toBe(PaymentStatus.Captured);

      expect(payment.expire().isOk()).toBe(true);
      expect(payment.status).toBe(PaymentStatus.Failed);
      expect(payment.failureReason).toBe('expired');
    });
  });

  describe('refunds', () => {
    function captured(): Payment {
      const payment = deposit();
      payment.authorize('auth_1');
      payment.beginCapture('t1');
      payment.completeCapture('t1');
      payment.pullDomainEvents();
      return payment;
    }

    it('supports partial refunds and stays captured until fully refunded', () => {
      const payment = captured();

      payment.beginRefund(Money.fromMajor('40.00', 'USD'), randomUUID());
      payment.completeRefund(Money.fromMajor('40.00', 'USD'));
      expect(payment.status).toBe(PaymentStatus.Captured);
      expect(payment.refundableAmount.toMajorString()).toBe('60.00');

      payment.beginRefund(Money.fromMajor('60.00', 'USD'), randomUUID());
      payment.completeRefund(Money.fromMajor('60.00', 'USD'));
      expect(payment.status).toBe(PaymentStatus.Refunded);
      expect(payment.refundableAmount.isZero()).toBe(true);
    });

    it('refuses to refund more than was charged', () => {
      const payment = captured();
      const result = payment.beginRefund(Money.fromMajor('100.01', 'USD'), randomUUID());

      expect(result.unwrapErr().code).toBe('REFUND_EXCEEDS_AMOUNT');
    });
  });

  it('keeps the counterparty on a transfer', () => {
    const transfer = Payment.initiate({
      id: PaymentId.create(),
      merchantId: MERCHANT,
      userId: USER,
      counterpartyUserId: OTHER,
      direction: PaymentDirection.Transfer,
      amount: Money.fromMajor('25.00', 'USD'),
      fee: Money.zero('USD'),
      method: 'internal',
      reference: 't-1',
    }).unwrap();

    expect(transfer.counterpartyUserId).toBe(OTHER);
  });
});
