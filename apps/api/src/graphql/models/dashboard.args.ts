import { ArgsType, Field, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { IsCurrencyCode, MAX_PAGE_SIZE } from '@payhub/shared';
import type { PaymentStatus } from '../../modules/payment/domain/payment.aggregate.js';
import { PaymentStatusEnum } from './common.model.js';

/**
 * Declared arguments for the dashboard queries.
 *
 * Previously these were bare scalars clamped by hand inside each resolver
 * (`Math.min(limit, 100)`). Two problems with that: `Math.min` bounds a
 * value from above only, so `limit: -5` reached SQL as a negative `LIMIT`;
 * and the rule lived in the resolver body, where the schema cannot show
 * it and a reader cannot see it. Declaring the bounds puts GraphQL and
 * REST on the same validators and the same page-size ceiling.
 */
@ArgsType()
export class PaymentsArgs {
  @Field(() => Int, { nullable: true, defaultValue: 25 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  /**
   * Typed as the domain enum with no cast.
   *
   * It used to arrive as `String` and be asserted into `PaymentStatus` —
   * a claim the compiler accepted and nothing checked, so `status: "junk"`
   * silently returned an empty page. `PaymentStatusEnum` is registered in
   * the schema, so GraphQL rejects anything else before the resolver runs
   * and the type is simply true.
   */
  @Field(() => PaymentStatusEnum, { nullable: true })
  @IsOptional()
  status?: PaymentStatus;
}

@ArgsType()
export class PaymentStatsArgs {
  @Field({ defaultValue: 'USD' })
  @IsString()
  @IsCurrencyCode()
  currency!: string;

  @Field(() => Int, { defaultValue: 30 })
  @IsInt()
  @Min(1)
  @Max(365)
  days!: number;
}

@ArgsType()
export class StatementArgs {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsCurrencyCode()
  currency?: string;

  @Field(() => Int, { nullable: true, defaultValue: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}
