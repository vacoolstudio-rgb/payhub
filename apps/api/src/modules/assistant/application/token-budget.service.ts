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

    const remaining = await this.remaining(userId);

    if (remaining < estimatedTokens) {
      return {
        allowed: false,
        remainingTokens: remaining,
        retryAfterMs: this.msUntilMidnightUtc(),
        reason: 'budget_exhausted',
      };
    }

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
    const key = this.budgetKey(userId);

    const spent = await this.redis.client.incrby(key, billable);
    if (spent === billable) {
      // First write of the day — set the TTL so the counter self-resets.
      await this.redis.client.expire(key, Math.ceil(this.msUntilMidnightUtc() / 1000));
    }

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

  async remaining(userId: string): Promise<number> {
    const spent = Number((await this.redis.client.get(this.budgetKey(userId))) ?? '0');
    return Math.max(0, this.config.userDailyTokenBudget - spent);
  }

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
