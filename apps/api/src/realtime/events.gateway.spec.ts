import { WsException } from '@nestjs/websockets';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '@payhub/shared';
import { EventsGateway } from './events.gateway.js';

const MERCHANT = '33333333-3333-4333-8333-333333333333';
const OTHER_MERCHANT = '44444444-4444-4444-8444-444444444444';

type Client = Parameters<EventsGateway['subscribeToMerchant']>[0];

function socket(user: Partial<AuthenticatedPrincipal> | null): Client {
  return {
    data: user === null ? {} : { user: { id: 'user-1', kind: 'user', permissions: [], ...user } },
    join: vi.fn().mockResolvedValue(undefined),
  } as unknown as Client;
}

const joined = (client: Client): string[] =>
  (client.join as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0]!);

describe('EventsGateway: subscribe:merchant', () => {
  let gateway: EventsGateway;
  let mayActFor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mayActFor = vi.fn().mockResolvedValue(false);
    gateway = new EventsGateway(
      { verifyAccessToken: vi.fn() } as never,
      { mayActFor } as never,
      { isProduction: false } as never,
    );
  });

  describe('frame validation', () => {
    /**
     * Regression: the parameter was declared `{ merchantId: string }` and
     * trusted. A socket frame is client input exactly like a request body,
     * so the annotation was a claim with nothing enforcing it — `{}`
     * reached the authorisation check as `undefined`, and `null` crashed
     * the handler on property access.
     */
    it.each([
      ['an empty object', {}],
      ['null', null],
      ['a string', 'merchant-1'],
      ['a non-uuid merchantId', { merchantId: 'nope' }],
      ['a numeric merchantId', { merchantId: 42 }],
    ])('rejects %s', async (_label, payload) => {
      const client = socket({ merchantId: MERCHANT });

      await expect(gateway.subscribeToMerchant(client, payload)).rejects.toBeInstanceOf(WsException);
      expect(joined(client)).toHaveLength(0);
    });

    /**
     * The old code let a principal with no merchant scope past the check,
     * because `undefined !== undefined` is false, and join a room named
     * after an undefined id.
     */
    it('never joins a room built from a missing id', async () => {
      const client = socket({ merchantId: undefined });

      await expect(gateway.subscribeToMerchant(client, {})).rejects.toBeInstanceOf(WsException);
      expect(joined(client)).not.toContain('merchant:undefined');
    });
  });

  describe('authorisation', () => {
    it('subscribes a merchant to its own room', async () => {
      const client = socket({ merchantId: MERCHANT });

      await expect(gateway.subscribeToMerchant(client, { merchantId: MERCHANT })).resolves.toEqual({
        subscribed: `merchant:${MERCHANT}`,
      });
      expect(joined(client)).toEqual([`merchant:${MERCHANT}`]);
    });

    /** The scope comes from the token, never from the message. */
    it('refuses a merchant the token does not cover', async () => {
      const client = socket({ merchantId: MERCHANT });

      await expect(
        gateway.subscribeToMerchant(client, { merchantId: OTHER_MERCHANT }),
      ).rejects.toBeInstanceOf(WsException);
      expect(joined(client)).toHaveLength(0);
    });

    it('lets an administrator subscribe to any merchant', async () => {
      const client = socket({ permissions: ['admin:*'] });

      await expect(
        gateway.subscribeToMerchant(client, { merchantId: OTHER_MERCHANT }),
      ).resolves.toEqual({ subscribed: `merchant:${OTHER_MERCHANT}` });
    });

    /**
     * The case the suite was missing, and the reason the feature was
     * dead: a merchant owner signing in through the dashboard holds a
     * user token, and a user token carries no `merchantId`. Every one of
     * them was refused. The existing tests passed because they described
     * an API-key principal and an administrator — the two kinds of caller
     * that do not use a browser.
     */
    it('subscribes a merchant owner whose token carries no merchant claim', async () => {
      mayActFor.mockResolvedValue(true);
      const client = socket({ id: 'owner-1' });

      await expect(gateway.subscribeToMerchant(client, { merchantId: MERCHANT })).resolves.toEqual({
        subscribed: `merchant:${MERCHANT}`,
      });
      expect(mayActFor).toHaveBeenCalledWith(MERCHANT, 'owner-1');
    });

    it('refuses a user who does not own the merchant', async () => {
      mayActFor.mockResolvedValue(false);
      const client = socket({ id: 'stranger' });

      await expect(
        gateway.subscribeToMerchant(client, { merchantId: OTHER_MERCHANT }),
      ).rejects.toBeInstanceOf(WsException);
      expect(joined(client)).toHaveLength(0);
    });

    /** An API key already names its merchant; no lookup needed. */
    it('does not query the merchant context when the token names it', async () => {
      const client = socket({ merchantId: MERCHANT });

      await gateway.subscribeToMerchant(client, { merchantId: MERCHANT });

      expect(mayActFor).not.toHaveBeenCalled();
    });

    it('refuses an unauthenticated socket before looking at the frame', async () => {
      const client = socket(null);

      await expect(gateway.subscribeToMerchant(client, { merchantId: MERCHANT })).rejects.toThrow(
        'Not authenticated',
      );
    });
  });
});
