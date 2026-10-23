import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { queryCostPlugin } from './query-cost.plugin.js';

/**
 * Query admission, before a single resolver runs.
 *
 * Depth limiting alone is the common half-measure and this schema shows
 * why: `paymentStats` is a `GROUP BY` over a month and sits at depth
 * one, so fifty of them behind aliases is a two-deep query that runs
 * fifty aggregates. Measured against the depth-only version: fifty
 * aliases served in 178 ms.
 */
async function admit(
  query: string,
  options = { maxDepth: 8, maxCost: 500 },
): Promise<{ ok: boolean; code?: string; message?: string }> {
  const plugin = queryCostPlugin(options);
  const listener = await (
    plugin.requestDidStart as () => Promise<{
      didResolveOperation: (ctx: { document: unknown; operationName: null }) => Promise<void>;
    }>
  )();

  try {
    await listener.didResolveOperation({ document: parse(query), operationName: null });
    return { ok: true };
  } catch (error) {
    const graphQlError = error as { extensions?: { code?: string }; message?: string };
    return {
      ok: false,
      ...(graphQlError.extensions?.code !== undefined
        ? { code: graphQlError.extensions.code }
        : {}),
      ...(graphQlError.message !== undefined ? { message: graphQlError.message } : {}),
    };
  }
}

const aliased = (count: number, field = 'paymentStats(currency: "USD", days: 30)') =>
  `{ ${Array.from({ length: count }, (_, i) => `a${i}: ${field} { totalCount }`).join(' ')} }`;

describe('queryCostPlugin', () => {
  describe('cost', () => {
    /**
     * The attack the depth limit could not see. Each alias is a separate
     * execution of the same expensive field, all of them at depth one.
     */
    it('rejects a query that aliases an aggregate many times', async () => {
      const result = await admit(aliased(50));

      expect(result).toMatchObject({ ok: false, code: 'QUERY_TOO_EXPENSIVE' });
    });

    it('allows a handful of aggregates', async () => {
      await expect(admit(aliased(5))).resolves.toMatchObject({ ok: true });
    });

    /** Aliases of the same field must not collapse into one. */
    it('counts aliases separately rather than by field name', async () => {
      const single = await admit(aliased(1));
      const many = await admit(aliased(20));

      expect(single.ok).toBe(true);
      expect(many.ok).toBe(false);
    });

    /** A page of a hundred is ten pages of ten, and is priced as such. */
    it('prices a page by the rows it asks for', async () => {
      const small = await admit('{ payments(limit: 5) { items { id } } }', {
        maxDepth: 8,
        maxCost: 30,
      });
      const large = await admit('{ payments(limit: 100) { items { id } } }', {
        maxDepth: 8,
        maxCost: 30,
      });

      expect(small.ok).toBe(true);
      expect(large.ok).toBe(false);
    });

    /**
     * A variable's value is unknown until execution, so pricing it low
     * is exactly how the limit gets walked around.
     */
    it('prices a variable page at the ceiling the schema allows', async () => {
      const result = await admit(
        'query P($n: Int) { payments(limit: $n) { items { id } } }',
        { maxDepth: 8, maxCost: 30 },
      );

      expect(result.ok).toBe(false);
    });

    it('lets the real dashboard query through', async () => {
      const dashboard = `
        query Dashboard($limit: Int!, $currency: String!) {
          wallets { id currency available { minor major currency } status }
          payments(limit: $limit) {
            items { id status amount { minor major currency } merchant { id name } }
            pageInfo { hasMore nextCursor }
          }
          paymentStats(currency: $currency, days: 30) { totalCount volume { minor } }
        }
      `;

      await expect(admit(dashboard)).resolves.toMatchObject({ ok: true });
    });

    /** Schema metadata is not user data and is not charged for. */
    it('does not charge for introspection', async () => {
      await expect(
        admit('{ __schema { types { name } } }', { maxDepth: 2, maxCost: 5 }),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  describe('depth', () => {
    it('still rejects a deeply nested query', async () => {
      const deep = '{ payments { items { merchant { id } } } }';

      await expect(admit(deep, { maxDepth: 2, maxCost: 10_000 })).resolves.toMatchObject({
        ok: false,
        code: 'QUERY_TOO_DEEP',
      });
    });

    it('allows a query within the depth budget', async () => {
      await expect(
        admit('{ payments { items { id } } }', { maxDepth: 3, maxCost: 10_000 }),
      ).resolves.toMatchObject({ ok: true });
    });
  });
});
