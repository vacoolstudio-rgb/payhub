import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { CursorPageQueryDto, IsCurrencyCode } from '@payhub/shared';
import { PaymentDirection, PaymentStatus } from '../../../domain/payment.aggregate.js';

export class CreatePaymentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  merchantId!: string;

  @ApiProperty({ enum: PaymentDirection, example: PaymentDirection.Deposit })
  @IsEnum(PaymentDirection)
  direction!: PaymentDirection;

  /**
   * Decimal string, never a number.
   *
   * `19.99` as a JSON number is 19.989999999999998 after a round trip
   * through IEEE-754. A string reaches the server exactly as the client
   * wrote it and is parsed into integer minor units.
   */
  @ApiProperty({ example: '19.99', description: 'Decimal string in major units' })
  @IsString()
  @Matches(/^\d+([.,]\d{1,8})?$/, { message: 'amount must be a positive decimal string' })
  amount!: string;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @MaxLength(4)
  currency!: string;

  @ApiProperty({ example: 'card', description: 'Selects the provider strategy' })
  @IsString()
  @MaxLength(32)
  method!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required for an internal transfer' })
  @IsOptional()
  @IsUUID('4')
  counterpartyUserId?: string;

  @ApiPropertyOptional({ example: 'order-10294' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reference?: string;

  @ApiPropertyOptional({ type: Object, example: { orderId: '10294' } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;
}

export class RefundPaymentDto {
  @ApiPropertyOptional({
    example: '5.00',
    description: 'Omit to refund the full remaining amount',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+([.,]\d{1,8})?$/)
  amount?: string;

  @ApiProperty({ example: 'customer_request' })
  @IsString()
  @MaxLength(255)
  reason!: string;
}

export class ListPaymentsQueryDto extends CursorPageQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ enum: PaymentDirection })
  @IsOptional()
  @IsEnum(PaymentDirection)
  direction?: PaymentDirection;

  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @IsString()
  @IsCurrencyCode()
  currency?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  merchantId?: string;

  @ApiPropertyOptional({ example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-02-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  to?: string;

}

/**
 * Regression: `currency`, `from` and `to` used to be bare `@Query('x')`
 * strings. An unparseable `?from=garbage` became an `Invalid Date`, which
 * reached the aggregate query and surfaced as a 500 — a client mistake
 * reported as a server fault, which is both a lie to the caller and noise
 * in the error budget.
 */
export class PaymentStatsQueryDto {
  @ApiPropertyOptional({ example: 'USD', default: 'USD' })
  @IsOptional()
  @IsString()
  @IsCurrencyCode()
  currency?: string;

  @ApiPropertyOptional({ example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-02-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
