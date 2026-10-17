import type { CursorPage, CursorQuery } from '@payhub/kernel';
import type { JournalEntry, TransferId } from './journal-entry.aggregate.js';

export const JOURNAL_REPOSITORY = Symbol.for('payhub:JournalEntryRepository');

export interface StatementFilter extends CursorQuery {
  readonly userId: string;
  readonly currency?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly purpose?: string | undefined;
}

export interface StatementRow {
  readonly transferId: string;
  readonly purpose: string;
  readonly description: string;
  readonly account: string;
  readonly direction: 'debit' | 'credit';
  readonly amountMinor: string;
  readonly currency: string;
  readonly postedAt: Date;
  readonly paymentId: string | null;
}

export interface JournalEntryRepository {
  findById(id: TransferId): Promise<JournalEntry | null>;
  exists(id: TransferId): Promise<boolean>;

  /** Append-only insert; the unique id is the idempotency guard. */
  append(entry: JournalEntry): Promise<void>;

  markReversed(id: TransferId, reversalId: TransferId): Promise<void>;

  statement(filter: StatementFilter): Promise<CursorPage<StatementRow>>;

  /** Totals per account for the reconciliation job. */
  trialBalance(currency: string, asOf: Date): Promise<Array<{ account: string; balanceMinor: string }>>;
}
