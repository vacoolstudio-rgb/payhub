import { z } from 'zod';
import { defineEvent, moneySchema } from './envelope.js';
import { Topics } from './topics.js';

/**
 * Commands the payment saga orchestrator sends to the ledger service.
 *
 * Commands are imperative and addressed to exactly one service; events are
 * facts broadcast to anyone who cares. Mixing them up is how choreographed
 * systems become unreadable.
 */

export const LedgerPostingLine = z.object({
  /** Account path, e.g. `user:<uuid>:available` or `house:fees`. */
  account: z.string().min(1),
  direction: z.enum(['debit', 'credit']),
  amount: moneySchema,
});
export type LedgerPostingLine = z.infer<typeof LedgerPostingLine>;

export const LedgerOperation = z.enum(['deposit', 'withdrawal', 'transfer', 'refund']);
export type LedgerOperation = z.infer<typeof LedgerOperation>;

/**
 * Semantic command, not a list of postings.
 *
 * The payments context says *what happened in business terms*; the ledger
 * owns the chart of accounts and decides which accounts to debit and credit.
 * Shipping the postings across the boundary would duplicate accounting rules
 * in two services and guarantee they drift.
 */
export const PostTransferCommand = defineEvent(
  'ledger.post_transfer.v1',
  Topics.LedgerCommands,
  z.object({
    /** Idempotency key for the ledger: one journal entry per transferId. */
    transferId: z.string().uuid(),
    paymentId: z.string().uuid(),
    userId: z.string().uuid(),
    counterpartyUserId: z.string().uuid().nullable().default(null),
    merchantId: z.string().uuid(),
    operation: LedgerOperation,
    amount: moneySchema,
    fee: moneySchema,
    provider: z.string().min(1),
    description: z.string().min(1),
    requestedAt: z.string().datetime({ offset: true }),
  }),
);

export const ReverseTransferCommand = defineEvent(
  'ledger.reverse_transfer.v1',
  Topics.LedgerCommands,
  z.object({
    transferId: z.string().uuid(),
    reversalId: z.string().uuid(),
    paymentId: z.string().uuid(),
    reason: z.string().min(1),
    requestedAt: z.string().datetime({ offset: true }),
  }),
);

export const LedgerCommands = {
  [PostTransferCommand.name]: PostTransferCommand,
  [ReverseTransferCommand.name]: ReverseTransferCommand,
} as const;

// --- facts ----------------------------------------------------------------

export const LedgerRejectionReason = z.enum([
  'insufficient_funds',
  'wallet_frozen',
  'wallet_not_found',
  'currency_mismatch',
  'unbalanced_entry',
  'limit_exceeded',
]);
export type LedgerRejectionReason = z.infer<typeof LedgerRejectionReason>;

export const TransferPosted = defineEvent(
  'ledger.transfer_posted.v1',
  Topics.LedgerEvents,
  z.object({
    transferId: z.string().uuid(),
    paymentId: z.string().uuid(),
    userId: z.string().uuid(),
    purpose: z.string().min(1),
    lines: z.array(LedgerPostingLine),
    postedAt: z.string().datetime({ offset: true }),
  }),
);

export const TransferRejected = defineEvent(
  'ledger.transfer_rejected.v1',
  Topics.LedgerEvents,
  z.object({
    transferId: z.string().uuid(),
    paymentId: z.string().uuid(),
    userId: z.string().uuid(),
    reason: LedgerRejectionReason,
    detail: z.string().nullable().default(null),
    rejectedAt: z.string().datetime({ offset: true }),
  }),
);

export const WalletBalanceChanged = defineEvent(
  'ledger.wallet_balance_changed.v1',
  Topics.LedgerEvents,
  z.object({
    walletId: z.string().uuid(),
    userId: z.string().uuid(),
    available: moneySchema,
    pending: moneySchema,
    version: z.number().int().nonnegative(),
    changedAt: z.string().datetime({ offset: true }),
  }),
);

export const LedgerEvents = {
  [TransferPosted.name]: TransferPosted,
  [TransferRejected.name]: TransferRejected,
  [WalletBalanceChanged.name]: WalletBalanceChanged,
} as const;
