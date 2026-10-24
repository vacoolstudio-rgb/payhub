import { Body, Controller, Get, Post, Query, Req, Res, Sse } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PrincipalQuota } from '@payhub/redis';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import {
  ApiStandardErrors,
  type AuthenticatedPrincipal,
  CurrentUser,
  RequestTimeout,
  RequirePermissions,
} from '@payhub/shared';
import { Permission } from '../../identity/domain/role.vo.js';
import { AssistantService, type SpendCategory } from '../application/assistant.service.js';
import { TokenBudgetService } from '../application/token-budget.service.js';

class HistoryTurnDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @Length(1, 4_000)
  content!: string;
}

export class AskDto {
  @ApiProperty({ example: 'How much did I spend on transport last month?' })
  @IsString()
  @Length(1, 2_000)
  question!: string;

  @ApiProperty({ type: [HistoryTurnDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HistoryTurnDto)
  history?: HistoryTurnDto[];
}

/**
 * The SSE variant of `AskDto`.
 *
 * The same question asked over `POST /ask` was validated and the one in
 * the query string was not — it was silently truncated to 2 000
 * characters deep inside the handler instead. One input, one rule.
 */
export class StreamQueryDto {
  @ApiProperty({ example: 'How much did I spend on transport last month?' })
  @IsString()
  @Length(1, 2_000)
  question!: string;
}

export class SpendingQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 365, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  // `Math.min(Number(days) || 30, 365)` bounded this from above only, so
  // `?days=-5` reached the query as a negative window.
  @Min(1)
  @Max(365)
  days?: number;
}

/**
 * Assistant endpoints.
 *
 * `/ask` is a normal JSON request for programmatic callers; `/stream` is
 * Server-Sent Events for the chat UI.
 *
 * SSE and not WebSocket here: the traffic is one-directional (the question
 * goes up once over POST, tokens come down), it rides plain HTTP so no proxy
 * needs to understand an Upgrade handshake, and `EventSource` reconnects on
 * its own. A WebSocket would add a protocol and a connection lifecycle for
 * no benefit.
 */
@ApiTags('assistant')
@Controller({ path: 'assistant', version: '1' })
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly budget: TokenBudgetService,
  ) {}

  @Post('ask')
  @RequirePermissions(Permission.AssistantUse)
  // Two limits, on two different axes, because they stop different
  // things. The throttle counts by address and runs before
  // authentication, which keeps an anonymous flood off the endpoint. The
  // quota counts by caller, which is the only axis that means anything
  // for a question that can now cost several model calls and several
  // database queries — one stolen token sourced from many addresses gets
  // a fresh allowance from the first and none from the second.
  @PrincipalQuota({ name: 'assistant-ask', capacity: 10, refillPerSecond: 0.1 })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Ask a question about your own transactions' })
  @ApiStandardErrors(429)
  async ask(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: AskDto,
  ): Promise<{ answer: string; cached: boolean; remainingTokens: number }> {
    return this.assistant.ask({
      userId: principal.id,
      question: dto.question,
      ...(dto.history ? { history: dto.history } : {}),
    });
  }

  /**
   * SSE stream.
   *
   * `@RequestTimeout(0)` opts this handler out of the global request budget:
   * a streaming response is *supposed* to stay open, and the interceptor
   * would otherwise kill it after 30 seconds.
   *
   * The question travels as a query parameter because `EventSource` cannot
   * send a body — hence the tight length limit and the read-only nature of
   * the endpoint.
   */
  @Sse('stream')
  @RequirePermissions(Permission.AssistantUse)
  // A stream holds a connection open for the whole agent loop, so it is
  // the more expensive of the two and gets the same allowance.
  @PrincipalQuota({ name: 'assistant-stream', capacity: 10, refillPerSecond: 0.1 })
  @RequestTimeout(0)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiProduces('text/event-stream')
  @ApiOperation({ summary: 'Stream an answer token by token' })
  stream(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: StreamQueryDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Observable<{ data: string; type?: string }> {
    // Buffering proxies are the usual reason an SSE stream "does not work":
    // nginx will happily hold the whole response until the handler ends.
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    response.setHeader('Connection', 'keep-alive');

    const controller = new AbortController();
    // A user who closes the tab must stop costing us tokens.
    request.on('close', () => controller.abort());

    return new Observable((subscriber) => {
      void (async () => {
        try {
          for await (const chunk of this.assistant.askStream({
            userId: principal.id,
            question: query.question,
            signal: controller.signal,
          })) {
            switch (chunk.type) {
              case 'text':
                subscriber.next({ type: 'token', data: JSON.stringify({ text: chunk.text }) });
                break;
              case 'done':
                subscriber.next({
                  type: 'done',
                  data: JSON.stringify({
                    usage: chunk.usage,
                    stopReason: chunk.stopReason,
                  }),
                });
                subscriber.complete();
                break;
              case 'error':
                subscriber.next({
                  type: 'error',
                  data: JSON.stringify({ message: chunk.message, retryable: chunk.retryable }),
                });
                subscriber.complete();
                break;
            }
          }
          subscriber.complete();
        } catch (error) {
          subscriber.next({
            type: 'error',
            data: JSON.stringify({
              message: error instanceof Error ? error.message : 'Assistant failed',
              retryable: false,
            }),
          });
          subscriber.complete();
        }
      })();

      return () => controller.abort();
    });
  }

  @Get('spending')
  @RequirePermissions(Permission.AssistantUse)
  // Categorisation falls back to the model for merchants the rule table
  // does not know, so it is not the free lookup its shape suggests.
  @PrincipalQuota({ name: 'assistant-spending', capacity: 20, refillPerSecond: 0.2 })
  @ApiOperation({ summary: 'Rule-based spend categorisation' })
  async spending(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: SpendingQueryDto,
  ): Promise<SpendCategory[]> {
    return this.assistant.categoriseSpending(principal.id, query.days ?? 30);
  }

  @Get('budget')
  @RequirePermissions(Permission.AssistantUse)
  @ApiOperation({ summary: 'Remaining daily token allowance' })
  async remainingBudget(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<{ remainingTokens: number }> {
    return { remainingTokens: await this.budget.remaining(principal.id) };
  }
}
