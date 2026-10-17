import {
  AggregateRoot,
  type Brand,
  DomainEvent,
  Money,
  type Result,
  ValidationError,
  err,
  ok,
  uuidBrand,
} from '@payhub/kernel';
import { AccountRef } from './account-ref.vo.js';
import { UnbalancedEntryError } from './ledger.errors.js';

export type TransferId = Brand<string, 'TransferId'>;
export const TransferId = uuidBrand<TransferId>('TransferId');

export const TransferPurpose = {
  Capture: 'capture',
  Refund: 'refund',
  Chargeback: 'chargeback',
  Adjustment: 'adjustment',
  Hold: 'hold',
  Release: 'release',
  Reversal: 'reversal',
} as const;

export type TransferPurpose = (typeof TransferPurpose)[keyof typeof TransferPurpose];

export type PostingDirection = 'debit' | 'credit';

export interface PostingLine {
  readonly account: AccountRef;
  readonly direction: PostingDirection;
  readonly amount: Money;
}

export interface JournalEntryProps {
  readonly paymentId: string | null;
  readonly userId: string | null;
  readonly purpose: TransferPurpose;
  readonly description: string;
  readonly lines: readonly PostingLine[];
  readonly postedAt: Date;
  readonly reversedBy: TransferId | null;
  readonly reverses: TransferId | null;
}

/**
 * A journal entry — the only way money moves in this system.
 *
 * Three invariants, enforced in the constructor so an unbalanced entry can
 * never exist, not even transiently:
 *
 *  1. **It balances.** Per currency, total debits equal total credits. This
 *     is what makes the ledger auditable: the sum of every account is always
 *     zero, so a missing or duplicated posting is detectable by arithmetic.
 *  2. **It is append-only.** There is no `update`. A mistake is corrected by
 *     posting a *reversal* entry, which keeps the audit trail intact — the
 *     same reason accountants use red ink instead of an eraser.
 *  3. **Every line is non-zero** and at least two lines exist, because a
 *     one-sided entry is by definition not double-entry.
 */
export class JournalEntry extends AggregateRoot<TransferId> {
  private constructor(
    id: TransferId,
    private props: JournalEntryProps,
  ) {
    super(id);
  }

  static create(input: {
    id: TransferId;
    paymentId?: string | null;
    userId?: string | null;
    purpose: TransferPurpose;
    description: string;
    lines: readonly PostingLine[];
    postedAt?: Date;
  }): Result<JournalEntry, ValidationError> {
    const validation = JournalEntry.validateLines(input.lines);
    if (validation.isErr()) {
      return err(validation.error);
    }

    const entry = new JournalEntry(input.id, {
      paymentId: input.paymentId ?? null,
      userId: input.userId ?? null,
      purpose: input.purpose,
      description: input.description,
      lines: [...input.lines],
      postedAt: input.postedAt ?? new Date(),
      reversedBy: null,
      reverses: null,
    });

    entry.raise(new JournalEntryPosted(entry));
    return ok(entry);
  }

  /** Rehydration from storage: no validation, no events. */
  static rehydrate(id: TransferId, props: JournalEntryProps, version: number): JournalEntry {
    const entry = new JournalEntry(id, props);
    entry.setVersion(version);
    return entry;
  }

