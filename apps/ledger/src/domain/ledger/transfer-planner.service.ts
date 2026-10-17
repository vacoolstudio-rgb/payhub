import { Injectable } from '@nestjs/common';
import { Money, type Result, ValidationError, err, ok } from '@payhub/kernel';
import { AccountRef } from './account-ref.vo.js';
import type { PostingLine } from './journal-entry.aggregate.js';

export interface DepositPlanInput {
  readonly userId: string;
  readonly amount: Money;
  readonly fee: Money;
  readonly provider: string;
}

export interface WithdrawalPlanInput {
  readonly userId: string;
  readonly amount: Money;
  readonly fee: Money;
  readonly provider: string;
}

export interface TransferPlanInput {
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly amount: Money;
  readonly fee: Money;
}

export interface RefundPlanInput {
  readonly userId: string;
  readonly amount: Money;
  readonly provider: string;
  /** Refund the fee too, or keep it (the usual commercial policy). */
  readonly refundFee: Money;
}

/**
 * Domain service that turns a business operation into balanced postings.
 *
 * This is the one place the chart of accounts is encoded. Keeping it out of
 * the aggregates means a change in fee policy touches one file, and keeping
 * it out of the application layer means the rules are unit-testable without
 * a database.
 */
@Injectable()
export class TransferPlanner {
  /**
   * Deposit: money arrives from the provider.
   *
   *   DR external:<provider>      (our claim on the PSP grows — an asset)
   *     CR user:<id>:available    (what we owe the user grows)
   *     CR house:fees             (our revenue grows)
   */
  planDeposit(input: DepositPlanInput): Result<PostingLine[], ValidationError> {
    const { amount, fee } = input;

    const currencyCheck = sameCurrency([amount, fee]);
    if (currencyCheck.isErr()) {
      return err(currencyCheck.error);
    }
    if (fee.greaterThanOrEqual(amount)) {
      return err(
        new ValidationError('Fee cannot swallow the whole deposit', {
          amount: amount.toJSON(),
          fee: fee.toJSON(),
        }, 'FEE_EXCEEDS_AMOUNT'),
      );
    }

    const currency = amount.currencyCode;
    const credited = amount.subtract(fee);

    const lines: PostingLine[] = [
      { account: AccountRef.external(input.provider, currency), direction: 'debit', amount },
      {
        account: AccountRef.userAvailable(input.userId, currency),
        direction: 'credit',
        amount: credited,
      },
    ];

    if (!fee.isZero()) {
      lines.push({ account: AccountRef.houseFees(currency), direction: 'credit', amount: fee });
    }

    return ok(lines);
  }

  /**
   * Withdrawal: money leaves towards the provider.
   *
   *   DR user:<id>:available      (we owe the user less)
   *     CR external:<provider>    (our claim on the PSP shrinks)
   *     CR house:fees
   */
  planWithdrawal(input: WithdrawalPlanInput): Result<PostingLine[], ValidationError> {
    const { amount, fee } = input;

    const currencyCheck = sameCurrency([amount, fee]);
    if (currencyCheck.isErr()) {
      return err(currencyCheck.error);
    }

    const currency = amount.currencyCode;
    const total = amount.add(fee);

    const lines: PostingLine[] = [
      {
        account: AccountRef.userAvailable(input.userId, currency),
        direction: 'debit',
        amount: total,
      },
      { account: AccountRef.external(input.provider, currency), direction: 'credit', amount },
    ];

    if (!fee.isZero()) {
      lines.push({ account: AccountRef.houseFees(currency), direction: 'credit', amount: fee });
    }

    return ok(lines);
  }

  /**
   * Internal transfer between two users. No external account is touched —
   * the platform's total liability only changes by the fee it keeps.
   */
  planTransfer(input: TransferPlanInput): Result<PostingLine[], ValidationError> {
    const { amount, fee } = input;

    if (input.fromUserId === input.toUserId) {
      return err(
        new ValidationError('Cannot transfer to the same user', {}, 'SELF_TRANSFER'),
      );
    }

    const currencyCheck = sameCurrency([amount, fee]);
    if (currencyCheck.isErr()) {
      return err(currencyCheck.error);
    }

    const currency = amount.currencyCode;
    const total = amount.add(fee);

    const lines: PostingLine[] = [
      {
        account: AccountRef.userAvailable(input.fromUserId, currency),
        direction: 'debit',
        amount: total,
      },
      {
        account: AccountRef.userAvailable(input.toUserId, currency),
        direction: 'credit',
        amount,
      },
    ];

    if (!fee.isZero()) {
      lines.push({ account: AccountRef.houseFees(currency), direction: 'credit', amount: fee });
    }

    return ok(lines);
  }

  /** Refund: the mirror image of a deposit, fee policy included. */
  planRefund(input: RefundPlanInput): Result<PostingLine[], ValidationError> {
    const currency = input.amount.currencyCode;
    const currencyCheck = sameCurrency([input.amount, input.refundFee]);
    if (currencyCheck.isErr()) {
      return err(currencyCheck.error);
    }

    const lines: PostingLine[] = [
      {
        account: AccountRef.userAvailable(input.userId, currency),
        direction: 'debit',
        amount: input.amount,
      },
      {
        account: AccountRef.external(input.provider, currency),
        direction: 'credit',
        amount: input.amount.add(input.refundFee),
      },
    ];

    if (!input.refundFee.isZero()) {
      lines.push({
        account: AccountRef.houseFees(currency),
        direction: 'debit',
        amount: input.refundFee,
      });
    }

    return ok(lines);
  }

  /**
   * Moves money between a user's available and pending buckets. Both sides
   * belong to the same user, so the platform's liability is unchanged.
   */
  planHold(userId: string, amount: Money): PostingLine[] {
    const currency = amount.currencyCode;
    return [
      { account: AccountRef.userAvailable(userId, currency), direction: 'debit', amount },
      { account: AccountRef.userPending(userId, currency), direction: 'credit', amount },
    ];
  }

  planRelease(userId: string, amount: Money): PostingLine[] {
    const currency = amount.currencyCode;
    return [
      { account: AccountRef.userPending(userId, currency), direction: 'debit', amount },
      { account: AccountRef.userAvailable(userId, currency), direction: 'credit', amount },
    ];
  }
}

function sameCurrency(amounts: readonly Money[]): Result<void, ValidationError> {
  const first = amounts[0];
  if (!first) {
    return ok(undefined);
  }
  const mismatch = amounts.find((amount) => amount.currencyCode !== first.currencyCode);

  return mismatch
    ? err(
        new ValidationError(
          `Mixed currencies in one operation: ${first.currencyCode} and ${mismatch.currencyCode}`,
          { expected: first.currencyCode, actual: mismatch.currencyCode },
          'CURRENCY_MISMATCH',
        ),
      )
    : ok(undefined);
}
