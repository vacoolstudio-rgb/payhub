import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service.js';

export interface TokenBucketOptions {
  /** Maximum tokens the bucket can hold — the burst size. */
  readonly capacity: number;
  /** Tokens added per second. */
  readonly refillPerSecond: number;
  /** Tokens this call wants to spend. */
  readonly cost?: number;
}

export interface TokenBucketResult {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Milliseconds until `cost` tokens are available again. */
  readonly retryAfterMs: number;
}

/**
 * Token bucket, evaluated atomically inside Redis.
 *
 * Doing the read-modify-write in Lua matters: with a plain GET/SET pair, two
 * concurrent requests both read the same balance and both spend it. Lua runs
 * as a single unit on the single-threaded server, so the arithmetic is
 * serialised without any locking.
 *
 * Chosen over a fixed window because a bucket smooths bursts (an LLM user may
 * fire three questions in a second and then idle) and over a sliding log
 * because it stores two numbers instead of one entry per request.
 */
const TOKEN_BUCKET_SCRIPT = `
local key        = KEYS[1]
local capacity   = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local cost       = tonumber(ARGV[3])
local nowMs      = tonumber(ARGV[4])

local state   = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens  = tonumber(state[1])
local updated = tonumber(state[2])

if tokens == nil then
  tokens = capacity
  updated = nowMs
end

-- Refill for the time that passed since the last call.
local elapsedSec = math.max(0, (nowMs - updated) / 1000)
tokens = math.min(capacity, tokens + elapsedSec * refillRate)

local allowed = 0
local retryAfterMs = 0

if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  retryAfterMs = math.ceil(((cost - tokens) / refillRate) * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'updatedAt', nowMs)
-- Expire an idle bucket once it would be full again; a fresh bucket starts
-- full anyway, so dropping it loses no information and bounds memory growth.
redis.call('PEXPIRE', key, math.ceil((capacity / refillRate) * 1000) + 1000)

return { allowed, math.floor(tokens), retryAfterMs }
`;

@Injectable()
export class TokenBucketService {
  constructor(private readonly redis: RedisService) {}

  async consume(bucket: string, options: TokenBucketOptions): Promise<TokenBucketResult> {
    const cost = options.cost ?? 1;

    const [allowed, remaining, retryAfterMs] = (await this.redis.client.eval(
      TOKEN_BUCKET_SCRIPT,
      1,
      `tb:${bucket}`,
      options.capacity.toString(),
      options.refillPerSecond.toString(),
      cost.toString(),
      Date.now().toString(),
    )) as [number, number, number];

    return { allowed: allowed === 1, remaining, retryAfterMs };
  }

  /** Current balance without spending anything (for `X-RateLimit-*` headers). */
  async peek(bucket: string, options: TokenBucketOptions): Promise<number> {
    const result = await this.consume(bucket, { ...options, cost: 0 });
    return result.remaining;
  }
}
