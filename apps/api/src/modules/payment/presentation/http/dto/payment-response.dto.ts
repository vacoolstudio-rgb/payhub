import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentDirection, PaymentStatus } from '../../../domain/payment.aggregate.js';
import type { MoneyView, PaymentView } from '../../../application/payment.view.js';

/**
 * Response shapes, declared as classes so OpenAPI can see them.
 *
 * The handlers return `PaymentView` and friends, which are TypeScript
 * interfaces: they do not exist at runtime, so nothing — not even the
 * Nest Swagger plugin — can read a shape off them. The published
 * document therefore described every way each endpoint could *fail*,
 * thoroughly, and never once what it returns when it works. An
 * integrator could generate a client that knows about 409 and 422 and
 * has no type for a payment.
 *
 * These are a parallel declaration of the same shape, which is a real
 * cost: change the view and this has to follow. The alternative — making
 * the views classes and decorating them — drags Swagger decorators into
 * the application layer, where a transport concern does not belong. The
 * duplication stays at the edge instead.
 *
 * `implements` is what stops it rotting. A field added to the view and
 * forgotten here is a compile error, not a document that quietly
 * describes last month's response.
 */
export class MoneyResponseDto implements MoneyView {
  @ApiProperty({ example: '4200', description: 'Minor units as a decimal string' })
  minor!: string;

  @ApiProperty({ example: '42.00', description: 'Major units, formatted for display' })
  major!: string;

  @ApiProperty({ example: 'USD' })
  currency!: string;
}

export class PaymentResponseDto implements PaymentView {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  merchantId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ format: 'uuid', nullable: true, description: 'Set only on an internal transfer' })
  counterpartyUserId!: string | null;

  @ApiProperty({ enum: PaymentDirection })
  direction!: string;

  @ApiProperty({ enum: PaymentStatus })
  status!: string;

  @ApiProperty({ type: MoneyResponseDto })
  amount!: MoneyResponseDto;

  @ApiProperty({ type: MoneyResponseDto })
  fee!: MoneyResponseDto;

  @ApiProperty({ type: MoneyResponseDto, description: 'Amount minus fee' })
  netAmount!: MoneyResponseDto;

  @ApiProperty({ type: MoneyResponseDto })
  refundedAmount!: MoneyResponseDto;

  @ApiProperty({ example: 'card' })
  method!: string;

  @ApiProperty({ example: 'order-10294' })
  reference!: string;

  @ApiProperty({ nullable: true, description: "The provider's own identifier" })
  providerReference!: string | null;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'The ledger transfer this payment was posted under',
  })
  transferId!: string | null;

  @ApiProperty({ nullable: true, example: 'insufficient_funds' })
  failureReason!: string | null;

  @ApiProperty({ nullable: true })
  failureDetail!: string | null;

  @ApiProperty({ type: Object, example: { orderId: '10294' } })
  metadata!: Record<string, string>;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  capturedAt!: string | null;

  @ApiProperty({ format: 'date-time', description: 'When an unsettled payment is swept' })
  expiresAt!: string;
}

export class PaymentPageDto {
  @ApiProperty({ type: [PaymentResponseDto] })
  items!: PaymentResponseDto[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'Pass as `cursor` for the next page; null on the last one',
  })
  nextCursor!: string | null;

  @ApiProperty()
  hasMore!: boolean;
}

export class PaymentStatsResponseDto {
  @ApiProperty({ example: 128 })
  totalCount!: number;

  @ApiProperty({ example: 120 })
  capturedCount!: number;

  @ApiProperty({ example: 8 })
  failedCount!: number;

  @ApiProperty({ example: '1420000', description: 'Captured volume in minor units' })
  volumeMinor!: string;

  @ApiProperty({ example: '41180', description: 'Fees charged in minor units' })
  feeMinor!: string;

  @ApiProperty({ example: 'USD' })
  currency!: string;
}
