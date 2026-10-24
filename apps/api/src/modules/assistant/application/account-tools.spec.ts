import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountToolsService } from './account-tools.service.js';

/**
 * What a question is allowed to reach.
 *
 * The model writes these arguments, and a question is attacker-supplied
 * text, so the schema is the boundary rather than documentation. The
 * cases below are the ways an argument could make a lookup cost more
 * than it should, or point somewhere it should not.
 */
describe('AccountToolsService', () => {
  let queries: { execute: ReturnType<typeof vi.fn> };
  let wallets: { balances: ReturnType<typeof vi.fn> };
  let service: AccountToolsService;

  const tool = (name: string) => {
    const found = service.tools().find((candidate) => candidate.definition.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  const context = { userId: 'user-1' };

  beforeEach(() => {
    queries = { execute: vi.fn().mockResolvedValue({ items: [], nextCursor: null, hasMore: false }) };
    wallets = { balances: vi.fn().mockResolvedValue([]) };
    service = new AccountToolsService(
      queries as never,
      wallets as never,
      {
        getOrRevalidate: async (_key: string, load: () => Promise<unknown>) => load(),
      } as never,
    );
  });

  it('offers only read-only lookups', () => {
    const names = service.tools().map((entry) => entry.definition.name);

    expect(names).toEqual(['get_balances', 'get_payment_totals', 'search_payments']);
  });

  /**
   * The invariant the design rests on. No schema accepts a user id, so
   * there is no argument an injected instruction could set to read
   * another account — the worst a successful injection achieves is a
   * different date range on the asker's own data.
   */
  it('exposes no way to name an account', () => {
    for (const entry of service.tools()) {
      expect(JSON.stringify(entry.definition.inputSchema)).not.toMatch(/user|account|owner/i);
    }
  });

  it('refuses outright an attempt to name another account', async () => {
    await expect(
      tool('search_payments').run(
        { from: '2026-03-01', to: '2026-03-31', userId: 'someone-else' },
        context,
      ),
    ).rejects.toThrow();
  });

  it('queries the caller from the context', async () => {
    await tool('search_payments').run({ from: '2026-03-01', to: '2026-03-31' }, context);

    expect(queries.execute).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ userId: 'user-1' }) }),
    );
  });

  describe('bounds on the window', () => {
    it('refuses a range longer than a year', async () => {
      await expect(
        tool('get_payment_totals').run(
          { from: '2020-01-01', to: '2026-01-01', currency: 'USD' },
          context,
        ),
      ).rejects.toThrow(/366 days/);
    });

    it('accepts a range inside it', async () => {
      queries.execute.mockResolvedValue({
        totalCount: 3,
        capturedCount: 3,
        failedCount: 0,
        volumeMinor: '12345',
        feeMinor: '200',
        currency: 'USD',
      });

      await expect(
        tool('get_payment_totals').run(
          { from: '2026-03-01', to: '2026-04-01', currency: 'USD' },
          context,
        ),
      ).resolves.toContain('123.45');
    });

    it('refuses a range that runs backwards', async () => {
      await expect(
        tool('get_payment_totals').run(
          { from: '2026-04-01', to: '2026-03-01', currency: 'USD' },
          context,
        ),
      ).rejects.toThrow(/from must not be after to/);
    });

    it('refuses a date it cannot parse', async () => {
      await expect(
        tool('search_payments').run({ from: 'last tuesday', to: '2026-03-01' }, context),
      ).rejects.toThrow(/YYYY-MM-DD/);
    });

    it('refuses a row count above the cap', async () => {
      await expect(
        tool('search_payments').run(
          { from: '2026-03-01', to: '2026-03-31', limit: 5_000 },
          context,
        ),
      ).rejects.toThrow();
    });

    it('refuses an argument the schema does not define', async () => {
      await expect(
        tool('get_payment_totals').run(
          { from: '2026-03-01', to: '2026-04-01', currency: 'USD', merchantId: 'other' },
          context,
        ),
      ).rejects.toThrow();
    });
  });

  it('says so plainly when a window is empty, rather than returning nothing', async () => {
    await expect(
      tool('search_payments').run({ from: '2026-03-01', to: '2026-03-31' }, context),
    ).resolves.toContain('No payments');
  });

  it('reads balances for the caller', async () => {
    wallets.balances.mockResolvedValue([
      { currency: 'USD', available: { major: '10.00' }, pending: { major: '0.00' } },
    ]);

    await expect(tool('get_balances').run({}, context)).resolves.toContain('USD: available 10.00');
    expect(wallets.balances).toHaveBeenCalledWith('user-1');
  });
});
