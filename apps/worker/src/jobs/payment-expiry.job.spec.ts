import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostTransferCommand } from '@payhub/contracts';
import { bindTestTransactions } from '@payhub/testing';
import { PaymentExpiryJob } from './payment-expiry.job.js';

const TRANSFER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function stuckRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    merchant_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    direction: 'deposit',
    amount_minor: '10000',
    fee_minor: '320',
    currency: 'USD',
    reference: 'order-1',
    status: 'capturing',
    method: 'card',
    counterparty_user_id: null,
    transfer_id: TRANSFER,
    refund_transfer_id: null,
    refund_amount_minor: null,
    ...overrides,
  };
}

/**
 * The stuck-payment sweep re-issues ledger commands, so its mistakes are
 * made of money rather than of latency.
 */
describe('PaymentExpiryJob: stuck-payment recovery', () => {
  let job: PaymentExpiryJob;
  let rows: Array<Record<string, unknown>>;
  let published: Array<{ definition: unknown; payload: Record<string, unknown> }>;
  let skipped: Array<Record<string, string>>;
  let unbind: () => void;

  afterEach(() => unbind());

  beforeEach(() => {
    unbind = bindTestTransactions();
    rows = [];
    published = [];
    skipped = [];

    const transactions = { manager: { query: vi.fn(async () => rows) } };
    const outbox = {
      publish: vi.fn(async (definition: unknown, payload: Record<string, unknown>) => {
        published.push({ definition, payload });
        return 'outbox-id';
      }),
    };
    const metrics = {
      recoverySkipped: { inc: (labels: Record<string, string>) => void skipped.push(labels) },
    };
    const advisoryLocks = {
      withSessionLock: vi.fn(async (_name: string, work: () => Promise<number>) => work()),
    };

    job = new PaymentExpiryJob(
      transactions as never,
      { withLock: vi.fn() } as never,
      advisoryLocks as never,
      outbox as never,
      metrics as never,
      { distributedLockTtlMs: 30_000 } as never,
    );
  });

  it('re-issues the command under the transfer id the payment already has', async () => {
    rows = [stuckRow()];

    await job.recoverStuckPayments();

    expect(published).toHaveLength(1);
    expect(published[0]!.definition).toBe(PostTransferCommand);
    expect(published[0]!.payload).toMatchObject({
      transferId: TRANSFER,
      paymentId: stuckRow().id,
    });
  });

  /**
   * Regression, and the most expensive kind. The code read
   * `row.transfer_id ?? randomUUID()` directly beneath a comment
   * explaining that re-issuing is safe *because* the id is unchanged. The
   * ledger deduplicates on `transferId`, so a generated id is not a
   * retry — it is a second transfer, and this cron runs every five
   * minutes, minting a new one each time.
   */
  it('refuses to invent a transfer id for a payment that has none', async () => {
    rows = [stuckRow({ transfer_id: null })];

    await job.recoverStuckPayments();

    expect(published).toHaveLength(0);
  });

  /** A silent skip is indistinguishable from nothing to do. */
  it('records the refusal so it can be alerted on', async () => {
    rows = [stuckRow({ transfer_id: null })];

    await job.recoverStuckPayments();

    expect(skipped).toEqual([{ job: 'stuck-payments', reason: 'no_transfer_id' }]);
  });

  it('keeps recovering the sound rows alongside a broken one', async () => {
    rows = [stuckRow({ transfer_id: null, id: 'broken' }), stuckRow()];

    await job.recoverStuckPayments();

    expect(published).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  /**
   * `refunding` is entered in one transaction and left by an event from
   * the ledger. Nothing swept the gap between them, so a crash or a lost
   * reply left the customer un-refunded and the payment un-retryable —
   * `beginRefund` refuses to start again from `refunding`.
   */
  describe('stalled refunds', () => {
    const refunding = (overrides: Record<string, unknown> = {}) =>
      stuckRow({
        status: 'refunding',
        refund_transfer_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        refund_amount_minor: '4000',
        ...overrides,
      });

    it('re-issues the refund under the transfer id it was started with', async () => {
      rows = [refunding()];

      await job.recoverStalledRefunds();

      expect(published).toHaveLength(1);
      expect(published[0]!.payload).toMatchObject({
        transferId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        operation: 'refund',
      });
    });

    /**
     * A partial refund of 40 on a payment of 100 must be retried for 40.
     * Re-sending the outstanding balance instead would refund the whole
     * payment if the original transfer never posted.
     */
    it('re-issues it for the amount originally requested, not the outstanding balance', async () => {
      rows = [refunding({ amount_minor: '10000', refund_amount_minor: '4000' })];

      await job.recoverStalledRefunds();

      expect(published[0]!.payload).toMatchObject({
        amount: { amount: '4000', currency: 'USD' },
      });
    });

    /** Stranded before the id was stored: a retry could refund twice. */
    it('refuses to retry a refund whose transfer id was never recorded', async () => {
      rows = [refunding({ refund_transfer_id: null, refund_amount_minor: null })];

      await job.recoverStalledRefunds();

      expect(published).toHaveLength(0);
      expect(skipped).toEqual([{ job: 'stalled-refunds', reason: 'no_transfer_id' }]);
    });
  });

  it('does nothing when another instance holds the lock', async () => {
    rows = [stuckRow()];
    job = new PaymentExpiryJob(
      { manager: { query: vi.fn(async () => rows) } } as never,
      { withLock: vi.fn() } as never,
      { withSessionLock: vi.fn(async () => null) } as never,
      { publish: vi.fn() } as never,
      { recoverySkipped: { inc: vi.fn() } } as never,
      { distributedLockTtlMs: 30_000 } as never,
    );

    await job.recoverStuckPayments();

    expect(published).toHaveLength(0);
  });
});
