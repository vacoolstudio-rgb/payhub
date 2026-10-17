import { describe, expect, it } from 'vitest';
import { classifyHost, isPrivateHost } from './network.js';

/**
 * The SSRF guard for merchant-supplied webhook URLs.
 *
 * The destination is attacker-chosen and our workers run inside the
 * network, so every one of these is a real address somebody would try.
 */
describe('isPrivateHost', () => {
  describe('IPv4', () => {
    it.each([
      ['loopback', '127.0.0.1'],
      ['RFC 1918 /8', '10.0.0.5'],
      ['RFC 1918 /12', '172.16.0.1'],
      ['RFC 1918 /16', '192.168.1.1'],
      ['cloud metadata', '169.254.169.254'],
      ['carrier NAT', '100.64.0.1'],
      ['this network', '0.0.0.0'],
      ['multicast', '239.0.0.1'],
    ])('blocks %s', (_label, host) => {
      expect(isPrivateHost(host)).toBe(true);
    });

    it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.167.1.1'])(
      'allows the public address %s',
      (host) => {
        expect(isPrivateHost(host)).toBe(false);
      },
    );

    /**
     * The input contract is a hostname as `URL` produces it. Short,
     * decimal and hexadecimal spellings of an address — `127.1`,
     * `2130706433`, `0x7f000001` — are normalised there, which is why
     * this function only has to understand the canonical form. The
     * webhook value object's own tests cover that end of it.
     */
    it('expects the canonical form a parsed URL yields', () => {
      expect(new URL('https://127.1/hook').hostname).toBe('127.0.0.1');
      expect(isPrivateHost(new URL('https://127.1/hook').hostname)).toBe(true);
      expect(isPrivateHost(new URL('https://0x7f000001/hook').hostname)).toBe(true);
    });
  });

  /**
   * Regression: the guard matched a dotted-quad with a regular expression,
   * so every IPv6 literal fell through it. `https://[::1]/` and
   * `https://[fd00::1]/` were both accepted as public.
   */
  describe('IPv6', () => {
    it.each([
      ['loopback', '::1'],
      ['loopback, in URL brackets', '[::1]'],
      ['unspecified', '::'],
      ['unique local fd00::/8', 'fd00::1'],
      ['unique local fc00::/7', 'fc00::abcd'],
      ['link-local', 'fe80::1'],
      ['link-local, upper case', 'FE80::1'],
      ['IPv4-mapped loopback', '::ffff:7f00:1'],
      ['IPv4-mapped metadata', '::ffff:a9fe:a9fe'],
      ['NAT64-wrapped RFC 1918', '64:ff9b::a00:1'],
      ['fully expanded loopback', '0:0:0:0:0:0:0:1'],
    ])('blocks %s', (_label, host) => {
      expect(isPrivateHost(host)).toBe(true);
    });

    it.each(['2606:4700:4700::1111', '[2001:4860:4860::8888]', '::ffff:8.8.8.8'])(
      'allows the public address %s',
      (host) => {
        expect(isPrivateHost(host)).toBe(false);
      },
    );
  });

  describe('names', () => {
    it.each(['localhost', 'api.localhost', 'printer.local', 'metadata.google.internal'])(
      'blocks %s',
      (host) => {
        expect(isPrivateHost(host)).toBe(true);
      },
    );

    it('allows an ordinary public name', () => {
      expect(isPrivateHost('hooks.example.com')).toBe(false);
    });
  });
});

describe('classifyHost', () => {
  /**
   * The check that turns the stored rule into an enforced one: a name
   * validated when it was saved can point somewhere else by the time the
   * delivery runs.
   */
  it('follows a name to the address behind it', async () => {
    // `localhost` is the one name guaranteed to resolve inward.
    await expect(classifyHost('localhost')).resolves.toBe('private');
  });

  it('answers for a literal without a lookup', async () => {
    await expect(classifyHost('[fd00::1]')).resolves.toBe('private');
    await expect(classifyHost('8.8.8.8')).resolves.toBe('public');
  });

  /**
   * "Could not resolve" is deliberately its own answer. Folding it into
   * `private` would turn a thirty-second resolver blip into a permanent
   * block on deliveries that a retry would have completed — a worse
   * outcome than the SSRF this guards against.
   */
  it('separates a name that does not resolve from one that is unsafe', async () => {
    await expect(classifyHost('this-name-does-not-exist.invalid')).resolves.toBe('unresolved');
  });
});
