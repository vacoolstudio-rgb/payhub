import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** OpenAPI model mirroring {@link ProblemDetails}. */
export class ProblemDetailsDto {
  @ApiProperty({ example: 'https://docs.payhub.dev/errors/insufficient-funds' })
  type!: string;

  @ApiProperty({ example: 'Insufficient funds' })
  title!: string;

  @ApiProperty({ example: 409 })
  status!: number;

  @ApiProperty({ example: 'Wallet balance 12.00 USD is below the requested 50.00 USD' })
  detail!: string;

  @ApiProperty({ example: 'INSUFFICIENT_FUNDS' })
  code!: string;

  @ApiPropertyOptional({ example: '/api/v1/payments' })
  instance?: string;

  @ApiPropertyOptional({ example: '0f6a0b1f-5e2a-4a36-9f7a-5a1c7a0a2b11' })
  correlationId?: string;

  @ApiProperty({ example: '2026-01-01T12:00:00.000Z' })
  timestamp!: string;

  @ApiPropertyOptional({ type: Object })
  errors?: Record<string, unknown>;
}
