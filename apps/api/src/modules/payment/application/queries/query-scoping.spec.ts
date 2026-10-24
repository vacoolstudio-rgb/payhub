import { describe, expect, it, vi } from 'vitest';
import { GetPaymentStats, GetPaymentStatsHandler, ListPayments, ListPaymentsHandler } from './payment.queries.js';

const WINDOW = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-02-01T00:00:00Z') };

const statsHandler = (stats = vi.fn()) =>
  [
    new GetPaymentStatsHandler({ stats } as never, {
      getOrSet: async (_key: string, load: () => Promise<unknown>) => load(),
    } as never),
    stats,
  ] as const;

const listHandler = (list = vi.fn()) =>
  [new ListPaymentsHandler({ list } as never), list] as const;

/**
 * Two queries that read money, and the rule that keeps them narrow.
 *
 * Both take their scope from the principal and never from the request,
 * so a caller cannot widen one. What they cannot assume is that a scope
 * arrives at all: `AuthenticatedPrincipal` has a third kind, `service`,
 * which is neither a user nor a merchant. Its callers would leave both
 * filters empty, and the stats SQL treats an empty filter as "no filter"
 * — platform-wide volume and fees, for every merchant.
 *
 * Nothing constructs a service principal today. The listing refused
 * anyway; the aggregate did not. This is the aggregate catching up.
 */
describe('scoping of money queries', () => {
  describe('payment statistics', () => {
    it('refuses to aggregate with no scope at all', async () => {
      const [handler, stats] = statsHandler();

      await expect(
        handler.execute(new GetPaymentStats({ currency: 'USD', ...WINDOW })),
      ).rejects.toMatchObject({ code: 'UNSCOPED_QUERY' });
      expect(stats).not.toHaveBeenCalled();
    });

    it('runs for a user', async () => {
      const [handler, stats] = statsHandler(vi.fn().mockResolvedValue({ totalCount: 1 }));

      await handler.execute(new GetPaymentStats({ userId: 'user-1', currency: 'USD', ...WINDOW }));

      expect(stats).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
    });

    it('runs for a merchant', async () => {
      const [handler, stats] = statsHandler(vi.fn().mockResolvedValue({ totalCount: 1 }));

      await handler.execute(
        new GetPaymentStats({ merchantId: 'merchant-1', currency: 'USD', ...WINDOW }),
      );

      expect(stats).toHaveBeenCalledWith(expect.objectContaining({ merchantId: 'merchant-1' }));
    });
  });

  describe('payment listing', () => {
    it('refuses an unscoped listing', async () => {
      const [handler, list] = listHandler();

      await expect(handler.execute(new ListPayments({ limit: 25 }))).rejects.toMatchObject({
        code: 'UNSCOPED_QUERY',
      });
      expect(list).not.toHaveBeenCalled();
    });

    it('runs for a user', async () => {
      const [handler, list] = listHandler(
        vi.fn().mockResolvedValue({ items: [], nextCursor: null, hasMore: false }),
      );

      await handler.execute(new ListPayments({ userId: 'user-1', limit: 25 }));

      expect(list).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
    });
  });
});
