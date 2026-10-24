import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { IsMetadata, METADATA_LIMITS } from './is-metadata.decorator.js';

class Carrier {
  @IsMetadata()
  metadata?: unknown;
}

async function check(value: unknown): Promise<string | null> {
  const carrier = new Carrier();
  carrier.metadata = value;

  const errors = await validate(carrier);
  return errors.length === 0 ? null : Object.values(errors[0]!.constraints ?? {})[0] ?? 'invalid';
}

/**
 * What a caller may attach to a payment.
 *
 * This was `@IsObject()`, which validates almost nothing: the field is
 * typed `Record<string, string>` and the runtime took nested objects,
 * arrays, numbers, any number of keys, and as many bytes as the request
 * body allowed. It lands in a jsonb column on every payment row, so the
 * body limit was the real bound on how much storage one caller could
 * attach to one payment — 50 kB went in and persisted.
 */
describe('IsMetadata', () => {
  it('accepts the shape the field is for', async () => {
    await expect(check({ orderId: '10294', channel: 'web' })).resolves.toBeNull();
  });

  it('accepts an empty bag', async () => {
    await expect(check({})).resolves.toBeNull();
  });

  it('refuses more keys than the limit', async () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: METADATA_LIMITS.maxKeys + 1 }, (_, i) => [`k${i}`, 'v']),
    );

    await expect(check(tooMany)).resolves.toMatch(/more than 50 keys/);
  });

  it('accepts exactly the limit', async () => {
    const atLimit = Object.fromEntries(
      Array.from({ length: METADATA_LIMITS.maxKeys }, (_, i) => [`k${i}`, 'v']),
    );

    await expect(check(atLimit)).resolves.toBeNull();
  });

  it('refuses a value longer than the limit', async () => {
    await expect(check({ note: 'x'.repeat(METADATA_LIMITS.maxValueLength + 1) })).resolves.toMatch(
      /longer than 500/,
    );
  });

  it('refuses a key longer than the limit', async () => {
    await expect(check({ ['k'.repeat(41)]: 'v' })).resolves.toMatch(/keys may not be longer/);
  });

  /** The type said `Record<string, string>`; the runtime did not. */
  it('refuses a nested object', async () => {
    await expect(check({ nested: { a: 1 } })).resolves.toMatch(/must be strings/);
  });

  it('refuses a number where a string belongs', async () => {
    await expect(check({ count: 3 })).resolves.toMatch(/must be strings/);
  });

  it('refuses an array', async () => {
    await expect(check(['a', 'b'])).resolves.toMatch(/object of string values/);
  });

  it('refuses a bare string', async () => {
    await expect(check('orderId=10294')).resolves.toMatch(/object of string values/);
  });

  /**
   * The size that mattered: one key, far under the key limit, holding
   * fifty kilobytes. Only the value bound catches this.
   */
  it('refuses the fifty kilobytes that used to be accepted', async () => {
    await expect(check({ pad: 'A'.repeat(50 * 1024) })).resolves.toMatch(/longer than 500/);
  });
});
