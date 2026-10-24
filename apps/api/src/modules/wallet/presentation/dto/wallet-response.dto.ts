import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MoneyResponseDto } from '../../../payment/presentation/http/dto/payment-response.dto.js';
import type {
  StatementEntryView,
  WalletBalanceView,
} from '../../application/wallet-read.service.js';

/**
 * Response shapes for the wallet endpoints.
 *
 * Declared as classes for the same reason as the payment ones: the read
 * model is a TypeScript interface, which leaves no trace at runtime for
 * OpenAPI to describe. See `payment-response.dto.ts` for why the
 * duplication lives at the transport edge rather than in the view, and
 * why `implements` is what keeps the two from drifting apart.
 */
export class BalanceAmountDto {
  @ApiProperty({ example: '12050', description: 'Minor units as a decimal string' })
  minor!: string;

  @ApiProperty({ example: '120.50' })
  major!: string;
}

export class WalletBalanceResponseDto implements WalletBalanceView {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ type: BalanceAmountDto, description: 'Spendable right now' })
  available!: BalanceAmountDto;

  @ApiProperty({ type: BalanceAmountDto, description: 'Held against a payment in flight' })
  pending!: BalanceAmountDto;

  @ApiProperty({ type: BalanceAmountDto, description: 'Available plus pending' })
  total!: BalanceAmountDto;

  @ApiProperty({ enum: ['active', 'frozen', 'closed'] })
  status!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class StatementEntryResponseDto implements StatementEntryView {
  @ApiProperty({ format: 'uuid', description: 'The ledger transfer this line belongs to' })
  transferId!: string;

  @ApiProperty({ example: 'capture' })
  purpose!: string;

  @ApiProperty({ example: 'deposit order-10294' })
  description!: string;

  @ApiProperty({ enum: ['debit', 'credit'] })
  direction!: string;

  @ApiProperty({ type: MoneyResponseDto })
  amount!: MoneyResponseDto;

  @ApiProperty({ format: 'date-time' })
  postedAt!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  paymentId!: string | null;
}

export class StatementPageDto {
  @ApiProperty({ type: [StatementEntryResponseDto] })
  items!: StatementEntryResponseDto[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'Pass as `cursor` for the next page; null on the last one',
  })
  nextCursor!: string | null;

  @ApiProperty()
  hasMore!: boolean;
}

/**
 * What a freeze request answers with.
 *
 * `commandId` rather than a wallet state: the command is durable when
 * this returns and applied a moment later, so reporting a status here
 * would be reporting one this response cannot know.
 */
export class WalletHoldAcceptedDto {
  @ApiProperty({ format: 'uuid', description: 'The durable command; use it to correlate logs' })
  commandId!: string;

  @ApiProperty({ example: true })
  accepted!: boolean;
}
