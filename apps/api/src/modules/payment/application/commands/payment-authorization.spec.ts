import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Money, ok } from '@payhub/kernel';
import { bindTestTransactions } from '@payhub/testing';
import { Payment, PaymentDirection, PaymentId } from '../../domain/payment.aggregate.js';
import type { MerchantAuthority } from '../../domain/merchant-authority.port.js';
import { CancelPaymentHandler } from './cancel-payment.handler.js';
import { RefundPaymentHandler } from './refund-payment.handler.js';
import { CancelPayment, RefundPayment } from './payment.commands.js';

const ACME = '33333333-3333-4333-8333-333333333333';
const ACME_OWNER = 'aaaaaaaa-1111-4111-8111-111111111111';
const RIVAL_OWNER = 'bbbbbbbb-2222-4222-8222-222222222222';
const PAYER = 'cccccccc-3333-4333-8333-333333333333';

function capturedPayment(): Payment {
  const payment = Payment.initiate({
    id: PaymentId.create(),
    merchantId: ACME,
    userId: PAYER,
    direction: PaymentDirection.Deposit,
    amount: Money.fromMajor('50.00', 'USD'),
    fee: Money.fromMajor('0.00', 'USD'),
    method: 'card',
    reference: 'order-1',
  }).unwrap();

  payment.authorize('auth_1');
  payment.beginCapture(randomUUID());
  payment.completeCapture(randomUUID());
  payment.pullDomainEvents();
  return payment;
}

/**
 * Who may send money back out.
 *
 * `payment:refund` is held by every `merchant_owner`, so the route guard
 * only establishes that the caller runs *a* merchant. Narrowing that to
 * the merchant who actually took the payment is the handler's job, and
 * for a while it was not done: the check refused the payer and allowed
 * everyone else, under a comment saying only the merchant side could
 * refund. Run against the live API, a second merchant owner refunded a
 * captured payment belonging to a merchant they had no relationship
 * with, and the fifty dollars moved.
 *
 * Nothing had ever asserted on this path, which is the real reason it
 * survived.
 */
describe('refund authorization', () => {
  let payment: Payment;
  let handler: RefundPaymentHandler;
  let mayActFor: ReturnType<typeof vi.fn>;
  let unbind: () => void;

  const refundBy = (actorUserId: string, actorIsPlatformAdmin = false) =>
    handler.execute(
      new RefundPayment({
        paymentId: payment.id,
        actorUserId,
        actorIsPlatformAdmin,
        amountMajor: '50.00',
        reason: 'test',
      }),
    );

  afterEach(() => unbind());

  beforeEach(() => {
    unbind = bindTestTransactions();
    payment = capturedPayment();
    mayActFor = vi.fn(
      async (merchantId: string, userId: string) => merchantId === ACME && userId === ACME_OWNER,
    );

    handler = new RefundPaymentHandler(
      {
        findByIdForUpdate: async () => payment,
        save: async () => undefined,
      } as never,
      { forMethod: () => ({ refund: async () => ok(undefined) }) } as never,
      { mayActFor } as MerchantAuthority as never,
      { publish: async () => undefined, publishMany: async () => undefined } as never,
      { emit: () => true } as never,
    );
  });

  it('refuses a merchant owner who does not own this merchant', async () => {
    await expect(refundBy(RIVAL_OWNER)).rejects.toMatchObject({ code: 'REFUND_FORBIDDEN' });
  });

  it('refuses the payer', async () => {
    await expect(refundBy(PAYER)).rejects.toMatchObject({ code: 'REFUND_FORBIDDEN' });
  });

  it('asks about the merchant on the payment, not one the caller supplied', async () => {
    await refundBy(ACME_OWNER).catch(() => undefined);

    expect(mayActFor).toHaveBeenCalledWith(ACME, ACME_OWNER);
  });

  it('allows the owner of the merchant that took the payment', async () => {
    await expect(refundBy(ACME_OWNER)).resolves.toMatchObject({ status: 'refunding' });
  });

  /** Support and incident response would be impossible otherwise. */
  it('allows platform staff regardless of merchant', async () => {
    await expect(refundBy(RIVAL_OWNER, true)).resolves.toMatchObject({ status: 'refunding' });
    expect(mayActFor).not.toHaveBeenCalled();
  });
});

/**
 * Cancelling someone else's payment.
 *
 * Any user holds `payment:cancel` — it is how you abandon your own
 * pending payment — so the handler is the only thing standing between a
 * caller and a stranger's payment. It refused correctly and answered
 * 403, which is itself the leak: a random uuid answered 404, so the pair
 * of responses confirms whether an id names a real payment. Measured on
 * the running API before this was changed.
 */
describe('cancel authorization', () => {
  let unbind: () => void;
  let pending: Payment;
  let handler: CancelPaymentHandler;

  const cancelBy = (actorUserId: string, found: Payment | null = pending) => {
    handler = new CancelPaymentHandler(
      { findByIdForUpdate: async () => found, save: async () => undefined } as never,
      { publish: async () => undefined } as never,
      { emit: () => true } as never,
    );
    return handler.execute(new CancelPayment({ paymentId: pending.id, actorUserId }));
  };

  afterEach(() => unbind());

  beforeEach(() => {
    unbind = bindTestTransactions();
    pending = Payment.initiate({
      id: PaymentId.create(),
      merchantId: ACME,
      userId: PAYER,
      direction: PaymentDirection.Deposit,
      amount: Money.fromMajor('50.00', 'USD'),
      fee: Money.fromMajor('0.00', 'USD'),
      method: 'card',
      reference: 'order-1',
    }).unwrap();
  });

  it('answers a stranger exactly as it answers for a payment that does not exist', async () => {
    const foreign = await cancelBy(RIVAL_OWNER).catch((error: { code?: string }) => error.code);
    const absent = await cancelBy(RIVAL_OWNER, null).catch((error: { code?: string }) => error.code);

    expect(foreign).toBe(absent);
  });

  it('does not confirm the payment exists', async () => {
    await expect(cancelBy(RIVAL_OWNER)).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' });
  });

  it('still lets the payer cancel their own', async () => {
    await expect(cancelBy(PAYER)).resolves.toMatchObject({ status: 'cancelled' });
  });
});
