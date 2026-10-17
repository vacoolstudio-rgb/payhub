import { Money } from '@payhub/kernel';
import { AccountRef } from '../../../domain/ledger/account-ref.vo.js';
import {
  JournalEntry,
  type PostingLine,
  TransferId,
  type TransferPurpose,
} from '../../../domain/ledger/journal-entry.aggregate.js';
import { JournalEntryEntity } from '../entities/journal-entry.entity.js';
import { PostingEntity } from '../entities/posting.entity.js';

export const JournalEntryMapper = {
  toDomain(entity: JournalEntryEntity): JournalEntry {
    const lines = (entity.postings ?? []).map<PostingLine>((posting) => {
      const account = AccountRef.parse(posting.account);
      if (account.isErr()) {
        // Stored data that no longer parses is corruption, not user input.
        throw account.error;
      }
      return {
        account: account.value,
        direction: posting.direction,
        amount: Money.fromMinor(posting.amountMinor, posting.currency),
      };
    });

    return JournalEntry.rehydrate(
      TransferId.of(entity.id),
      {
        paymentId: entity.paymentId,
        userId: entity.userId,
        purpose: entity.purpose as TransferPurpose,
        description: entity.description,
        lines,
        postedAt: entity.postedAt,
        reversedBy: entity.reversedBy ? TransferId.of(entity.reversedBy) : null,
        reverses: entity.reverses ? TransferId.of(entity.reverses) : null,
      },
      0,
    );
  },

  toPersistence(entry: JournalEntry): JournalEntryEntity {
    const header = new JournalEntryEntity();
    header.id = entry.id;
    header.paymentId = entry.paymentId;
    header.userId = entry.userId;
    header.purpose = entry.purpose;
    header.description = entry.description;
    header.postedAt = entry.postedAt;
    header.reversedBy = entry.reversedBy;
    header.reverses = entry.reverses;

    header.postings = entry.lines.map((line) => {
      const posting = new PostingEntity();
      posting.entryId = entry.id;
      posting.account = line.account.toString();
      posting.accountKind = line.account.kind;
      posting.ownerId = line.account.ownerId;
      posting.currency = line.amount.currencyCode;
      posting.direction = line.direction;
      posting.amountMinor = line.amount.amount;
      posting.postedAt = entry.postedAt;
      posting.paymentId = entry.paymentId;
      return posting;
    });

    return header;
  },
};
