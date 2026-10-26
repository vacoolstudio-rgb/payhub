import { Inject, Injectable, Logger } from '@nestjs/common';
import { type LlmConfig, llmConfig } from '@payhub/config';
import { RateLimitedError } from '@payhub/kernel';
import { RedisService, TokenBucketService } from '@payhub/redis';
import { MetricsService } from '@payhub/observability';
import type { LlmUsage } from '../domain/llm.port.js';

/**
 * Per-model price list in micro-dollars per token (USD × 10⁻⁶).
 *
 * Integers, like every other money value in this code base. Cache reads are
 * ~0.1× the input price and cache writes ~1.25×, which is exactly why the
 * system prompt is marked cacheable: a long financial context costs a tenth
 * on every follow-up question in the same conversation.
 */
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const DEFAULT_PRICING = PRICING['claude-opus-5']!;

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly remainingTokens: number;
  readonly retryAfterMs: number;
  readonly reason?: 'rate_limited' | 'budget_exhausted';
}

/**
 * Two independent controls on LLM spend.
 *
 * **Rate** — a token bucket per user caps requests per minute while still
 * allowing a short burst, because a person asking three quick questions is
 * normal and a script asking three hundred is not.
 *
 * **Budget** — a rolling daily token allowance per user. Rate limiting alone
 * does not bound cost: ten requests a minute with 100k-token contexts is a
 * very expensive day. The budget is what actually protects the bill.
 *
 * Both live in Redis so they hold across replicas, and both are checked
 * *before* the call and reconciled *after* it with the real usage the
 * provider reports.
 */
@Injectable()
export class TokenBudgetService {
  private readonly logger = new Logger(TokenBudgetService.name);

  constructor(
    private readonly buckets: TokenBucketService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    @Inject(llmConfig.KEY) private readonly config: LlmConfig,
  ) {}

  /**
   * Pre-flight check. `estimatedTokens` comes from the provider's own
   * `count_tokens`, so a request that cannot possibly fit in the remaining
   * budget is refused before it costs anything.
   */
  async authorize(userId: string, estimatedTokens: number): Promise<BudgetDecision> {
    const rate = await this.buckets.consume(`llm:${userId}`, {
      capacity: Math.max(this.config.userRpm, 1),
      refillPerSecond: this.config.userRpm / 60,
      cost: 1,
    });

    if (!rate.allowed) {
      return {
        allowed: false,
        remainingTokens: await this.remaining(userId),
        retryAfterMs: rate.retryAfterMs,
        reason: 'rate_limited',
      };
    }

    // Reserved, not merely read.
    //
    // This used to be a read of `remaining` compared against the
    // estimate, which is a check-then-act across two round trips: two
    // concurrent questions both see the same remaining budget, both
    // decide they fit, and both run. The rate limiter above caps how
    // badly that can go, so the budget was soft rather than absent —
    // and the agent loop made each request worth up to five billed
    // calls instead of one, which is a different size of soft.
    //
    // So the estimate is charged up front and the real usage reconciled
    // in `record`, the same hold-then-settle shape the wallet uses for
    // a pending payment. A crash between the two leaves the reservation
    // standing until the key expires at midnight: the budget is a cost
    // control, and failing towards "spent" is the safe direction.
    const reserved = await this.charge(userId, estimatedTokens);
    const remaining = Math.max(0, this.config.userDailyTokenBudget - reserved);

    if (reserved > this.config.userDailyTokenBudget) {
      // Over budget. Give the reservation back — the request will not
      // run, so it must not count against the day.
      await this.charge(userId, -estimatedTokens);
      return {
        allowed: false,
        remainingTokens: Math.max(0, this.config.userDailyTokenBudget - (reserved - estimatedTokens)),
        retryAfterMs: this.msUntilMidnightUtc(),
        reason: 'budget_exhausted',
      };
    }

    // Accumulated, not replaced. The agent loop authorises once per
    // iteration and settles once at the end, so a reservation that
    // overwrote the previous one would release every hold but the last.
    const key = reservationKey(userId);
    this.reservations.set(key, (this.reservations.get(key) ?? 0) + estimatedTokens);

    return { allowed: true, remainingTokens: remaining, retryAfterMs: 0 };
  }

