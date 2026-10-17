import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  fingerprint,
  generateApiKey,
  hashApiKey,
  sha256,
  signWebhook,
  verifyWebhookSignature,
} from './crypto.js';

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const payload = JSON.stringify({ id: 'evt_1', type: 'payment.captured.v1' });
  const nowSec = 1_800_000_000;

  it('verifies a signature it produced', () => {
    const header = signWebhook(payload, secret, nowSec);

    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(header, payload, secret, { nowSec })).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const header = signWebhook(payload, secret, nowSec);

    expect(
      verifyWebhookSignature(header, payload.replace('captured', 'refunded'), secret, { nowSec }),
    ).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const header = signWebhook(payload, secret, nowSec);

    expect(verifyWebhookSignature(header, payload, 'whsec_other', { nowSec })).toBe(false);
  });

  /**
   * The timestamp is inside the signed material precisely so a captured
   * request cannot be replayed forever.
   */
  it('rejects a replay outside the tolerance window', () => {
    const header = signWebhook(payload, secret, nowSec);

    expect(verifyWebhookSignature(header, payload, secret, { nowSec: nowSec + 299 })).toBe(true);
    expect(verifyWebhookSignature(header, payload, secret, { nowSec: nowSec + 301 })).toBe(false);
    // Also guards against a clock running backwards on the sender.
    expect(verifyWebhookSignature(header, payload, secret, { nowSec: nowSec - 301 })).toBe(false);
  });

  it('cannot be fooled by moving the timestamp', () => {
    const header = signWebhook(payload, secret, nowSec);
    const forged = header.replace(`t=${nowSec}`, `t=${nowSec + 1_000}`);

    expect(verifyWebhookSignature(forged, payload, secret, { nowSec: nowSec + 1_000 })).toBe(false);
  });

  it('rejects malformed headers instead of throwing', () => {
    for (const header of ['', 'garbage', 't=abc,v1=x', `t=${nowSec}`, 'v1=deadbeef']) {
      expect(verifyWebhookSignature(header, payload, secret, { nowSec })).toBe(false);
    }
  });
});

describe('constantTimeEquals', () => {
  it('compares correctly', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });

  it('handles different lengths without throwing', () => {
    expect(constantTimeEquals('a', 'abcdef')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});

describe('fingerprint', () => {
  /** Idempotency compares bodies by fingerprint, so key order must not matter. */
  it('is stable across key order', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });

  it('changes when a value changes', () => {
    expect(fingerprint({ amount: '10.00' })).not.toBe(fingerprint({ amount: '10.01' }));
  });

  it('ignores explicit undefined, which JSON would drop anyway', () => {
    expect(fingerprint({ a: 1, b: undefined })).toBe(fingerprint({ a: 1 }));
  });

  it('distinguishes nesting from flattening', () => {
    expect(fingerprint({ a: { b: 1 } })).not.toBe(fingerprint({ 'a.b': 1 }));
  });

  it('handles arrays and primitives', () => {
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
    expect(fingerprint(null)).toBe(fingerprint(null));
  });
});

describe('API keys', () => {
  it('produces a greppable prefix and a stable mask', () => {
    const { plaintext, prefix, last4 } = generateApiKey('live');

    expect(prefix).toBe('ph_live_');
    expect(plaintext.startsWith(prefix)).toBe(true);
    expect(plaintext.endsWith(last4)).toBe(true);
  });

  /**
   * Regression: base64url contains `_`, so recovering the prefix with
   * `lastIndexOf('_')` produced a 40-character string that overflowed the
   * `varchar(16)` column.
   */
  it('keeps the prefix short even when the secret contains underscores', () => {
    for (let i = 0; i < 50; i += 1) {
      const { prefix } = generateApiKey('test');
      expect(prefix.length).toBeLessThanOrEqual(16);
    }
  });

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey('test').plaintext));

    expect(keys.size).toBe(200);
  });

  it('hashes with a pepper, so the same key hashes differently per deployment', () => {
    const { plaintext } = generateApiKey('test');

    expect(hashApiKey(plaintext, 'pepper-a')).not.toBe(hashApiKey(plaintext, 'pepper-b'));
    expect(hashApiKey(plaintext, 'pepper-a')).toBe(hashApiKey(plaintext, 'pepper-a'));
    expect(hashApiKey(plaintext, 'pepper-a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sha256 is hex and stable', () => {
    expect(sha256('payhub')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256('payhub')).toBe(sha256('payhub'));
  });
});