  private static validateLines(
    lines: readonly PostingLine[],
  ): Result<void, ValidationError> {
    if (lines.length < 2) {
      return err(
        new ValidationError(
          'A journal entry needs at least two postings',
          { lines: lines.length },
          'UNBALANCED_ENTRY',
        ),
      );
    }

    if (lines.some((line) => line.amount.isZero())) {
      return err(
        new ValidationError('Postings must not be zero', {}, 'ZERO_POSTING'),
      );
    }

    if (lines.some((line) => line.amount.isNegative())) {
      return err(
        new ValidationError(
          'Postings carry a direction, not a sign — use debit/credit',
          {},
          'NEGATIVE_POSTING',
        ),
      );
    }

    // Currency must match between the posting and the account it hits,
    // otherwise a USD debit could "balance" a EUR credit.
    for (const line of lines) {
      if (line.account.currency !== line.amount.currencyCode) {
        return err(
          new ValidationError(
            `Posting currency ${line.amount.currencyCode} does not match account ${line.account.toString()}`,
            { account: line.account.toString(), currency: line.amount.currencyCode },
            'CURRENCY_MISMATCH',
          ),
        );
      }
    }

    const byCurrency = new Map<string, { debit: Money; credit: Money }>();

    for (const line of lines) {
      const currency = line.amount.currencyCode;
      const totals = byCurrency.get(currency) ?? {
        debit: Money.zero(currency),
        credit: Money.zero(currency),
      };

      if (line.direction === 'debit') {
        byCurrency.set(currency, { ...totals, debit: totals.debit.add(line.amount) });
      } else {
        byCurrency.set(currency, { ...totals, credit: totals.credit.add(line.amount) });
      }
    }

    for (const [currency, totals] of byCurrency) {
      if (totals.debit.compare(totals.credit) !== 0) {
        return err(
          new UnbalancedEntryError(
            currency,
            totals.debit.toMajorString(),
            totals.credit.toMajorString(),
          ),
        );
      }
    }

    return ok(undefined);
  }

  // --- behaviour ----------------------------------------------------------

  /**
   * Builds the compensating entry. Every line keeps its account and amount
   * and flips direction, so posting both leaves every balance untouched —
   * and both are visible in the statement, which is the point.
   */
  reverse(reversalId: TransferId, reason: string): Result<JournalEntry, ValidationError> {
    const flipped = this.props.lines.map<PostingLine>((line) => ({
      account: line.account,
      amount: line.amount,
      direction: line.direction === 'debit' ? 'credit' : 'debit',
    }));

    const reversal = JournalEntry.create({
      id: reversalId,
      paymentId: this.props.paymentId,
      userId: this.props.userId,
      purpose: TransferPurpose.Reversal,
      description: `Reversal of ${this.id}: ${reason}`,
      lines: flipped,
    });

    if (reversal.isErr()) {
      return reversal;
    }

    this.props = { ...this.props, reversedBy: reversalId };
    reversal.value.props = { ...reversal.value.props, reverses: this.id };

    return ok(reversal.value);
  }

  // --- accessors ----------------------------------------------------------

  get lines(): readonly PostingLine[] {
    return this.props.lines;
  }

  get purpose(): TransferPurpose {
    return this.props.purpose;
  }

  get paymentId(): string | null {
    return this.props.paymentId;
  }

  get userId(): string | null {
    return this.props.userId;
  }

  get description(): string {
    return this.props.description;
  }

  get postedAt(): Date {
    return this.props.postedAt;
  }

  get reversedBy(): TransferId | null {
    return this.props.reversedBy;
  }

  get reverses(): TransferId | null {
    return this.props.reverses;
  }

  get isReversed(): boolean {
    return this.props.reversedBy !== null;
  }

  /** Net effect on one account: positive means the balance goes up. */
  netFor(account: AccountRef): Money {
    const relevant = this.props.lines.filter((line) => line.account.equals(account));
    if (relevant.length === 0) {
      return Money.zero(account.currency);
    }

    return relevant.reduce((total, line) => {
      const increases = line.direction === account.normalBalance;
      return increases ? total.add(line.amount) : total.subtract(line.amount);
    }, Money.zero(account.currency));
  }
}

export class JournalEntryPosted extends DomainEvent {
  readonly eventName = 'ledger.journal_entry_posted.v1';
  readonly aggregateType = 'JournalEntry';

  constructor(private readonly entry: JournalEntry) {
    super();
  }

  get aggregateId(): string {
    return this.entry.id;
  }

  payload(): Record<string, unknown> {
    return {
      transferId: this.entry.id,
      paymentId: this.entry.paymentId,
      userId: this.entry.userId,
      purpose: this.entry.purpose,
      postedAt: this.entry.postedAt.toISOString(),
      lines: this.entry.lines.map((line) => ({
        account: line.account.toString(),
        direction: line.direction,
        amount: line.amount.toJSON(),
      })),
    };
  }
}
