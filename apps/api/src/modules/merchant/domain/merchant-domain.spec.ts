import { describe, expect, it } from 'vitest';
import { Money } from '@payhub/kernel';
import { FeePolicy } from './fee-policy.vo.js';
import { Merchant, MerchantId, MerchantStatus } from './merchant.aggregate.js';
import { WebhookEndpoint } from './webhook-endpoint.vo.js';

const OWNER = '11111111-1111-4111-8111-111111111111';

describe('Merchant', () => {
  const onboard = () =>
    Merchant.onboard({ id: MerchantId.create(), ownerUserId: OWNER, name: '  Acme  ' });

  it('starts pending — onboarding is not activation', () => {
    const merchant = onboard();

    expect(merchant.status).toBe(MerchantStatus.Pending);
    expect(merchant.name).toBe('Acme');
    expect(merchant.assertCanAcceptPayments('USD').unwrapErr().code).toBe('MERCHANT_NOT_ACTIVE');
  });

  it('accepts payments once activated', () => {
    const merchant = onboard();

    expect(merchant.activate().isOk()).toBe(true);
    expect(merchant.assertCanAcceptPayments('USD').isOk()).toBe(true);
    expect(merchant.pullDomainEvents().map((event) => event.eventName)).toEqual([
      'identity.merchant_activated.v1',
    ]);
  });

  it('activating twice is a no-op, not an error', () => {
    const merchant = onboard();
    merchant.activate();
    merchant.pullDomainEvents();

    expect(merchant.activate().isOk()).toBe(true);
    expect(merchant.pullDomainEvents()).toHaveLength(0);
  });

  it('will not silently reinstate a suspended merchant', () => {
    const merchant = onboard();
    merchant.activate();
    merchant.suspend('chargeback rate');

    expect(merchant.activate().unwrapErr().code).toBe('MERCHANT_SUSPENDED');
    expect(merchant.assertCanAcceptPayments('USD').isErr()).toBe(true);
  });

  it('refuses a currency it does not support', () => {
    const merchant = onboard();
    merchant.activate();

    const rejected = merchant.assertCanAcceptPayments('JPY');

    expect(rejected.unwrapErr().code).toBe('CURRENCY_NOT_SUPPORTED');
    expect(rejected.unwrapErr().details['supported']).toEqual(['USD', 'EUR']);
  });

  it('carries a fee policy that can be replaced', () => {
    const merchant = onboard();

    expect(merchant.feePolicy.calculate(Money.fromMajor('100.00', 'USD')).toMajorString()).toBe(
      '3.20',
    );

    merchant.updateFeePolicy(FeePolicy.create({ basisPoints: 100 }).unwrap());

    expect(merchant.feePolicy.calculate(Money.fromMajor('100.00', 'USD')).toMajorString()).toBe(
      '1.00',
    );
  });
});

describe('WebhookEndpoint', () => {
  const secret = 'whsec_test';

  it('accepts an https endpoint', () => {
    const endpoint = WebhookEndpoint.create({ url: 'https://merchant.example/hooks', secret });

    expect(endpoint.isOk()).toBe(true);
    expect(endpoint.unwrap().active).toBe(true);
  });

  it('requires TLS unless explicitly allowed for local development', () => {
    expect(WebhookEndpoint.create({ url: 'http://merchant.example', secret }).isErr()).toBe(true);
    expect(
      WebhookEndpoint.create({ url: 'http://merchant.example', secret, allowInsecure: true }).isOk(),
    ).toBe(true);
  });

  /**
   * SSRF guard: the URL is attacker-controlled and our workers will fetch
   * it, so it must not be able to point at the cluster or the cloud
   * metadata endpoint.
   */
  it('refuses to point at anything internal', () => {
    const blocked = [
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://metadata.google.internal/',
      'https://10.0.0.5/hook',
      'https://192.168.1.10/hook',
      'https://172.16.5.4/hook',
      'https://payhub-api.payhub.local/hook',
      'https://db.internal/hook',
      // Regression: the guard matched a dotted-quad with a regular
      // expression, so every IPv6 literal walked straight past it.
      'https://[::1]/hook',
      'https://[fd00::1]/hook',
      'https://[fe80::1]/hook',
      'https://[::ffff:169.254.169.254]/hook',
      // Alternative spellings of 127.0.0.1, normalised by `URL`.
      'https://127.1/hook',
      'https://2130706433/hook',
      'https://0x7f000001/hook',
    ];

    for (const url of blocked) {
      expect(WebhookEndpoint.create({ url, secret }).isErr(), url).toBe(true);
    }
  });

  it('still allows a public address that merely looks numeric', () => {
    expect(WebhookEndpoint.create({ url: 'https://8.8.8.8/hook', secret }).isOk()).toBe(true);
    expect(WebhookEndpoint.create({ url: 'https://172.32.0.1/hook', secret }).isOk()).toBe(true);
    expect(
      WebhookEndpoint.create({ url: 'https://[2606:4700::1111]/hook', secret }).isOk(),
    ).toBe(true);
  });

  /**
   * What this check cannot do, stated so nobody mistakes it for complete:
   * it validates a string. `hooks.example.com` resolving to `10.0.0.1` is
   * accepted here and refused by the worker, which re-checks the resolved
   * address immediately before it connects.
   */
  it('accepts a public name whose address is only checked at delivery', () => {
    expect(WebhookEndpoint.create({ url: 'https://hooks.example.com/h', secret }).isOk()).toBe(
      true,
    );
  });

  it('rejects a malformed URL instead of throwing', () => {
    expect(WebhookEndpoint.create({ url: 'not a url', secret }).unwrapErr().code).toBe(
      'INVALID_WEBHOOK_URL',
    );
  });

  describe('subscriptions', () => {
    const endpoint = (events?: string[]) =>
      WebhookEndpoint.create({
        url: 'https://merchant.example/hook',
        secret,
        ...(events ? { subscribedEvents: events } : {}),
      }).unwrap();

    it('defaults to every event', () => {
      expect(endpoint().wantsEvent('payment.captured.v1')).toBe(true);
    });

    it('honours an explicit list', () => {
      const selective = endpoint(['payment.failed.v1']);

      expect(selective.wantsEvent('payment.failed.v1')).toBe(true);
      expect(selective.wantsEvent('payment.captured.v1')).toBe(false);
    });

    it('delivers nothing while inactive', () => {
      const inactive = WebhookEndpoint.of({
        url: 'https://merchant.example/hook',
        secret,
        subscribedEvents: ['*'],
        active: false,
      });

      expect(inactive.wantsEvent('payment.captured.v1')).toBe(false);
    });
  });
});
