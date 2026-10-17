import { Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface.js';
import { RedisService } from './redis.service.js';

/**
 * Sliding-window counter with a block phase, evaluated atomically in Lua.
 *
 * Why not the in-memory storage @nestjs/throttler ships with: it counts per
 * *process*. Behind three replicas a "100 requests/minute" limit silently
 * becomes 300, and a rolling deploy resets everyone's counters. The limit has
 * to live where all replicas can see it.
 *
 * Why a sliding window and not a fixed one: a fixed window lets a client send
 * `limit` requests at 11:59:59 and `limit` more at 12:00:00 — double the
 * intended rate at the boundary. Here every hit is a sorted-set member scored
 * by timestamp, and expired members are trimmed on each call.
 */
const SLIDING_WINDOW_SCRIPT = `
local hitsKey   = KEYS[1]
local blockKey  = KEYS[2]
local nowMs     = tonumber(ARGV[1])
local ttlMs     = tonumber(ARGV[2])
local limit     = tonumber(ARGV[3])
local blockMs   = tonumber(ARGV[4])
local member    = ARGV[5]

local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  local hits = redis.call('ZCARD', hitsKey)
  return { hits, redis.call('PTTL', hitsKey), 1, blockTtl }
end

-- Drop everything that fell out of the window.
redis.call('ZREMRANGEBYSCORE', hitsKey, 0, nowMs - ttlMs)
redis.call('ZADD', hitsKey, nowMs, member)
redis.call('PEXPIRE', hitsKey, ttlMs)

local totalHits = redis.call('ZCARD', hitsKey)
local isBlocked = 0
local timeToBlockExpire = 0

if totalHits > limit then
  isBlocked = 1
  if blockMs > 0 then
    redis.call('SET', blockKey, 1, 'PX', blockMs)
    timeToBlockExpire = blockMs
  end
end

return { totalHits, redis.call('PTTL', hitsKey), isBlocked, timeToBlockExpire }
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private counter = 0;

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    this.counter = (this.counter + 1) % Number.MAX_SAFE_INTEGER;
    const member = `${now}-${process.pid}-${this.counter}`;

    const [totalHits, ttlMs, isBlocked, timeToBlockExpire] = (await this.redis.client.eval(
      SLIDING_WINDOW_SCRIPT,
      2,
      `throttle:${throttlerName}:${key}`,
      `throttle:${throttlerName}:${key}:blocked`,
      now.toString(),
      ttl.toString(),
      limit.toString(),
      blockDuration.toString(),
      member,
    )) as [number, number, number, number];

    return {
      totalHits,
      timeToExpire: Math.ceil(Math.max(0, ttlMs) / 1000),
      isBlocked: isBlocked === 1,
      timeToBlockExpire: Math.ceil(Math.max(0, timeToBlockExpire) / 1000),
    };
  }
}
