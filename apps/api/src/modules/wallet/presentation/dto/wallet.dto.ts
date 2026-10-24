import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CursorPageQueryDto, IsCurrencyCode } from '@payhub/shared';

/**
 * Regression: these three parameters used to be bare `@Query('x') x?: string`.
 * The global `ValidationPipe` only inspects parameters that have a DTO
 * class, so nothing checked them: `?limit=abc` became `NaN`, `?limit=-5`
 * reached SQL as a negative `LIMIT`, and `?limit=999999` turned one
 * request into the caller's whole statement.
 */
export class StatementQueryDto extends CursorPageQueryDto {
  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @IsString()
  @IsCurrencyCode()
  currency?: string;
}

/**
 * Why a wallet is being frozen.
 *
 * Required, and not merely for tidiness: this is the control a payments
 * platform pulls under a fraud alert or a compliance hold, and the
 * event it raises is the audit trail. A freeze with no recorded reason
 * is one nobody can later justify or safely undo.
 */
export class SetWalletHoldDto {
  @ApiProperty({ example: 'Chargeback investigation CB-2291' })
  @IsString()
  @MinLength(8)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    example: 'USD',
    description: 'Omit to apply to every currency the user holds.',
  })
  @IsOptional()
  @IsCurrencyCode()
  currency?: string;
}