  /** Throwing variant for call sites that do not branch on the decision. */
  async authorizeOrThrow(userId: string, estimatedTokens: number): Promise<void> {
    const decision = await this.authorize(userId, estimatedTokens);

    if (!decision.allowed) {
      throw new RateLimitedError(
        decision.reason === 'budget_exhausted'
          ? 'Daily assistant token budget exhausted'
          : 'Too many assistant requests — slow down',
        decision.retryAfterMs,
        { remainingTokens: decision.remainingTokens, reason: decision.reason },
      );
    }
  }

  /**
   * Post-flight accounting with the *actual* usage.
   *
   * Charging the estimate would be wrong in both directions: output tokens
   * are unknown up front, and a cache hit makes the input far cheaper than
   * the count suggests.
   */
  async record(userId: string, model: string, usage: LlmUsage): Promise<void> {
    const billable = usage.inputTokens + usage.outputTokens;

    // Settle against what was held. The estimate counted input only and
    // the bill includes output, so this is usually a top-up rather than
    // a refund — either way the day's counter ends on the real number.
    const held = this.reservations.get(reservationKey(userId)) ?? 0;
    this.reservations.delete(reservationKey(userId));

    await this.charge(userId, billable - held);

    const pricing = PRICING[model] ?? DEFAULT_PRICING;
    const microUsd =
      usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheReadTokens * pricing.cacheRead +
      usage.cacheWriteTokens * pricing.cacheWrite;

    this.metrics.llmTokens.inc({ model, kind: 'input' }, usage.inputTokens);
    this.metrics.llmTokens.inc({ model, kind: 'output' }, usage.outputTokens);
    this.metrics.llmTokens.inc({ model, kind: 'cache_read' }, usage.cacheReadTokens);
    this.metrics.llmCostMicroUsd.inc({ model }, Math.round(microUsd));

    this.logger.debug(
      `user=${userId} model=${model} in=${usage.inputTokens} out=${usage.outputTokens} ` +
        `cached=${usage.cacheReadTokens} cost=$${(microUsd / 1_000_000).toFixed(6)}`,
    );
  }

  /**
   * Returns whatever this process is still holding for a user.
   *
   * A hold is taken before each billed request and settled by
   * `record` when the usage comes back. If the request fails there is
   * no usage and nothing settles it, so the estimate stays charged for
   * the rest of the day — a provider outage would spend a user's whole
   * allowance on answers they never got, and the agent loop makes that
   * worse by holding once per iteration.
   *
   * Idempotent: `record` drains the hold, so calling this afterwards
   * finds nothing and refunds nothing.
   */
  async releaseHeld(userId: string): Promise<void> {
    const key = reservationKey(userId);
    const held = this.reservations.get(key) ?? 0;

    if (held === 0) {
      return;
    }

    this.reservations.delete(key);
    await this.charge(userId, -held);
  }

  /**
   * One round trip that both moves the counter and reports it, so no
   * two callers can act on the same reading.
   */
  private async charge(userId: string, tokens: number): Promise<number> {
    const key = this.budgetKey(userId);
    const total = await this.redis.client.incrby(key, tokens);

    if (total === tokens) {
      // First write of the day — set the TTL so the counter self-resets.
      await this.redis.client.expire(key, Math.ceil(this.msUntilMidnightUtc() / 1000));
    }

    return total;
  }

  async remaining(userId: string): Promise<number> {
    const spent = Number((await this.redis.client.get(this.budgetKey(userId))) ?? '0');
    return Math.max(0, this.config.userDailyTokenBudget - spent);
  }

  /**
   * What this process is holding for in-flight requests, per user.
   *
   * Per process because a hold belongs to the request that took it and
   * that request lives here; another replica settling it would be
   * settling someone else's.
   *
   * Two concurrent questions from one user share an entry, and the
   * first to settle releases both holds. The total charged is still
   * exactly what was billed — each settlement adds its own usage — so
   * the error is a brief window where the second question is less
   * protected, not a wrong number at the end. Worth naming rather than
   * threading a reservation id through the whole call chain for a cost
   * control that already has a rate limiter in front of it.
   */
  private readonly reservations = new Map<string, number>();

  private budgetKey(userId: string): string {
    // UTC day bucket so the key rolls over predictably regardless of where
    // the replica runs.
    return `llm:budget:${userId}:${new Date().toISOString().slice(0, 10)}`;
  }

  private msUntilMidnightUtc(): number {
    const now = new Date();
    const midnight = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    );
    return midnight - now.getTime();
  }
}

function reservationKey(userId: string): string {
  return `${userId}:${new Date().toISOString().slice(0, 10)}`;
}
