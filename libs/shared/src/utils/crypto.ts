import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Stable fingerprint of a request body — used to detect idempotency-key reuse. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Merchant webhook signature, modelled on the Stripe scheme:
 * `t=<unix>,v1=<hex hmac of "t.payload">`.
 *
 * The timestamp is inside the signed material so a captured payload cannot be
 * replayed indefinitely, and the receiver can enforce a freshness window.
 */
export function signWebhook(payload: string, secret: string, timestampSec: number): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestampSec}.${payload}`, 'utf8')
    .digest('hex');

  return `t=${timestampSec},v1=${signature}`;
}

export function verifyWebhookSignature(
  header: string,
  payload: string,
  secret: string,
  options: { toleranceSec?: number; nowSec?: number } = {},
): boolean {
  const { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = options;

  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index), part.slice(index + 1)];
    }),
  );

  const timestamp = Number(parts['t']);
  const provided = parts['v1'];

  if (!Number.isFinite(timestamp) || !provided) {
    return false;
  }
  if (Math.abs(nowSec - timestamp) > toleranceSec) {
    return false;
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');

  return constantTimeEquals(expected, provided);
}

/** Comparison whose duration does not depend on where the first mismatch is. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  if (left.length !== right.length) {
    // Still burn a comparison so length is the only observable difference.
    timingSafeEqual(left, left);
    return false;
  }

  return timingSafeEqual(left, right);
}

/**
 * `ph_live_<32 bytes base64url>` — the prefix makes a leaked key greppable
 * in logs and recognisable by secret scanners.
 *
 * The prefix is returned explicitly rather than recovered from the string
 * later: base64url's alphabet includes `_`, so `plaintext.lastIndexOf('_')`
 * lands somewhere inside the secret and produces a 40-character "prefix".
 */
export function generateApiKey(environment: 'live' | 'test'): {
  plaintext: string;
  prefix: string;
  last4: string;
} {
  const secret = randomBytes(32).toString('base64url');
  const prefix = `ph_${environment}_`;

  return { plaintext: `${prefix}${secret}`, prefix, last4: secret.slice(-4) };
}

/** Peppered hash — the pepper lives in config, never in the database. */
export function hashApiKey(plaintext: string, pepper: string): string {
  return createHmac('sha256', pepper).update(plaintext, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);

  return `{${entries.join(',')}}`;
}
