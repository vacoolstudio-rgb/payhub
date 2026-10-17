import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
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
