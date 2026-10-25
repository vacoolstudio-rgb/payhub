import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CursorPage, Money } from '@payhub/kernel';
import { OutboxPublisher } from '@payhub/messaging';
import { MetricsService } from '@payhub/observability';
import { bindTestTransactions } from '@payhub/testing';
import type { LedgerPostingLine } from '@payhub/contracts';
import {
  Payment,
  PaymentDirection,
  PaymentId,
  PaymentStatus,
} from '../../domain/payment.aggregate.js';
import {
  PAYMENT_REPOSITORY,
  type PaymentFilter,
  type PaymentRepository,
  type PaymentStats,
} from '../../domain/payment.repository.js';
import { PAYMENT_UPDATED_EVENT } from '../payment.events.js';
import { PaymentSaga } from './payment.saga.js';
import { appConfig } from '@payhub/config';

const MERCHANT = '33333333-3333-4333-8333-333333333333';
const USER = '11111111-1111-4111-8111-111111111111';

class FakePaymentRepository implements PaymentRepository {
  readonly payments = new Map<string, Payment>();

  add(payment: Payment): Payment {
    payment.pullDomainEvents();
    this.payments.set(payment.id, payment);
    return payment;
  }

  async findById(id: PaymentId): Promise<Payment | null> {
    return this.payments.get(id) ?? null;
  }
  async findByIdForUpdate(id: PaymentId): Promise<Payment | null> {
    return this.findById(id);
  }
  async findByTransferId(transferId: string): Promise<Payment | null> {
    return [...this.payments.values()].find((p) => p.transferId === transferId) ?? null;
  }
  async findManyByIds(ids: readonly PaymentId[]): Promise<Map<PaymentId, Payment>> {
    return new Map(
      ids.filter((id) => this.payments.has(id)).map((id) => [id, this.payments.get(id)!] as const),
    );
  }
  async list(_filter: PaymentFilter): Promise<CursorPage<Payment>> {
    return { items: [...this.payments.values()], nextCursor: null, hasMore: false };
  }
  async stats(): Promise<PaymentStats> {
    return {
      totalCount: 0,
      capturedCount: 0,
      failedCount: 0,
      volumeMinor: '0',
      feeMinor: '0',
      currency: 'USD',
    };
  }
  async insert(payment: Payment): Promise<void> {
    this.payments.set(payment.id, payment);
  }
  async save(payment: Payment): Promise<void> {
    this.payments.set(payment.id, payment);
  }
}

/** Builds a payment already handed to the ledger. */
function capturingPayment(transferId: string, amount = '100.00', fee = '3.20'): Payment {
  const payment = Payment.initiate({
    id: PaymentId.create(),
    merchantId: MERCHANT,
    userId: USER,
    direction: PaymentDirection.Deposit,
    amount: Money.fromMajor(amount, 'USD'),
    fee: Money.fromMajor(fee, 'USD'),
    method: 'card',
    reference: 'order-1',
  }).unwrap();

  payment.authorize('auth_1');
  payment.beginCapture(transferId);
  return payment;
}

const userLine = (major: string): LedgerPostingLine => ({
  account: `user:${USER}:available:USD`,
  direction: 'debit',
  amount: Money.fromMajor(major, 'USD').toJSON(),
});

const TEST_APP_CONFIG = {
  serviceName: 'payhub-test',
  serviceVersion: '0.0.0-test',
  nodeEnv: 'test',
} as never;

