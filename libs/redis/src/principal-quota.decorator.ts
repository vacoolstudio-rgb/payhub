import { SetMetadata } from '@nestjs/common';

export const PRINCIPAL_QUOTA_METADATA = 'payhub:principal-quota';

export interface PrincipalQuotaOptions {
  /** Burst: how many calls can arrive at once before the refill matters. */
  readonly capacity: number;
  /** Sustained rate, in calls per second. */
  readonly refillPerSecond: number;
  /** Distinguishes buckets when one caller has several quotas. */
  readonly name?: string;
}

/**
 * A per-caller quota, enforced after authentication.
 *
 * The global throttle counts by address, and deliberately so: it runs
 * before the auth guard precisely to keep an unauthenticated flood away
 * from argon2 and the database. That makes it a flood guard, not a fair
 * use policy — and for an API whose main clients are merchant servers
 * holding keys, the address is the wrong axis. It gives a thousand
 * browser users behind one office NAT the same allowance as a single
 * integration, and gives an attacker with a stolen key a fresh allowance
 * per address they can source from.
 *
 * This is the second layer: applied where the caller is known, keyed on
 * the caller, sized for what that caller is doing. A token bucket rather
 * than a fixed window, so a merchant can burst through a batch without
 * being punished for the shape of their traffic.
 *
 * ```ts
 * @PrincipalQuota({ capacity: 60, refillPerSecond: 1 })
 * @Post()
 * create() { … }
 * ```
 */
export const PrincipalQuota = (options: PrincipalQuotaOptions) =>
  SetMetadata(PRINCIPAL_QUOTA_METADATA, options);
