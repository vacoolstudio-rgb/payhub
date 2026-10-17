import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { SpendingQueryDto, StreamQueryDto } from './assistant/presentation/assistant.controller.js';
import {
  ListPaymentsQueryDto,
  PaymentStatsQueryDto,
} from './payment/presentation/http/dto/payment.dto.js';
import { StatementQueryDto } from './wallet/presentation/dto/wallet.dto.js';

/**
 * The query DTOs, exercised the way the global `ValidationPipe` runs them.
 *
 * Every endpoint here used to take bare `@Query('x') x?: string`
 * parameters. The pipe only inspects parameters that have a DTO class, so
 * those were not validated at all — which is invisible in a controller
 * test that calls the method directly, and is exactly why these assertions
 * go through `plainToInstance` + `validateSync` instead.
 */
function check<T extends object>(Dto: new () => T, query: Record<string, unknown>) {
  const instance = plainToInstance(Dto, query, { enableImplicitConversion: false });
  const failed = validateSync(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return {
    instance,
    ok: failed.length === 0,
    fields: failed.map((error) => error.property),
  };
}

describe('query DTOs', () => {
  describe('StatementQueryDto', () => {
    /** Regression: `?limit=abc` became `Number('abc')` → `NaN` → SQL. */
    it('rejects a non-numeric limit instead of passing NaN down', () => {
      expect(check(StatementQueryDto, { limit: 'abc' })).toMatchObject({
        ok: false,
        fields: ['limit'],
      });
    });

    /**
     * Regression: one request could ask for the caller's entire statement
     * and decide how much memory the process used.
     */
    it('refuses a page larger than the ceiling', () => {
      expect(check(StatementQueryDto, { limit: '999999' }).ok).toBe(false);
    });

    /** Regression: `Math.min` bounds from above only; -5 reached `LIMIT`. */
    it('refuses a negative or zero page', () => {
      expect(check(StatementQueryDto, { limit: '-5' }).ok).toBe(false);
      expect(check(StatementQueryDto, { limit: '0' }).ok).toBe(false);
    });

    it('converts a valid numeric string to a number', () => {
      const { ok, instance } = check(StatementQueryDto, { limit: '25' });

      expect(ok).toBe(true);
      expect(instance.limit).toBe(25);
    });

    it('accepts an absent limit, leaving the default to the handler', () => {
      expect(check(StatementQueryDto, {}).ok).toBe(true);
    });

    it.each(['usd', 'US', 'TOOLONG', '123'])('rejects the currency %s', (currency) => {
      expect(check(StatementQueryDto, { currency }).ok).toBe(false);
    });

    it('accepts a well-formed currency', () => {
      expect(check(StatementQueryDto, { currency: 'USD' }).ok).toBe(true);
    });

    /** `whitelist` only strips what the DTO declares; unknown keys are a bug. */
    it('rejects a parameter it does not declare', () => {
      expect(check(StatementQueryDto, { limitt: '25' }).ok).toBe(false);
    });
  });

  describe('PaymentStatsQueryDto', () => {
    /**
     * Regression: `?from=garbage` produced an `Invalid Date`, which reached
     * the aggregate query and surfaced as a 500 — a client mistake
     * reported as a server fault.
     */
    it('rejects an unparseable date rather than letting it reach the query', () => {
      expect(check(PaymentStatsQueryDto, { from: 'garbage' })).toMatchObject({
        ok: false,
        fields: ['from'],
      });
    });

    it('accepts an ISO 8601 instant', () => {
      expect(check(PaymentStatsQueryDto, { from: '2026-01-01T00:00:00.000Z' }).ok).toBe(true);
    });

    it('accepts no parameters at all', () => {
      expect(check(PaymentStatsQueryDto, {}).ok).toBe(true);
    });
  });

  describe('ListPaymentsQueryDto', () => {
    /** It inherits the shared bound rather than redeclaring its own. */
    it('shares the page-size ceiling with every other listing', () => {
      expect(check(ListPaymentsQueryDto, { limit: '999999' }).ok).toBe(false);
      expect(check(ListPaymentsQueryDto, { limit: '100' }).ok).toBe(true);
    });

    it('rejects a status outside the enum', () => {
      expect(check(ListPaymentsQueryDto, { status: 'nonsense' })).toMatchObject({
        ok: false,
        fields: ['status'],
      });
    });

    it('rejects a merchantId that is not a uuid', () => {
      expect(check(ListPaymentsQueryDto, { merchantId: 'not-a-uuid' }).ok).toBe(false);
    });
  });

  describe('assistant', () => {
    /** Regression: `Math.min(Number(days) || 30, 365)` allowed `?days=-5`. */
    it('refuses a negative window', () => {
      expect(check(SpendingQueryDto, { days: '-5' }).ok).toBe(false);
    });

    it('refuses a window beyond a year', () => {
      expect(check(SpendingQueryDto, { days: '400' }).ok).toBe(false);
    });

    /**
     * Regression: the same question was validated over `POST /ask` and
     * silently truncated to 2 000 characters over SSE.
     */
    it('applies the same length bound as the POST variant', () => {
      expect(check(StreamQueryDto, { question: '' }).ok).toBe(false);
      expect(check(StreamQueryDto, { question: 'x'.repeat(2_001) }).ok).toBe(false);
      expect(check(StreamQueryDto, { question: 'where did my money go' }).ok).toBe(true);
    });

    it('requires the question to be present', () => {
      expect(check(StreamQueryDto, {})).toMatchObject({ ok: false, fields: ['question'] });
    });
  });
});