describe('PaymentSaga', () => {
  let saga: PaymentSaga;
  let payments: FakePaymentRepository;
  let outbox: { publish: ReturnType<typeof vi.fn> };
  let emitted: Array<{ event: string; payload: unknown }>;
  let unbind: () => void;

  beforeEach(async () => {
    unbind = bindTestTransactions();
    payments = new FakePaymentRepository();
    outbox = { publish: vi.fn().mockResolvedValue('id') };
    emitted = [];

    const events = new EventEmitter2();
    events.onAny((event, payload) => emitted.push({ event: String(event), payload }));

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentSaga,
        { provide: PAYMENT_REPOSITORY, useValue: payments },
        { provide: OutboxPublisher, useValue: outbox },
        { provide: appConfig.KEY, useValue: TEST_APP_CONFIG },
        MetricsService,
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    saga = moduleRef.get(PaymentSaga);
  });

  afterEach(() => unbind());

  const published = () => outbox.publish.mock.calls.map(([definition]) => definition.name);

  describe('on transfer posted', () => {
    it('captures the payment and announces it', async () => {
      const payment = payments.add(capturingPayment('transfer-1'));

      await saga.onTransferPosted({
        transferId: 'transfer-1',
        paymentId: payment.id,
        userId: USER,
        purpose: 'capture',
        postedAt: new Date().toISOString(),
        lines: [],
      });

      expect(payment.status).toBe(PaymentStatus.Captured);
      expect(published()).toContain('payment.captured.v1');
      expect(emitted.map((entry) => entry.event)).toContain(PAYMENT_UPDATED_EVENT);
    });

    /** Kafka is at-least-once; the same confirmation can arrive twice. */
    it('is idempotent on redelivery', async () => {
      const payment = payments.add(capturingPayment('transfer-1'));
      const input = {
        transferId: 'transfer-1',
        paymentId: payment.id,
        userId: USER,
        purpose: 'capture',
        postedAt: new Date().toISOString(),
        lines: [],
      };

      await saga.onTransferPosted(input);
      await saga.onTransferPosted(input);

      expect(payment.status).toBe(PaymentStatus.Captured);
      expect(published().filter((name) => name === 'payment.captured.v1')).toHaveLength(1);
    });

    it('fails loudly for a payment it has never seen', async () => {
      await expect(
        saga.onTransferPosted({
          transferId: 'transfer-1',
          paymentId: PaymentId.create(),
          userId: USER,
          purpose: 'capture',
          postedAt: new Date().toISOString(),
          lines: [],
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' });
    });

    /**
     * An unexpected transition means the saga and the ledger disagree. It
     * must not throw: throwing would roll the inbox row back and loop the
     * message forever. Reconciliation is the backstop.
     */
    it('logs and moves on when the transition is impossible', async () => {
      const payment = payments.add(capturingPayment('transfer-1'));
      payment.fail('provider_declined');
      payment.pullDomainEvents();

      await expect(
        saga.onTransferPosted({
          transferId: 'transfer-1',
          paymentId: payment.id,
          userId: USER,
          purpose: 'capture',
          postedAt: new Date().toISOString(),
          lines: [],
        }),
      ).resolves.toBeUndefined();

      expect(payment.status).toBe(PaymentStatus.Failed);
    });
  });

  describe('on refund posted', () => {
    async function captured(amount = '100.00'): Promise<Payment> {
      const payment = payments.add(capturingPayment('transfer-1', amount));
      await saga.onTransferPosted({
        transferId: 'transfer-1',
        paymentId: payment.id,
        userId: USER,
        purpose: 'capture',
        postedAt: new Date().toISOString(),
        lines: [],
      });
      payment.beginRefund(Money.fromMajor('40.00', 'USD'), randomUUID());
      outbox.publish.mockClear();
      return payment;
    }

    /** A refund posting with no line against the payer: unreadable. */
    const unreadableRefund = (paymentId: string) => ({
      transferId: 'refund-1',
      paymentId,
      userId: USER,
      purpose: 'refund' as const,
      postedAt: new Date().toISOString(),
      lines: [
        {
          account: 'house:fees:USD',
          direction: 'debit' as const,
          amount: { amount: '100', currency: 'USD' },
        },
      ],
    });

    /**
     * Regression: the saga used to record `refundableAmount` — the whole
     * remaining balance — instead of what the ledger actually moved. A
     * 40.00 partial refund was booked as 100.00 and the payment flipped to
     * `refunded` with 60.00 still refundable.
     */
    it('records the amount the ledger actually moved', async () => {
      const payment = await captured('100.00');

      await saga.onTransferPosted({
        transferId: 'refund-1',
        paymentId: payment.id,
        userId: USER,
        purpose: 'refund',
        postedAt: new Date().toISOString(),
        lines: [userLine('40.00')],
      });

      expect(payment.refundedAmount.toMajorString()).toBe('40.00');
      expect(payment.refundableAmount.toMajorString()).toBe('60.00');
      // Partially refunded, so still captured — not terminal.
      expect(payment.status).toBe(PaymentStatus.Captured);
      expect(published()).toContain('payment.refunded.v1');
    });

    it('becomes refunded once the whole amount is returned', async () => {
      const payment = await captured('100.00');

      await saga.onTransferPosted({
        transferId: 'refund-1',
        paymentId: payment.id,
        userId: USER,
        purpose: 'refund',
        postedAt: new Date().toISOString(),
        lines: [userLine('100.00')],
      });

      expect(payment.status).toBe(PaymentStatus.Refunded);
    });

    it('ignores the fee lines when reading the amount', async () => {
      const payment = await captured('100.00');

      await saga.onTransferPosted({
        transferId: 'refund-1',
        paymentId: payment.id,
        userId: USER,
        purpose: 'refund',
        postedAt: new Date().toISOString(),
        lines: [
          { account: 'house:fees:USD', direction: 'debit', amount: { amount: '320', currency: 'USD' } },
          userLine('40.00'),
          {
            account: 'external:card:USD',
            direction: 'credit',
            amount: { amount: '4320', currency: 'USD' },
          },
        ],
      });

      expect(payment.refundedAmount.toMajorString()).toBe('40.00');
    });

    it('refuses to guess when the posting has no line for this user', async () => {
      const payment = await captured('100.00');

      await saga.onTransferPosted(unreadableRefund(payment.id));

      expect(payment.refundedAmount.isZero()).toBe(true);
      expect(published()).not.toContain('payment.refunded.v1');
    });

    /**
     * The dead end, and what now happens at it.
     *
     * The ledger has moved the money back and the payment cannot record
     * it. Both branches used to log an error and return, which left the
     * payment in `refunding` permanently: the customer has their refund,
     * the payment says it is still in flight, and the stalled-refund
     * sweep re-issues the same command every five minutes forever. That
     * loop cannot converge, because nothing was lost — the ledger
     * deduplicates the command, replies, and the saga fails identically.
     * One stuck payment produced an unbounded stream of errors and
     * healed nothing.
     */
    describe('when the refund cannot be recorded', () => {
      it('reverses the ledger posting instead of leaving it applied', async () => {
        const payment = await captured('100.00');

        await saga.onTransferPosted(unreadableRefund(payment.id));

        expect(published()).toContain('ledger.reverse_transfer.v1');
      });

      it('reverses the posting it could not record, not some other one', async () => {
        const payment = await captured('100.00');

        await saga.onTransferPosted(unreadableRefund(payment.id));

        const reversal = outbox.publish.mock.calls.find(
          ([contract]) => (contract as { name?: string }).name === 'ledger.reverse_transfer.v1',
        );
        expect(reversal?.[1]).toMatchObject({ transferId: 'refund-1', paymentId: payment.id });
      });

      /** The state it was actually in, so the merchant can retry deliberately. */
      it('returns the payment to captured', async () => {
        const payment = await captured('100.00');

        await saga.onTransferPosted(unreadableRefund(payment.id));

        expect(payment.status).toBe('captured');
      });

      it('leaves nothing refunded', async () => {
        const payment = await captured('100.00');

        await saga.onTransferPosted(unreadableRefund(payment.id));

        expect(payment.refundedAmount.isZero()).toBe(true);
        expect(published()).not.toContain('payment.refunded.v1');
      });

      it('breaks the retry loop by leaving no refund in flight', async () => {
        const payment = await captured('100.00');

        await saga.onTransferPosted(unreadableRefund(payment.id));

        // The sweep selects on `status = 'refunding'`; a payment back at
        // captured is no longer a candidate, which is what stops the
        // five-minute re-issue from repeating for ever.
        expect(payment.status).not.toBe('refunding');
      });
    });
  });

  describe('on transfer rejected', () => {
    it('fails the payment and tells the merchant why', async () => {
      const payment = payments.add(capturingPayment('transfer-1'));

      await saga.onTransferRejected({
        transferId: 'transfer-1',
        paymentId: payment.id,
        reason: 'insufficient_funds',
        detail: 'balance 12.00 < 100.00',
      });

      expect(payment.status).toBe(PaymentStatus.Failed);
      expect(payment.failureReason).toBe('insufficient_funds');
      expect(published()).toContain('payment.failed.v1');
    });

    /** The two contexts do not share enums; the saga translates. */
    it.each([
      ['wallet_frozen', 'wallet_frozen'],
      ['wallet_not_found', 'wallet_not_found'],
      ['currency_mismatch', 'currency_mismatch'],
      ['limit_exceeded', 'limit_exceeded'],
      ['unbalanced_entry', 'internal_error'],
    ] as const)('maps the ledger reason %s to %s', async (ledgerReason, paymentReason) => {
      const payment = payments.add(capturingPayment('transfer-1'));

      await saga.onTransferRejected({
        transferId: 'transfer-1',
        paymentId: payment.id,
        reason: ledgerReason,
        detail: null,
      });

      expect(payment.failureReason).toBe(paymentReason);
    });

    /**
     * The ledger can refuse a refund — the house account may not have the
     * funds to return. The payment must then go back to where it was:
     * nothing moved, so it is still captured.
     *
     * It used to call `fail()`, and `refunding → failed` is not a legal
     * transition, so the saga logged "already refunding" and returned.
     * The payment stayed in `refunding` forever: the customer never got
     * the money, `beginRefund` refuses to start from `refunding` so
     * nobody could retry, and no sweep looks at that state.
     */
    it('returns a payment to captured when the ledger refuses the refund', async () => {
      const payment = payments.add(capturingPayment('transfer-1'));
      await saga.onTransferPosted({
        transferId: 'transfer-1',
        paymentId: payment.id,
        userId: USER,
        purpose: 'capture',
        postedAt: new Date().toISOString(),
        lines: [],
      });
      payment.beginRefund(Money.fromMajor('40.00', 'USD'), randomUUID());
      outbox.publish.mockClear();

      await saga.onTransferRejected({
        transferId: 'refund-1',
        paymentId: payment.id,
        reason: 'insufficient_funds',
        detail: 'house account empty',
      });

      expect(payment.status).toBe(PaymentStatus.Captured);
      expect(payment.refundedAmount.isZero()).toBe(true);
      // The payment did not fail — only the refund did.
      expect(published()).not.toContain('payment.failed.v1');
    });

    it('leaves the refundable amount intact so the refund can be retried', async () => {
      const payment = payments.add(capturingPayment('transfer-1', '100.00'));
      await saga.onTransferPosted({
        transferId: 'transfer-1',
        paymentId: payment.id,
        userId: USER,
        purpose: 'capture',
        postedAt: new Date().toISOString(),
        lines: [],
      });
      payment.beginRefund(Money.fromMajor('40.00', 'USD'), randomUUID());

      await saga.onTransferRejected({
        transferId: 'refund-1',
        paymentId: payment.id,
        reason: 'insufficient_funds',
        detail: null,
      });

      expect(payment.refundableAmount.toMajorString()).toBe('100.00');
      expect(payment.beginRefund(Money.fromMajor('40.00', 'USD'), randomUUID()).isOk()).toBe(true);
    });

    it('does nothing when the payment already reached a terminal state', async () => {
      const payment = payments.add(capturingPayment('transfer-1'));
      payment.completeCapture('transfer-1');
      payment.pullDomainEvents();

      await saga.onTransferRejected({
        transferId: 'transfer-1',
        paymentId: payment.id,
        reason: 'insufficient_funds',
        detail: null,
      });

      expect(payment.status).toBe(PaymentStatus.Captured);
      expect(published()).not.toContain('payment.failed.v1');
    });
  });
});
