import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/**
 * The upper bound on any single page, in one place.
 *
 * A page size is not a preference, it is a resource limit: without it one
 * request can ask for the caller's entire history and decide how much
 * memory the process uses. Defining it per endpoint is how the three
 * copies of this rule drifted into "100", "200" and "no bound at all".
 */
export const MAX_PAGE_SIZE = 100;

/**
 * Keyset pagination parameters.
 *
 * `enableImplicitConversion` is deliberately off globally — implicit
 * coercion turns `?limit=abc` into `NaN` and `?flag=0` into `false`
 * somewhere deep in a handler — so every numeric query parameter has to
 * ask for conversion explicitly with `@Type`. That is the whole reason
 * this base class exists rather than three hand-written copies.
 */
export class CursorPageQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque keyset cursor from the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

/**
 * An ISO 4217-shaped currency code.
 *
 * Three or four uppercase letters — four because minor crypto units and
 * test currencies exist. Checking the shape here keeps a lowercase `usd`
 * from reaching a `Currency` value object that would reject it with a 500
 * instead of a 400.
 */
export const IsCurrencyCode = () =>
  Matches(/^[A-Z]{3,4}$/, {
    message: 'currency must be 3-4 uppercase letters, e.g. USD',
  });
