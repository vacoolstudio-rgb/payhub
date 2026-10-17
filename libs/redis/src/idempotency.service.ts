import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError } from '@payhub/kernel';
import { type ResilienceConfig, resilienceConfig } from '@payhub/config';
import { RedisService } from './redis.service.js';

export type IdempotencyState =
  /** First time we see this key — the caller must do the work. */
  | { status: 'fresh' }
  /** A request with the same key is in flight right now. */
  | { status: 'in_progress' }
  /** We already answered this key; replay the stored response. */
  | { status: 'completed'; statusCode: number; body: unknown };

export interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly statusCode: number;
  readonly body: unknown;
  readonly completedAt: string;
}

/**
 * Begin a request atomically: either claim the key (SET NX) or report what
 * the previous holder is doing. Returning the stored payload from the same
 * round-trip avoids a read-then-write race.
 */
const BEGIN_SCRIPT = `
local stored = redis.call('get', KEYS[1])
if stored then
  return stored
end
redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2])
return nil
`;

const IN_PROGRESS = 'in_progress';

/**
 * Idempotency keys for mutating HTTP endpoints.
 *
 * Contract (same as Stripe's):
 *   • a retry with the same key and the same body replays the first response;
 *   • the same key with a *different* body is a client bug and gets 409;
 *   • a retry while the original is still running gets 409 "in progress",
 *     because returning a half-finished state would be worse than asking the
 *     client to come back.
 *
 * The record lives in Redis rather than Postgres: it is cache-shaped data
 * with a natural TTL, and keeping it out of the transactional store means a
 * duplicate POST never takes a row lock on the payments table.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(resilienceConfig.KEY) private readonly config: ResilienceConfig,
  ) {}

  /** Scope the key by principal and route so two tenants cannot collide. */
  buildKey(parts: { principalId: string; route: string; key: string }): string {
    return `idem:${parts.principalId}:${parts.route}:${parts.key}`;
  }

  async begin(key: string, fingerprint: string): Promise<IdempotencyState> {
    const stored = (await this.redis.client.eval(
      BEGIN_SCRIPT,
      1,
      key,
      IN_PROGRESS,
      this.config.idempotencyLockTtlMs.toString(),
    )) as string | null;

    if (stored === null) {
      return { status: 'fresh' };
    }

    if (stored === IN_PROGRESS) {
      return { status: 'in_progress' };
    }

    const record = JSON.parse(stored) as IdempotencyRecord;

    if (record.fingerprint !== fingerprint) {
      throw new ConflictError(
        'This idempotency key was already used with a different request body',
        'IDEMPOTENCY_KEY_REUSED',
        { key },
      );
    }

    return { status: 'completed', statusCode: record.statusCode, body: record.body };
  }

  async complete(
    key: string,
    record: Omit<IdempotencyRecord, 'completedAt'>,
  ): Promise<void> {
    await this.redis.client.set(
      key,
      JSON.stringify({ ...record, completedAt: new Date().toISOString() }),
      'EX',
      this.config.idempotencyTtlSec,
    );
  }

  /**
   * Releases the in-progress marker after a failure so the client can retry
   * immediately. Failures are deliberately *not* cached: a 500 caused by a
   * transient outage must not be replayed for 24 hours.
   */
  async abandon(key: string): Promise<void> {
    const current = await this.redis.client.get(key);
    if (current === IN_PROGRESS) {
      await this.redis.client.del(key);
      this.logger.debug(`Released idempotency key after failure: ${key}`);
    }
  }
}
